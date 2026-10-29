// AV2: the Look on the Apple picture, on the GPU (Metal), from the one source of numbers and maths.
// Built into both faces of the Apple player (build/tools/apple-player and apple-player.node) by
// scripts/build-apple-player.sh, beside pipeline/apple-composition.swift.
//
// Why Metal and not Core Image: the Chrome viewer's grade is GLSL emitted from the same scalar TypeScript the export
// evaluates. src/main/apple-shader.ts translates that very text to Metal Shading Language and puts it in the plan,
// so the maths exists once and both players compile it. Core Image's kernel language has no arrays or 3D textures,
// so it would need a hand written port (a second copy that drifts), and its half float intermediates and linear
// table sampling differ from the viewer's tetrahedral reads. Metal runs the viewer's own tetrahedral tableAt, its
// stagedGrade lattice (baked once per change, 33^3 points, instead of four evaluations per pixel), its 8 bit
// composed picture and 16 bit detail pyramid, then grain and vignette, in float32 with safe maths.
//
// A Look change replaces only the numbers: the lattice is baked again off the main thread and swapped in under a
// lock, so a frame never mixes an old and a new Look and the player item, its pictures and its sound are untouched.
import Foundation
import AVFoundation
import CoreVideo
import CoreImage
import Metal
import MetalKit

// MARK: plan

/// One piece's Look as numbers from the one source (main: liveGrade, liveLut, lookParameters).
struct SegmentLook: Decodable {
    let mode: String; let lutFile: String; let lutSize: Int
    let params: [Double]?; let basic: [Double]?; let mixer: [Double]?
    let exposure: [Double]?; let diffusion: Double?
}
struct GrainPlan: Decodable { let preset: String?; let amount: Double; let size: Double; let roughness: Double; let colour: Double; let shadows: Double; let highlights: Double }
struct VignettePlan: Decodable { let amount: Double; let midpoint: Double; let feather: Double }
struct DetailPlan: Decodable { let amount: Double; let radius: Double; let detail: Double; let masking: Double; let texture: Double; let clarity: Double; let diffusion: Double }
struct FinishPlan: Decodable { let grain: GrainPlan?; let vignette: VignettePlan?; let detail: DetailPlan?; let scoped: Bool? }
struct ShaderPlan: Decodable { let source: String; let hash: String; let detailSteps: [Int]? }
struct SoundPlan: Decodable { let eq: [Double]; let auto: Bool; let outDb: Double? }

/// Events from the Look (for the addon's emitter; the command line helper prints nothing).
var appleLookEvent: (([String: Any]) -> Void)? = nil

// MARK: GPU

final class AppleGPU {
    static let shared = AppleGPU()
    let device: MTLDevice?
    let queue: MTLCommandQueue?
    /// Look bakes run on their own queue, never behind the pictures AVPlayer composes ahead.
    let bakeQueue: MTLCommandQueue?
    var cache: CVMetalTextureCache?
    private let lock = NSLock()
    private var pipelines: [String: MTLComputePipelineState] = [:]
    private(set) var shaderHash = ""
    private(set) var compileError: String?
    var detailSteps: [Int] = [1, 2, 4, 8]

    init() {
        device = MTLCreateSystemDefaultDevice()
        queue = device?.makeCommandQueue()
        bakeQueue = device?.makeCommandQueue()
        if let device { CVMetalTextureCacheCreate(nil, nil, device, nil, &cache) }
    }

    /// Compile the plan's shader once per distinct source (about 0.3 s, off the main thread by the caller).
    func prepare(_ shader: ShaderPlan) -> Bool {
        lock.lock(); defer { lock.unlock() }
        if let steps = shader.detailSteps, steps.count == 4 { detailSteps = steps }
        if shaderHash == shader.hash && !pipelines.isEmpty { return true }
        guard let device else { compileError = "no Metal device"; return false }
        let options = MTLCompileOptions()
        // The viewer's WebGL is IEEE float; fast maths would bend pow and the hue maths.
        if #available(macOS 15.0, *) { options.mathMode = .safe } else { options.fastMathEnabled = false }
        do {
            let library = try device.makeLibrary(source: shader.source, options: options)
            var made: [String: MTLComputePipelineState] = [:]
            for name in ["appleBake", "applePicture", "appleDetailSeed", "appleDetailBlur", "appleDetail", "appleCopy", "appleFinish", "applePlate",
                         "appleLayer", "appleBackdrop", "appleGroup", "appleClear", "appleFrameTile"] {
                guard let fn = library.makeFunction(name: name) else { throw CompositionError.message("shader has no \(name)") }
                made[name] = try device.makeComputePipelineState(function: fn)
            }
            pipelines = made; shaderHash = shader.hash; compileError = nil
            return true
        } catch {
            compileError = String(describing: error)
            FileHandle.standardError.write(Data("apple-player: Look shader failed: \(error)\n".utf8))
            return false
        }
    }
    func pipeline(_ name: String) -> MTLComputePipelineState? { lock.lock(); defer { lock.unlock() }; return pipelines[name] }

    func dispatch(_ encoder: MTLComputeCommandEncoder, _ pipeline: MTLComputePipelineState, width: Int, height: Int, depth: Int = 1) {
        encoder.setComputePipelineState(pipeline)
        let w = pipeline.threadExecutionWidth, h = max(1, pipeline.maxTotalThreadsPerThreadgroup / w)
        let group = depth > 1 ? MTLSize(width: 8, height: 8, depth: 4) : MTLSize(width: w, height: h, depth: 1)
        let groups = MTLSize(width: (width + group.width - 1) / group.width, height: (height + group.height - 1) / group.height, depth: (depth + group.depth - 1) / group.depth)
        encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: group)
    }

    /// A colour table (raw float32 RGB, red fastest) as a 3D texture, read with texel reads like the viewer's.
    func table(file: String, size: Int) -> MTLTexture? {
        guard let device, size >= 2, let raw = try? Data(contentsOf: URL(fileURLWithPath: file)), raw.count == size * size * size * 3 * 4 else { return nil }
        var rgba = [Float](repeating: 1, count: size * size * size * 4)
        raw.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            let from = src.bindMemory(to: Float.self)
            for i in 0..<(size * size * size) { rgba[i * 4] = from[i * 3]; rgba[i * 4 + 1] = from[i * 3 + 1]; rgba[i * 4 + 2] = from[i * 3 + 2] }
        }
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = .rgba32Float; d.width = size; d.height = size; d.depth = size
        d.usage = [.shaderRead]; d.storageMode = .shared
        guard let staging = device.makeTexture(descriptor: d) else { return nil }
        rgba.withUnsafeBytes { bytes in
            staging.replace(region: MTLRegionMake3D(0, 0, 0, size, size, size), mipmapLevel: 0, slice: 0, withBytes: bytes.baseAddress!, bytesPerRow: size * 16, bytesPerImage: size * size * 16)
        }
        // Copied to GPU memory now, as the plan loads: a table first read mid play cost the picture a refresh.
        d.storageMode = .private
        guard let texture = device.makeTexture(descriptor: d), let queue = bakeQueue, let buffer = queue.makeCommandBuffer(), let blit = buffer.makeBlitCommandEncoder() else { return staging }
        blit.copy(from: staging, to: texture)
        blit.endEncoding(); buffer.commit(); buffer.waitUntilCompleted()
        return buffer.status == .completed ? texture : staging
    }

    /// Bake many lattices in one command buffer and wait (each is 33^3 evaluations of the shared gradeVertex).
    func bake(_ jobs: [(numbers: [Float], into: MTLTexture)]) -> Bool {
        guard !jobs.isEmpty else { return true }
        guard let device, let queue = bakeQueue, let pipeline = pipeline("appleBake"), let buffer = queue.makeCommandBuffer(), let encoder = buffer.makeComputeCommandEncoder() else { return false }
        for job in jobs {
            guard let numbers = device.makeBuffer(bytes: job.numbers, length: job.numbers.count * 4, options: .storageModeShared) else { continue }
            encoder.setTexture(job.into, index: 0); encoder.setBuffer(numbers, offset: 0, index: 0)
            dispatch(encoder, pipeline, width: job.into.width, height: job.into.height, depth: job.into.depth)
        }
        encoder.endEncoding(); buffer.commit(); buffer.waitUntilCompleted()
        return buffer.status == .completed
    }
    /// AV4: a layout background image, read once (its pixels as stored: the viewer uploads the image as is).
    private var images: [String: MTLTexture] = [:]
    func image(_ file: String) -> MTLTexture? {
        lock.lock(); if let known = images[file] { lock.unlock(); return known }; lock.unlock()
        guard let device else { return nil }
        let loader = MTKTextureLoader(device: device)
        let made = try? loader.newTexture(URL: URL(fileURLWithPath: file), options: [.SRGB: false, .origin: MTKTextureLoader.Origin.topLeft, .textureUsage: NSNumber(value: MTLTextureUsage.shaderRead.rawValue), .textureStorageMode: NSNumber(value: MTLStorageMode.private.rawValue)])
        lock.lock(); if let made { images[file] = made; if images.count > 16 { images = [file: made] } }; lock.unlock()
        return made
    }
    func lattice() -> MTLTexture? {
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = .rgba32Float; d.width = 33; d.height = 33; d.depth = 33
        d.usage = [.shaderRead, .shaderWrite]; d.storageMode = .private
        return device?.makeTexture(descriptor: d)
    }
    func texture2D(_ format: MTLPixelFormat, _ width: Int, _ height: Int) -> MTLTexture? {
        let d = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: format, width: width, height: height, mipmapped: false)
        d.usage = [.shaderRead, .shaderWrite]; d.storageMode = .private
        return device?.makeTexture(descriptor: d)
    }
    /// Let the texture cache release the picture buffers it no longer needs. Without this it keeps them, and AVPlayer's
    /// decoder runs out of buffers about a second into a play (measured: 25 pictures, then none).
    func flush() { if let cache { CVMetalTextureCacheFlush(cache, 0) } }
    func wrap(_ buffer: CVPixelBuffer) -> (CVMetalTexture, MTLTexture)? {
        guard let cache else { return nil }
        var made: CVMetalTexture?
        let usage = [kCVMetalTextureUsage as String: NSNumber(value: MTLTextureUsage([.shaderRead, .shaderWrite]).rawValue)] as CFDictionary
        guard CVMetalTextureCacheCreateTextureFromImage(nil, cache, buffer, usage, .bgra8Unorm, CVPixelBufferGetWidth(buffer), CVPixelBufferGetHeight(buffer), 0, &made) == kCVReturnSuccess,
              let made, let texture = CVMetalTextureGetTexture(made) else { return nil }
        return (made, texture)
    }
}

/// The 56 numbers of one live grade in the shader's LookNumbers layout: look[18], basics[10], mixer[24], gain (float4).
func lookNumbers(params: [Double], basic: [Double], mixer: [Double], exposure: [Double]) -> [Float] {
    func fit(_ v: [Double], _ n: Int, _ fill: Double = 0) -> [Float] { (0..<n).map { Float($0 < v.count ? v[$0] : fill) } }
    return fit(params, 18) + fit(basic, 10) + fit(mixer, 24) + fit(exposure, 3, 1) + [0]
}

// MARK: Look state

/// One picture segment's colour on the GPU. mode 0: none; 1: the piece's whole table; 2: base table then live lattice;
/// -1: pending (its tables are on their way; never drawn without them).
struct SegmentColour {
    var mode = 0
    var table: MTLTexture?
    var tableSize = 0
    var lattice: MTLTexture?
    var numbersKey = ""
    var diffusion: Double?
    /// AV3: the piece's clip transform, as the viewer's shader takes it (affine x y z w, crop l t r b, flip h v, aspect),
    /// from src/shared/apple-playback.ts appleTransformNumbers. Nil: no transform.
    var transform: [Float]? = nil
}

/// AV3: a plan's Look being readied while another plan is on screen (an edit while playing or paused). Its segments
/// bake on the Look's queue like a load's; the presenter swaps it in with the new plan's first picture.
struct StagedLook {
    let id: Int
    let spans: [(start: Double, end: Double, layer: Int)]
    /// AV4: where its pictures sit (the compositor builds the same one from the same plan).
    let layout: PictureLayout
    var segments: [SegmentColour]
    var grain: GrainPlan?; var vignette: VignettePlan?; var detail: DetailPlan?; var scoped: Bool; let fps: Double
    var ready = false
    var failed: String? = nil
}

/// Lock protected Look for the compositor. AVFoundation makes the compositor, so the host publishes here.
final class AppleLookState {
    static let shared = AppleLookState()
    let lock = NSCondition()
    let work = DispatchQueue(label: "com.sidething.precut.apple-look", qos: .userInteractive)
    private(set) var spans: [(start: Double, end: Double, layer: Int)] = []
    /// AV4: the plan on screen's layout (its spans and tiles), swapped with its colours in one step.
    private(set) var layout: PictureLayout?
    private(set) var segments: [SegmentColour] = []
    private(set) var grain: GrainPlan?; private(set) var vignette: VignettePlan?; private(set) var detail: DetailPlan?
    private(set) var scoped = false
    /// Look off (the viewer's Shift+D): the plain picture, no table, no finish.
    private(set) var bypass = false
    private(set) var fps = 25.0
    /// Raised by every Look change; each composed picture carries the one it was drawn with (QA reads it on display).
    private(set) var generation = 0
    /// The load the compositor may draw: pictures wait for their Look rather than show without it.
    private var readyLoad = 0
    private var wantedLoad = 0
    private(set) var failed: String?
    private var tables: [String: MTLTexture] = [:]
    private var lattices: [String: MTLTexture] = [:]
    var lastBakeMs = 0.0
    /// Look changes waiting on the work queue (a newer one makes an older one skip its second swap).
    private var queuedUpdates = 0
    /// How long the whole of the last change took to bake (every piece).
    var restMs = 0.0
    /// The picture time on screen (the presenter's last), so its piece's new Look bakes first.
    private var focus = 0.0
    /// AV3: the plan on screen, by number (a load or a committed swap raises it), so a Look change read against one
    /// plan never lands on another.
    private var planId = 0
    private(set) var staged: StagedLook?
    private var stageCounter = 0
    private var committedStage = -1, committedPlan = -1

    private func numbersKey(_ n: [Float]) -> String { n.map { String($0.bitPattern, radix: 16) }.joined(separator: ",") }

    /// Build every segment's colour from the plan: compile the shader (once), read tables, bake lattices.
    /// Runs on the work queue; the compositor waits for it (never a picture without its Look).
    func load(manifest: Manifest) {
        lock.lock()
        wantedLoad += 1
        let load = wantedLoad
        spans = manifest.video.map { ($0.timelineStart, $0.timelineEnd, $0.layer ?? 0) }
        layout = PictureLayout(manifest)
        fps = manifest.fps > 0 ? manifest.fps : 25
        grain = manifest.finish?.grain; vignette = manifest.finish?.vignette; detail = manifest.finish?.detail
        scoped = manifest.finish?.scoped ?? false
        segments = manifest.video.map { _ in SegmentColour() }
        bypass = false
        planId += 1
        staged = nil
        lock.unlock()
        let asked = CACurrentMediaTime()
        work.async { [weak self] in
            guard let self else { return }
            let begun = CACurrentMediaTime()
            let (built, problem) = self.build(manifest)
            self.lock.lock()
            if load == self.wantedLoad {
                self.segments = problem == nil ? built : manifest.video.map { _ in SegmentColour() }
                self.failed = problem
                self.generation += 1
                self.readyLoad = load
            }
            self.lock.broadcast()
            self.lock.unlock()
            if let problem { appleLookEvent?(["type": "lookFailed", "message": problem]) }
            else { appleLookEvent?(["type": "lookReady", "ms": ((CACurrentMediaTime() - asked) * 10000).rounded() / 10, "queuedMs": ((begun - asked) * 10000).rounded() / 10, "bakeMs": (self.lastBakeMs * 10).rounded() / 10, "tables": self.tables.count]) }
        }
    }

    /// AV3: ready a new plan's Look beside the one on screen (same tables and lattices, read and baked once). `done`
    /// runs on the Look's queue with whether it is ready. Returns the staged plan's number for commitStaged.
    @discardableResult
    func stage(manifest: Manifest, done: @escaping (Bool, String?) -> Void) -> Int {
        lock.lock()
        stageCounter += 1
        let id = stageCounter
        let finish = manifest.finish
        staged = StagedLook(id: id, spans: manifest.video.map { ($0.timelineStart, $0.timelineEnd, $0.layer ?? 0) }, layout: PictureLayout(manifest), segments: manifest.video.map { _ in SegmentColour() },
                            grain: finish?.grain, vignette: finish?.vignette, detail: finish?.detail, scoped: finish?.scoped ?? false, fps: manifest.fps > 0 ? manifest.fps : 25)
        lock.unlock()
        work.async { [weak self] in
            guard let self else { return }
            let (built, problem) = self.build(manifest)
            self.lock.lock()
            let current = self.staged?.id == id
            if current { self.staged?.segments = built; self.staged?.ready = problem == nil; self.staged?.failed = problem }
            self.lock.unlock()
            done(current && problem == nil, current ? problem : "replaced by a newer plan")
        }
        return id
    }
    /// AV3: the presenter shows the new plan's first picture: its Look becomes the one on screen, in one step under
    /// the lock, so no picture is ever drawn with one plan's spans and another's colours. False if not ready.
    func commitStaged(_ id: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        guard let next = staged, next.id == id, next.ready, next.failed == nil else { return false }
        spans = next.spans; segments = next.segments; layout = next.layout
        grain = next.grain; vignette = next.vignette; detail = next.detail; scoped = next.scoped; fps = next.fps
        planId += 1; generation += 1; staged = nil
        committedStage = id; committedPlan = planId
        return true
    }
    func dropStaged(_ id: Int? = nil) { lock.lock(); if id == nil || staged?.id == id { staged = nil }; lock.unlock() }
    func stagedReady(_ id: Int) -> Bool { lock.lock(); defer { lock.unlock() }; return staged?.id == id && staged?.ready == true }

    /// Every segment's colour for a plan: compile the shader (once), read tables, bake lattices. On the Look's queue.
    private func build(_ manifest: Manifest) -> ([SegmentColour], String?) {
            let gpu = AppleGPU.shared
            var problem: String? = nil
            // The finish (detail, grain, vignette) runs on the GPU too, with or without a piece's Look.
            if let shader = manifest.shader { if !gpu.prepare(shader) { problem = gpu.compileError ?? "Look shader failed" } }
            else if manifest.video.contains(where: { $0.look != nil }) || manifest.finish != nil { problem = "plan has no Look shader" }
            var built: [SegmentColour] = []
            var jobs: [(numbers: [Float], into: MTLTexture)] = []
            var made: [String: MTLTexture] = [:]
            for seg in manifest.video {
                var colour = SegmentColour()
                colour.transform = seg.transform.map { $0.map { Float($0) } }
                guard problem == nil, let look = seg.look else { built.append(colour); continue }
                colour.diffusion = look.diffusion
                // Its tables are still being read in main: the player holds its picture there until they arrive.
                if look.mode == "pending" { colour.mode = -1; built.append(colour); continue }
                if let table = self.tables[look.lutFile] ?? gpu.table(file: look.lutFile, size: look.lutSize) {
                    self.tables[look.lutFile] = table
                    colour.table = table; colour.tableSize = look.lutSize
                    if look.mode == "uniform" {
                        let numbers = lookNumbers(params: look.params ?? [], basic: look.basic ?? [], mixer: look.mixer ?? [], exposure: look.exposure ?? [1, 1, 1])
                        let key = self.numbersKey(numbers)
                        if let lattice = self.lattices[key] ?? made[key] { colour.lattice = lattice }
                        else if let lattice = gpu.lattice() { made[key] = lattice; jobs.append((numbers, lattice)); colour.lattice = lattice }
                        colour.numbersKey = key; colour.mode = colour.lattice == nil ? 0 : 2
                    } else { colour.mode = 1 }
                } else { problem = problem ?? "cannot read a colour table" }
                built.append(colour)
            }
            let started = CACurrentMediaTime()
            if problem == nil && !gpu.bake(jobs) { problem = "Look bake failed" }
            self.lastBakeMs = (CACurrentMediaTime() - started) * 1000
            for (key, lattice) in made { self.lattices[key] = lattice }
            // A table or lattice still named by the plan on screen (or the staged one) is never dropped from under it.
            if self.tables.count > 96 { self.tables = self.tables.filter { entry in built.contains { $0.table === entry.value } } }
            if self.lattices.count > 256 { self.lattices = made }
            return (built, problem)
    }

    /// Compile the shader ahead of the plan (on the Look's queue, so a load right after waits for it, never twice).
    func warm(_ shader: ShaderPlan) { work.async { _ = AppleGPU.shared.prepare(shader) } }

    /// A live Look change: new numbers (and, for a new Look, new tables) for the same spans. Returns at once; the
    /// lattices bake off the main thread, then swap in together, and `done` runs on the main thread.
    func update(json: String, done: @escaping (Int, Double) -> Void, swapped: ((Int) -> Void)? = nil) -> Bool {
        guard let data = json.data(using: .utf8), let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        let asked = CACurrentMediaTime()
        lock.lock(); queuedUpdates += 1; lock.unlock()
        work.async { [weak self] in
            guard let self else { return }
            let gpu = AppleGPU.shared
            self.lock.lock()
            self.queuedUpdates -= 1
            var next = self.segments
            let spans = self.spans
            let planNow = self.planId
            // AV3: a plan staged beside it (an edit landing) takes the same change, matched by its own spans.
            var nextStaged = self.staged?.ready == true ? self.staged : nil
            self.lock.unlock()
            func numbers(_ entry: [String: Any], _ key: String) -> [Double] { (entry[key] as? [NSNumber])?.map { $0.doubleValue } ?? [] }
            var jobs: [(numbers: [Float], into: MTLTexture)] = []
            var made: [String: MTLTexture] = [:]
            // The piece on screen bakes first and shows at once; the rest follow in a second swap.
            let focusIndex = spans.firstIndex { self.focus >= $0.start - 0.002 && self.focus < $0.end - 0.002 }
            var focusKey: String? = nil
            /// One entry's change on one segment's colour (new jobs go to `jobs`, shared by the plan on screen and the staged one).
            func apply(_ entry: [String: Any], _ colour: inout SegmentColour) -> String? {
                    var focusKey: String? = nil
                    if entry.keys.contains("transform") { colour.transform = (entry["transform"] as? [NSNumber])?.map { $0.floatValue } }
                    if let file = entry["lutFile"] as? String, let size = (entry["lutSize"] as? NSNumber)?.intValue {
                        if let table = self.tables[file] ?? gpu.table(file: file, size: size) { self.tables[file] = table; colour.table = table; colour.tableSize = size }
                        colour.mode = (entry["mode"] as? String) == "full" ? 1 : 2
                    }
                    if entry.keys.contains("diffusion") { colour.diffusion = (entry["diffusion"] as? NSNumber)?.doubleValue }
                    let params = numbers(entry, "params")
                    // Numbers belong to a base table (mode 2); a piece drawn through its whole table (mode 1) keeps it.
                    if params.count == 18, colour.table != nil, colour.mode != 1 {
                        let n = lookNumbers(params: params, basic: numbers(entry, "basic"), mixer: numbers(entry, "mixer"), exposure: numbers(entry, "exposure"))
                        let key = self.numbersKey(n)
                        if key != colour.numbersKey || colour.lattice == nil {
                            if let lattice = self.lattices[key] ?? made[key] { colour.lattice = lattice }
                            else if let lattice = gpu.lattice() { made[key] = lattice; jobs.append((n, lattice)); colour.lattice = lattice }
                            colour.numbersKey = key
                        }
                        focusKey = key
                        colour.mode = 2
                    }
                    return focusKey
            }
            if let list = root["segments"] as? [[String: Any]] {
                for entry in list {
                    // Matched by span: the page names each piece by where it sits, as the plan does.
                    guard let start = (entry["start"] as? NSNumber)?.doubleValue else { continue }
                    // AV4: and by lane (a layout's pictures start together on two lanes).
                    let lane = (entry["layer"] as? NSNumber)?.intValue ?? 0
                    if let index = spans.firstIndex(where: { abs($0.start - start) < 0.0005 && $0.layer == lane }) {
                        var colour = next[index]
                        let key = apply(entry, &colour)
                        if index == focusIndex, let key { focusKey = key }
                        next[index] = colour
                    }
                    if let other = nextStaged, let index = other.spans.firstIndex(where: { abs($0.start - start) < 0.0005 && $0.layer == lane }), index < other.segments.count {
                        var colour = other.segments[index]
                        _ = apply(entry, &colour)
                        nextStaged?.segments[index] = colour
                    }
                }
            }
            let started = CACurrentMediaTime()
            let first = focusKey.flatMap { made[$0] }
            let firstJobs = jobs.filter { job in first.map { job.into === $0 } ?? false }
            var ok = gpu.bake(firstJobs)
            let bakeMs = (CACurrentMediaTime() - started) * 1000
            self.lock.lock()
            if ok && planNow == self.planId, let focusIndex, focusIndex < next.count, focusIndex < self.segments.count { self.segments[focusIndex] = next[focusIndex] }
            if let finish = root["finish"] as? [String: Any] {
                func plan<T: Decodable>(_ key: String, as type: T.Type) -> T? {
                    guard let value = finish[key], !(value is NSNull), let data = try? JSONSerialization.data(withJSONObject: value) else { return nil }
                    return try? JSONDecoder().decode(type, from: data)
                }
                if finish.keys.contains("grain") { self.grain = plan("grain", as: GrainPlan.self); self.staged?.grain = self.grain }
                if finish.keys.contains("vignette") { self.vignette = plan("vignette", as: VignettePlan.self); self.staged?.vignette = self.vignette }
                if finish.keys.contains("detail") { self.detail = plan("detail", as: DetailPlan.self); self.staged?.detail = self.detail }
                if let scoped = finish["scoped"] as? Bool { self.scoped = scoped; self.staged?.scoped = scoped }
            }
            if let bypass = root["bypass"] as? Bool { self.bypass = bypass }
            self.generation += 1
            let generation = self.generation
            self.lastBakeMs = bakeMs
            self.lock.unlock()
            swapped?(generation)
            let shownMs = (CACurrentMediaTime() - asked) * 1000
            // Then every other piece, in one more swap (a drag of a whole edit slider changes them all), unless a newer
            // change is already waiting: it bakes them from these numbers' successors, so this work would be thrown away.
            if ok, let focusKey, let first { self.lattices[focusKey] = first }
            // In small batches, so a newer change waits at most one batch (about a millisecond) behind this one. Only a
            // change of numbers gives way: one that brings tables (a new Look, a piece's tables arriving) always lands,
            // because the change after it carries numbers only.
            let structural = (root["segments"] as? [[String: Any]])?.contains { $0["lutFile"] != nil } ?? false
            let rest = jobs.filter { job in !firstJobs.contains { $0.into === job.into } }
            var from = 0
            while from < rest.count {
                self.lock.lock(); let newer = self.queuedUpdates > 0 && !structural; self.lock.unlock()
                if newer { DispatchQueue.main.async { done(generation, shownMs) }; return }
                ok = gpu.bake(Array(rest[from..<min(rest.count, from + 8)])) && ok
                from += 8
            }
            self.lock.lock(); let newer = self.queuedUpdates > 0 && !structural; self.lock.unlock()
            if newer { DispatchQueue.main.async { done(generation, shownMs) }; return }
            for (key, lattice) in made { self.lattices[key] = lattice }
            if self.lattices.count > 256 { self.lattices = made }
            self.lock.lock()
            if ok && planNow == self.planId { self.segments = next; self.generation += 1 }
            // The staged plan, once every lattice it names is baked (never committed with one still unbaked).
            if ok, let nextStaged {
                if self.staged?.id == nextStaged.id { self.staged?.segments = nextStaged.segments }
                // Committed while this change baked: the plan on screen is that staged one now.
                else if self.committedStage == nextStaged.id && self.planId == self.committedPlan { self.segments = nextStaged.segments; self.generation += 1 }
            }
            self.restMs = (CACurrentMediaTime() - started) * 1000
            self.lock.unlock()
            DispatchQueue.main.async { done(generation, shownMs) }
        }
        return true
    }

    /// The Look generation now (the presenter draws again when it moves).
    var currentGeneration: Int { lock.lock(); defer { lock.unlock() }; return generation }
    /// Wait (bounded) until the plan's Look is ready: its shader compiled and its lattices baked.
    func waitReady(_ wait: Double = 3) { _ = snapshot(at: -1, wait: wait) }

    struct Snapshot { let start: Double?; let colour: SegmentColour?; let grain: GrainPlan?; let vignette: VignettePlan?; let detail: DetailPlan?; let scoped: Bool; let fps: Double; let generation: Int; let ready: Bool }
    /// The Look for one picture time. Waits (bounded) for a load in progress, so a picture never shows without it.
    func snapshot(at time: Double, wait: Double = 3) -> Snapshot {
        lock.lock(); defer { lock.unlock() }
        let deadline = Date().addingTimeInterval(wait)
        while readyLoad < wantedLoad && Date() < deadline { _ = lock.wait(until: deadline) }
        if time >= 0 { focus = time }
        let index = spans.firstIndex { time >= $0.start - 0.002 && time < $0.end - 0.002 && $0.layer == 0 } ?? spans.firstIndex { time >= $0.start - 0.002 && time < $0.end - 0.002 }
        let colour = bypass ? nil : index.flatMap { $0 < segments.count ? segments[$0] : nil }
        return Snapshot(start: index.map { spans[$0].start }, colour: colour, grain: bypass ? nil : grain, vignette: bypass ? nil : vignette, detail: bypass ? nil : detail, scoped: bypass ? false : scoped,
                        fps: fps, generation: generation, ready: readyLoad >= wantedLoad && failed == nil && (colour?.mode ?? 0) >= 0)
    }
    /// AV4: one picture of a moment as the presenter draws it: its tile, its segment, its colour and its numbers.
    struct FrameLayer { let tile: Int; let seg: Int; let backdrop: Bool; let colour: SegmentColour?; let values: LayerValues; let start: Double; let layer: Int }
    /// AV4: everything one composed picture is drawn with: its span's pictures (tile order), the edit's finish, and
    /// whether every piece's tables are here (`pending` names those still on their way, by start).
    struct FrameSnapshot {
        let layout: PictureLayout?; let span: Int?; let layers: [FrameLayer]; let plain: Bool
        let grain: GrainPlan?; let vignette: VignettePlan?; let detail: DetailPlan?; let scoped: Bool; let bypass: Bool; let fps: Double; let generation: Int; let ready: Bool
        let pending: [Double]
        /// The plain path's snapshot (AV2 and AV3's renderer): the moment's one picture.
        var single: Snapshot {
            let first = layers.first
            return Snapshot(start: first?.start, colour: first?.colour, grain: grain, vignette: vignette, detail: detail, scoped: scoped, fps: fps, generation: generation, ready: ready)
        }
    }
    /// AV4: the moment `time` of the plan on screen, framed for layout span `span` (the composed picture says which;
    /// without it, the span at that time).
    func frame(at time: Double, span given: Int?, wait: Double = 3) -> FrameSnapshot {
        lock.lock(); defer { lock.unlock() }
        let deadline = Date().addingTimeInterval(wait)
        while readyLoad < wantedLoad && Date() < deadline { _ = lock.wait(until: deadline) }
        if time >= 0 { focus = time }
        let span = given.flatMap { layout?.spans.indices.contains($0) == true ? $0 : nil } ?? layout?.spanIndex(at: time)
        var layers: [FrameLayer] = []
        var pending: [Double] = []
        if let layout, let span {
            for (k, tile) in layout.spans[span].tiles.enumerated() where tile.seg < segments.count {
                // Look off (Shift+D) draws the plain picture, still through its clip transform (the viewer keeps it).
                var plainColour = SegmentColour(); plainColour.transform = segments[tile.seg].transform
                let colour = bypass ? plainColour : segments[tile.seg]
                if (segments[tile.seg].mode) < 0 && !bypass { pending.append(spans[tile.seg].start) }
                layers.append(FrameLayer(tile: k, seg: tile.seg, backdrop: tile.backdrop, colour: colour, values: layout.values(tile.seg, at: time), start: spans[tile.seg].start, layer: spans[tile.seg].layer))
            }
        }
        let plain = layout.flatMap { l in span.map { l.plain($0, at: time) } } ?? true
        return FrameSnapshot(layout: layout, span: span, layers: layers, plain: plain, grain: bypass ? nil : grain, vignette: bypass ? nil : vignette, detail: bypass ? nil : detail,
                             scoped: bypass ? false : scoped, bypass: bypass, fps: fps, generation: generation, ready: readyLoad >= wantedLoad && failed == nil && pending.isEmpty, pending: pending)
    }

    func summary() -> [String: Any] {
        lock.lock(); defer { lock.unlock() }
        return ["segments": segments.count, "graded": segments.filter { $0.mode > 0 }.count, "uniform": segments.filter { $0.mode == 2 }.count, "pending": segments.filter { $0.mode < 0 }.count,
                "generation": generation, "ready": readyLoad >= wantedLoad, "failed": failed ?? NSNull(), "bakeMs": (lastBakeMs * 10).rounded() / 10, "allBakeMs": (restMs * 10).rounded() / 10,
                "grain": grain?.amount ?? 0, "vignette": vignette?.amount ?? 0, "detail": detail?.amount ?? 0, "scoped": scoped, "bypass": bypass]
    }
}

// MARK: the Look on a framed picture

/// Key on each displayed picture: the Look generation it was drawn with (QA reads it as the picture is shown).
let lookGenerationKey = "PrecutLookGeneration" as CFString
/// AV4: key on each composed picture: the layout span it was framed for (PictureLayout.spans).
let appleSpanKey = "PrecutLayoutSpan" as CFString

/// Draws the Look onto a framed picture: the piece's tables (base table, then its baked live grade, or its whole
/// table), then, as the viewer does, the 8 bit composed picture, per piece diffusion, the edit's detail, and grain
/// and vignette. Used by the window's presenter (at display time, so a Look change shows on the next refresh) and
/// by the command line helper's frames (QA), so both draw the same picture. One renderer per thread.
final class AppleLookRenderer {
    private var scratch: (width: Int, height: Int, composed: MTLTexture, levels: [MTLTexture], tmp: MTLTexture, detailA: MTLTexture, detailB: MTLTexture)?
    private var dummy3D: MTLTexture?
    /// AV4: a scene (the viewer's group of a dissolving layout) and a backdrop's graded source, 8 bit as the viewer's.
    private var layered: (width: Int, height: Int, scene: MTLTexture, backdrop: MTLTexture)?
    /// The grain plate for the current grain choice (roughness and colour), made once per choice.
    private var plate: (key: String, texture: MTLTexture)?

    private func scratchFor(_ width: Int, _ height: Int) -> (composed: MTLTexture, levels: [MTLTexture], tmp: MTLTexture, detailA: MTLTexture, detailB: MTLTexture)? {
        if let s = scratch, s.width == width, s.height == height { return (s.composed, s.levels, s.tmp, s.detailA, s.detailB) }
        let gpu = AppleGPU.shared
        guard let composed = gpu.texture2D(.rgba8Unorm, width, height), let tmp = gpu.texture2D(.rgba16Float, width, height),
              let a = gpu.texture2D(.rgba16Float, width, height), let b = gpu.texture2D(.rgba16Float, width, height) else { return nil }
        var levels: [MTLTexture] = []
        for _ in 0..<5 { guard let t = gpu.texture2D(.rgba16Float, width, height) else { return nil }; levels.append(t) }
        scratch = (width, height, composed, levels, tmp, a, b)
        return (composed, levels, tmp, a, b)
    }
    private func dummyTable() -> MTLTexture? {
        if let dummy3D { return dummy3D }
        let d = MTLTextureDescriptor()
        d.textureType = .type3D; d.pixelFormat = .rgba32Float; d.width = 2; d.height = 2; d.depth = 2; d.usage = [.shaderRead]
        dummy3D = AppleGPU.shared.device?.makeTexture(descriptor: d)
        return dummy3D
    }

    /// Encode the picture pass: `source` mapped through `transform` (top left pixels, source to output), then the
    /// colour's tables. Outside the picture stays transparent black unless `final` (then opaque black).
    static func encodePicture(_ encoder: MTLComputeCommandEncoder, source: MTLTexture?, sourceSize: CGSize, transform: CGAffineTransform, colour: SegmentColour?, out: MTLTexture, final: Bool, dummy: MTLTexture?) -> Bool {
        let gpu = AppleGPU.shared
        guard let pipe = gpu.pipeline("applePicture") else { return false }
        let inverse = transform.inverted()
        var args: [UInt32] = [Float(inverse.a), Float(inverse.b), Float(inverse.c), Float(inverse.d), Float(inverse.tx), Float(inverse.ty), Float(sourceSize.width), Float(sourceSize.height)].map { $0.bitPattern }
        args += [UInt32(source == nil ? 0 : 1), UInt32(max(0, colour?.mode ?? 0)), Float(colour?.tableSize ?? 2).bitPattern, UInt32(final ? 1 : 0)]
        // AV3: the clip transform (PictureArgs clip, outputAspect, clipFlip, clipAffine, clipCrop), as the viewer's
        // paintTransform sets its uniforms: affine (cos/scale, sin/scale, x, y), crop (l, t, r, b), flip, aspect.
        if let t = colour?.transform, t.count >= 11 {
            args += [1, t[10].bitPattern, t[8].bitPattern, t[9].bitPattern] + t[0..<8].map { $0.bitPattern }
        } else { args += [UInt32](repeating: 0, count: 12) }
        let table = colour?.table ?? colour?.lattice ?? dummy
        encoder.setTexture(source ?? out, index: 0)
        encoder.setTexture(table, index: 1)
        encoder.setTexture(colour?.lattice ?? table, index: 2)
        encoder.setTexture(out, index: 3)
        encoder.setBytes(args, length: args.count * 4, index: 0)
        gpu.dispatch(encoder, pipe, width: out.width, height: out.height)
        return true
    }

    /// AV4: one composed picture as the viewer draws its stage (LivePlayer draw): each picture of the moment through
    /// the viewer's layer main() (its region, masks, blur and opacity) and its tables, a layout background behind the
    /// picture that carries one, a dissolving layout scene drawn whole and then faded (the viewer's groups), then the
    /// edit's detail, grain and vignette. A moment with one plain whole frame picture is drawn by `encode`, as before.
    func encodeFrame(_ buffer: MTLCommandBuffer, framed: MTLTexture?, out: MTLTexture, time: Double, frame: AppleLookState.FrameSnapshot) -> Bool {
        if frame.plain || frame.layout == nil { return encode(buffer, framed: framed, out: out, time: time, snap: frame.single) }
        let gpu = AppleGPU.shared
        guard let layout = frame.layout, let framed, let layerPipe = gpu.pipeline("appleLayer"), let clearPipe = gpu.pipeline("appleClear"),
              let backdropPipe = gpu.pipeline("appleBackdrop"), let groupPipe = gpu.pipeline("appleGroup") else { return false }
        let width = out.width, height = out.height
        guard let scratch = scratchFor(width, height) else { return false }
        if layered == nil || layered!.width != width || layered!.height != height {
            guard let scene = gpu.texture2D(.rgba8Unorm, width, height), let backdrop = gpu.texture2D(.rgba8Unorm, width, height) else { return false }
            layered = (width, height, scene, backdrop)
        }
        guard let extra = layered, let encoder = buffer.makeComputeCommandEncoder() else { return false }
        defer { encoder.endEncoding() }
        let dummy = dummyTable()
        func clear(_ texture: MTLTexture) { encoder.setTexture(texture, index: 0); gpu.dispatch(encoder, clearPipe, width: width, height: height) }
        /// One picture tile through the viewer's main() into `target`.
        func draw(_ layer: AppleLookState.FrameLayer, into target: MTLTexture, dest: (x: Int, y: Int, w: Int, h: Int), opacity: Double, plainPicture: Bool) {
            let plan = layout.segs[layer.seg].visual, v = layer.values, colour = layer.colour
            let transform = plainPicture ? nil : colour?.transform.flatMap { $0.count >= 11 ? $0 : nil }
            let circle = !plainPicture && (plan?.circle ?? false), radius = plainPicture ? 0 : v.radius
            let blend = !plainPicture && (opacity < 1 || circle || radius > 0)
            var flags: Float = blend ? 1 : 0
            if let t = transform { flags += 2 + (t[8] != 0 ? 4 : 0) + (t[9] != 0 ? 8 : 0) }
            let regionAspect = Float(Double(max(1, dest.w)) / Double(max(1, dest.h)))
            let pixels = v.pixels.count == 2 ? v.pixels : [960, 960 * Double(height) / Double(width)]
            let c = plan?.colour ?? [0, 0, 0]
            let args: [Float] = [
                Float(dest.x), Float(dest.y), Float(dest.w), Float(dest.h),
                Float(dest.x), Float(dest.y + layer.tile * layout.height), Float(dest.w), Float(dest.h),
                transform?[0] ?? 1, transform?[1] ?? 0, transform?[2] ?? 0, transform?[3] ?? 0,
                transform?[4] ?? 0, transform?[5] ?? 0, transform?[6] ?? 0, transform?[7] ?? 0,
                Float(opacity), Float(radius), Float(colour?.tableSize ?? 2), transform?[10] ?? regionAspect,
                Float(plainPicture ? 0 : v.blur.first ?? 0), Float(plainPicture ? 0 : v.blur.count > 1 ? v.blur[1] : 0), Float(pixels[0]), Float(pixels[1]),
                Float(c.count > 0 ? c[0] : 0), Float(c.count > 1 ? c[1] : 0), Float(c.count > 2 ? c[2] : 0), Float(max(0, colour?.mode ?? 0)),
                circle ? 1 : 0, (plan?.sceneMask ?? false) ? 1 : 0, (plan?.dim ?? false) ? 1 : 0, flags]
            let table = colour?.table ?? colour?.lattice ?? dummy
            encoder.setTexture(framed, index: 0); encoder.setTexture(table, index: 1); encoder.setTexture(colour?.lattice ?? table, index: 2); encoder.setTexture(target, index: 3)
            encoder.setBytes(args, length: args.count * 4, index: 0)
            gpu.dispatch(encoder, layerPipe, width: max(1, dest.w), height: max(1, dest.h))
        }
        /// A picture with its background behind it, as the viewer's drawLayer.
        func drawLayer(_ layer: AppleLookState.FrameLayer, into target: MTLTexture, opaque: Bool) {
            guard !layer.backdrop else { return }
            let plan = layout.segs[layer.seg].visual, v = layer.values
            if let bg = plan?.background {
                // The screen background: the picture fitted to the whole frame and graded (the backdrop's source).
                if bg.kind == 1, let source = frame.layers.first(where: { $0.seg == layer.seg && $0.backdrop }) {
                    draw(source, into: extra.backdrop, dest: (0, 0, width, height), opacity: 1, plainPicture: true)
                }
                let stops = (0..<3).flatMap { i -> [Float] in let s = i < bg.stops.count ? bg.stops[i] : (bg.stops.last ?? [0, 0, 0]); return [Float(s[0]), Float(s.count > 1 ? s[1] : 0), Float(s.count > 2 ? s[2] : 0), 0] }
                let image = bg.kind == 2 ? bg.image.flatMap { gpu.image($0) } : nil
                let args: [Float] = [Float(bg.kind), Float(bg.blur), Float(bg.dim), Float(bg.stops.count),
                                     Float(image.map { Double($0.width) / Double(max(1, $0.height)) } ?? 1), 81, Float(Double(width) / Double(height)), Float(Double(width) / Double(height)),
                                     Float(bg.direction.first ?? 1), Float(bg.direction.count > 1 ? bg.direction[1] : 0), 0, 0] + stops
                encoder.setTexture(extra.backdrop, index: 0); encoder.setTexture(image ?? extra.backdrop, index: 1); encoder.setTexture(target, index: 2)
                encoder.setBytes(args, length: args.count * 4, index: 0)
                gpu.dispatch(encoder, backdropPipe, width: width, height: height)
            }
            let opacity = (opaque ? 1 : v.opacity) * v.shape
            draw(layer, into: target, dest: layout.box(v), opacity: opacity, plainPicture: false)
        }
        clear(scratch.composed)
        let pictures = frame.layers.filter { !$0.backdrop }
        let grouped = frame.scoped || (pictures.contains { layout.segs[$0.seg].visual?.region ?? false } && pictures.contains { $0.values.opacity < 1 })
        if grouped {
            // The viewer's groups: by owner piece (and lane, for a piece's own diffusion outside a layout), in start order.
            var groups: [(key: String, layers: [AppleLookState.FrameLayer])] = []
            for layer in pictures {
                let plan = layout.segs[layer.seg].visual
                let owner = plan?.owner ?? "\(layer.seg)", key = frame.scoped && !(plan?.region ?? false) ? "\(owner):\(layer.layer)" : owner
                if let i = groups.firstIndex(where: { $0.key == key }) { groups[i].layers.append(layer) } else { groups.append((key, [layer])) }
            }
            for group in groups.sorted(by: { $0.layers[0].start < $1.layers[0].start }) {
                clear(extra.scene)
                for layer in group.layers { drawLayer(layer, into: extra.scene, opaque: true) }
                var source: MTLTexture = extra.scene
                let diffusion = frame.scoped ? (group.layers[0].colour?.diffusion ?? frame.detail?.diffusion ?? 0) : 0
                if diffusion > 0 {
                    guard detailPass(encoder, source: extra.scene, out: scratch.detailA, levels: scratch.levels, tmp: scratch.tmp, width: width, height: height,
                                     d: DetailPlan(amount: 0, radius: 1, detail: 25, masking: 40, texture: 0, clarity: 0, diffusion: diffusion)) else { return false }
                    source = scratch.detailA
                }
                encoder.setTexture(source, index: 0); encoder.setTexture(scratch.composed, index: 1)
                encoder.setBytes([Float(group.layers[0].values.opacity)], length: 4, index: 0)
                gpu.dispatch(encoder, groupPipe, width: width, height: height)
            }
        } else {
            for layer in pictures { drawLayer(layer, into: scratch.composed, opaque: false) }
        }
        let detailOn = frame.detail.map { $0.amount != 0 || $0.texture != 0 || $0.clarity != 0 || (!frame.scoped && $0.diffusion != 0) } ?? false
        if !(detailOn || (frame.grain?.amount ?? 0) != 0 || (frame.vignette?.amount ?? 0) != 0) {
            // Nothing to finish: the composed picture is the picture (the viewer draws its layers straight to the canvas).
            guard let copy = gpu.pipeline("appleCopy") else { return false }
            encoder.setTexture(scratch.composed, index: 0); encoder.setTexture(out, index: 1)
            gpu.dispatch(encoder, copy, width: width, height: height)
            return true
        }
        return finish(encoder, composed: scratch.composed, scratch: scratch, out: out, time: time, detail: frame.detail, scoped: frame.scoped, grain: frame.grain, vignette: frame.vignette, fps: frame.fps)
    }

    /// The Look for one framed picture into `out` (any size equal to the framed picture's), as the viewer draws it.
    func encode(_ buffer: MTLCommandBuffer, framed: MTLTexture?, out: MTLTexture, time: Double, snap: AppleLookState.Snapshot) -> Bool {
        let gpu = AppleGPU.shared
        let width = out.width, height = out.height
        // A plan with no Look and no shader (an older plan, a test's own): the framed picture as it is.
        if gpu.pipeline("applePicture") == nil {
            guard let framed, (snap.colour?.mode ?? 0) == 0, snap.detail == nil, snap.grain == nil, snap.vignette == nil,
                  framed.width == width, framed.height == height, framed.pixelFormat == out.pixelFormat, let blit = buffer.makeBlitCommandEncoder() else { return false }
            blit.copy(from: framed, to: out)
            blit.endEncoding()
            return true
        }
        guard let encoder = buffer.makeComputeCommandEncoder() else { return false }
        defer { encoder.endEncoding() }
        let colour = snap.colour
        let detailOn = snap.detail.map { $0.amount != 0 || $0.texture != 0 || $0.clarity != 0 || (!snap.scoped && $0.diffusion != 0) } ?? false
        let segmentDiffusion = snap.scoped ? (colour?.diffusion ?? snap.detail?.diffusion ?? 0) : 0
        let finishing = snap.scoped || detailOn || (snap.grain?.amount ?? 0) != 0 || (snap.vignette?.amount ?? 0) != 0
        let scratch = finishing ? scratchFor(width, height) : nil
        if finishing && scratch == nil { return false }
        let size = CGSize(width: framed?.width ?? width, height: framed?.height ?? height)
        guard Self.encodePicture(encoder, source: framed, sourceSize: size, transform: .identity, colour: colour, out: scratch?.composed ?? out, final: !finishing, dummy: dummyTable()) else { return false }
        guard let scratch else { return true }
        var current = scratch.composed
        if snap.scoped && segmentDiffusion > 0 {
            // The viewer's per piece diffusion (scoped): detail with only diffusion, back into the 8 bit scene.
            guard detailPass(encoder, source: current, out: scratch.detailA, levels: scratch.levels, tmp: scratch.tmp, width: width, height: height,
                             d: DetailPlan(amount: 0, radius: 1, detail: 25, masking: 40, texture: 0, clarity: 0, diffusion: segmentDiffusion)),
                  let copy = gpu.pipeline("appleCopy") else { return false }
            encoder.setTexture(scratch.detailA, index: 0); encoder.setTexture(scratch.composed, index: 1)
            gpu.dispatch(encoder, copy, width: width, height: height)
            current = scratch.composed
        }
        return finish(encoder, composed: current, scratch: scratch, out: out, time: time, detail: snap.detail, scoped: snap.scoped, grain: snap.grain, vignette: snap.vignette, fps: snap.fps)
    }

    /// The edit's detail (with its diffusion unless each piece carries its own), then grain and vignette, from the 8
    /// bit composed picture into `out`, as the viewer's finish pass. With none of them, the picture is copied.
    private func finish(_ encoder: MTLComputeCommandEncoder, composed: MTLTexture, scratch: (composed: MTLTexture, levels: [MTLTexture], tmp: MTLTexture, detailA: MTLTexture, detailB: MTLTexture),
                        out: MTLTexture, time: Double, detail: DetailPlan?, scoped: Bool, grain: GrainPlan?, vignette: VignettePlan?, fps: Double) -> Bool {
        let gpu = AppleGPU.shared
        let width = out.width, height = out.height
        var current = composed
        let detailOn = detail.map { $0.amount != 0 || $0.texture != 0 || $0.clarity != 0 || (!scoped && $0.diffusion != 0) } ?? false
        if detailOn, let d = detail {
            let global = scoped ? DetailPlan(amount: d.amount, radius: d.radius, detail: d.detail, masking: d.masking, texture: d.texture, clarity: d.clarity, diffusion: 0) : d
            guard detailPass(encoder, source: current, out: scratch.detailB, levels: scratch.levels, tmp: scratch.tmp, width: width, height: height, d: global) else { return false }
            current = scratch.detailB
        }
        guard let finish = gpu.pipeline("appleFinish") else { return false }
        let g = grain, v = vignette
        let plateKey = "\(g?.roughness ?? 0):\(g?.colour ?? 0)"
        if plate?.key != plateKey, let made = gpu.texture2D(.rgba16Float, 96, 96), let platePipe = gpu.pipeline("applePlate") {
            encoder.setTexture(made, index: 0)
            encoder.setBytes([Float(g?.roughness ?? 0), Float(g?.colour ?? 0)], length: 8, index: 0)
            gpu.dispatch(encoder, platePipe, width: 96, height: 96)
            plate = (plateKey, made)
        }
        let frame = floor(time * fps + 1e-6)
        let f: [Float] = [Float(width), Float(height), Float(frame), Float(g?.amount ?? 0), Float(g?.size ?? 0), Float(g?.roughness ?? 0), Float(g?.colour ?? 0),
                          Float(g?.shadows ?? 0), Float(g?.highlights ?? 0), Float(v?.amount ?? 0), Float(v?.midpoint ?? 50), Float(v?.feather ?? 70)]
        encoder.setTexture(current, index: 0); encoder.setTexture(out, index: 1); encoder.setTexture(plate?.texture, index: 2)
        encoder.setBytes(f, length: f.count * 4, index: 0)
        gpu.dispatch(encoder, finish, width: width, height: height)
        return true
    }

    /// The viewer's DetailPass, in its order: seed, one to four separable blur levels, then the detail maths.
    private func detailPass(_ encoder: MTLComputeCommandEncoder, source: MTLTexture, out: MTLTexture, levels: [MTLTexture], tmp: MTLTexture, width: Int, height: Int, d: DetailPlan) -> Bool {
        let gpu = AppleGPU.shared
        guard let seed = gpu.pipeline("appleDetailSeed"), let blur = gpu.pipeline("appleDetailBlur"), let detail = gpu.pipeline("appleDetail") else { return false }
        encoder.setTexture(source, index: 0); encoder.setTexture(levels[0], index: 1)
        gpu.dispatch(encoder, seed, width: width, height: height)
        let count = d.clarity != 0 || d.diffusion != 0 ? 4 : d.texture != 0 || d.radius > 1 ? 2 : 1
        for i in 0..<count {
            let step = Int32(gpu.detailSteps[i])
            encoder.setTexture(levels[i], index: 0); encoder.setTexture(tmp, index: 1)
            encoder.setBytes([step, 0], length: 8, index: 0)
            gpu.dispatch(encoder, blur, width: width, height: height)
            encoder.setTexture(tmp, index: 0); encoder.setTexture(levels[i + 1], index: 1)
            encoder.setBytes([0, step], length: 8, index: 0)
            gpu.dispatch(encoder, blur, width: width, height: height)
        }
        let args: [Float] = [d.amount, d.radius, d.detail, d.masking, d.texture, d.clarity, d.diffusion, 0].map { Float($0) }
        encoder.setTexture(source, index: 0); encoder.setTexture(levels[0], index: 1); encoder.setTexture(levels[1], index: 2)
        encoder.setTexture(levels[min(2, count)], index: 3); encoder.setTexture(levels[count], index: 4); encoder.setTexture(out, index: 5)
        encoder.setBytes(args, length: args.count * 4, index: 0)
        gpu.dispatch(encoder, detail, width: width, height: height)
        return true
    }

    /// Command line helper (QA): the Look on one framed picture, into a new picture buffer, waiting for the GPU.
    func render(framed: CVPixelBuffer, time: Double, frame: AppleLookState.FrameSnapshot) -> CVPixelBuffer? {
        let gpu = AppleGPU.shared
        // The output is one tile of the composed picture (AV4: a column of tiles).
        let width = frame.layout?.width ?? CVPixelBufferGetWidth(framed), height = frame.layout?.height ?? CVPixelBufferGetHeight(framed)
        var made: CVPixelBuffer?
        let attributes = [kCVPixelBufferMetalCompatibilityKey as String: true, kCVPixelBufferIOSurfacePropertiesKey as String: [:]] as CFDictionary
        guard CVPixelBufferCreate(nil, width, height, kCVPixelFormatType_32BGRA, attributes, &made) == kCVReturnSuccess, let made,
              let source = gpu.wrap(framed), let target = gpu.wrap(made), let queue = gpu.queue, let buffer = queue.makeCommandBuffer(),
              encodeFrame(buffer, framed: source.1, out: target.1, time: time, frame: frame) else { return nil }
        buffer.commit(); buffer.waitUntilCompleted()
        return buffer.status == .completed ? made : nil
    }
}

// MARK: compositor

/// Frames each picture of the edit: the builder's framing (one transform per piece) on a transparent black field,
/// its pixels unchanged (Metal; Core Image if Metal is unavailable). The Look is drawn later, at display time, by
/// AppleLookRenderer: AVPlayer composes pictures well ahead of the display (about 0.7 s, measured), so a Look drawn
/// here would show a Look change that late. Frame timing follows the source pictures (sourceTrackIDForFrameTiming).
final class PictureCompositor: NSObject, AVVideoCompositing {
    private let render = DispatchQueue(label: "com.sidething.precut.apple-compose", qos: .userInteractive)
    private let plain = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
    private static let attributes: [String: any Sendable] = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferMetalCompatibilityKey as String: true]
    var sourcePixelBufferAttributes: [String: any Sendable]? { Self.attributes }
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] { Self.attributes }
    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        render.async { [weak self] in
            guard let self else { request.finish(with: CompositionError.message("compositor gone")); return }
            self.compose(request)
        }
    }

    /// Pictures composed, and asks with no buffer to compose into (diagnostics, in the player's state).
    nonisolated(unsafe) static var composed = 0
    nonisolated(unsafe) static var starved = 0
    /// AV4: each track's last source picture (on the render queue only).
    private var held: [CMPersistentTrackID: (picture: CVPixelBuffer, at: Double)] = [:]
    /// AV4: why a picture could not be composed, for the player's state and its events (a failed request fails the item).
    nonisolated(unsafe) static var lastFailure: String?
    private func fail(_ request: AVAsynchronousVideoCompositionRequest, _ reason: String) {
        Self.lastFailure = reason
        appleLookEvent?(["type": "composeFailed", "reason": reason, "at": CMTimeGetSeconds(request.compositionTime)])
        request.finish(with: CompositionError.message(reason))
    }
    private func compose(_ request: AVAsynchronousVideoCompositionRequest, tries: Int = 0) {
        Self.composed += 1
        guard let out = request.renderContext.newPixelBuffer() else {
            // AV4: the pool is empty for a moment (a swap readying a second player, the texture cache still holding
            // pictures): try again shortly rather than fail the item, which hands the edit to the standard player.
            Self.starved += 1
            if tries < 20 { render.asyncAfter(deadline: .now() + 0.005) { [weak self] in self?.compose(request, tries: tries + 1) }; return }
            fail(request, "no picture buffer"); return
        }
        CVBufferSetAttachment(out, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
        CVBufferSetAttachment(out, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_sRGB, .shouldPropagate)
        guard let instruction = request.videoCompositionInstruction as? TileInstruction else { fail(request, "not a tile span"); return }
        let layout = instruction.layout, span = layout.spans[instruction.span], t = CMTimeGetSeconds(request.compositionTime)
        // AV4: which span the picture belongs to rides with it, so the presenter reads its tiles the same way.
        CVBufferSetAttachment(out, appleSpanKey, NSNumber(value: instruction.span), .shouldPropagate)
        // The shader compiles as the plan loads (about 0.3 s, once per run): framing waits for it rather than differ.
        AppleLookState.shared.waitReady()
        let gpu = AppleGPU.shared
        if let pipe = gpu.pipeline("appleFrameTile"), let target = gpu.wrap(out), let queue = gpu.queue, let buffer = queue.makeCommandBuffer(),
           let encoder = buffer.makeComputeCommandEncoder() {
            var keep: [Any] = [target.0]
            for (k, tile) in span.tiles.enumerated() {
                // AV4: a track can have no picture for the first tick of its segment (time rounding at an edge, a layout
                // starting on a second track): its last picture stands in, as the viewer holds a layer's last frame
                // (PS1), never a black tile.
                let track = layout.trackIDs[tile.seg]
                var frame = request.sourceFrame(byTrackID: track)
                if let frame { held[track] = (frame, t) } else if let last = held[track], abs(last.at - t) < 0.25 { frame = last.picture }
                let wrapped = frame.flatMap { gpu.wrap($0) }
                if let wrapped { keep.append(wrapped.0) }
                let v = layout.values(tile.seg, at: t)
                let sw = Double(frame.map { CVPixelBufferGetWidth($0) } ?? 1), sh = Double(frame.map { CVPixelBufferGetHeight($0) } ?? 1)
                let map = layout.sourceMap(tile.seg, v, backdrop: tile.backdrop, sourceWidth: sw, sourceHeight: sh)
                // The viewport and two pixels round it (a blur or an edge sample reads just past it, as the viewer's
                // texture read does), inside this tile's own frame.
                let b = tile.backdrop ? (x: 0, y: 0, w: layout.width, h: layout.height) : layout.box(v)
                let x0 = max(0, b.x - 2), y0 = max(0, b.y - 2), x1 = min(layout.width, b.x + b.w + 2), y1 = min(layout.height, b.y + b.h + 2)
                let origin = Float(k * layout.height)
                let args: [Float] = [Float(map.m0.x), Float(map.m0.y), Float(map.m1.x), Float(map.m1.y), Float(map.m2.x), Float(map.m2.y),
                                     wrapped == nil ? 0 : Float(sw), wrapped == nil ? 0 : Float(sh),
                                     Float(x0), Float(y0) + origin, Float(max(0, x1 - x0)), Float(max(0, y1 - y0)), 0, origin, 0, 0]
                encoder.setTexture(wrapped?.1 ?? target.1, index: 0)
                encoder.setTexture(target.1, index: 1)
                encoder.setBytes(args, length: args.count * 4, index: 0)
                gpu.dispatch(encoder, pipe, width: max(1, x1 - x0), height: max(1, y1 - y0))
            }
            encoder.endEncoding()
            buffer.addCompletedHandler { [self] done in
                _ = keep
                gpu.flush()
                if done.status == .completed { request.finish(withComposedVideoFrame: out) }
                else { self.fail(request, "framing failed: \(String(describing: done.error))") }
            }
            buffer.commit()
            return
        }
        // No Metal yet (the shader compiles as the plan loads) or none at all: Core Image frames the first picture the
        // same way (the rest of the tiles stay black).
        let width = CVPixelBufferGetWidth(out), height = CVPixelBufferGetHeight(out)
        let extent = CGRect(x: 0, y: 0, width: width, height: height)
        var image = CIImage(color: .black).cropped(to: extent)
        if let tile = span.tiles.first, let source = request.sourceFrame(byTrackID: layout.trackIDs[tile.seg]) {
            let sw = Double(CVPixelBufferGetWidth(source)), sh = Double(CVPixelBufferGetHeight(source))
            let m = layout.sourceMap(tile.seg, layout.values(tile.seg, at: t), backdrop: tile.backdrop, sourceWidth: sw, sourceHeight: sh)
            // Output to source, inverted: source pixels (top left) to output pixels (top left).
            let toSource = CGAffineTransform(a: m.m0.x, b: m.m0.y, c: m.m1.x, d: m.m1.y, tx: m.m2.x, ty: m.m2.y)
            let sourceHeight = CGFloat(sh)
            let flipIn = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: sourceHeight), flipOut = CGAffineTransform(a: 1, b: 0, c: 0, d: -1, tx: 0, ty: CGFloat(height))
            image = CIImage(cvPixelBuffer: source).transformed(by: flipIn.concatenating(toSource.inverted()).concatenating(flipOut)).composited(over: image)
        }
        plain.render(image, to: out, bounds: extent, colorSpace: nil)
        request.finish(withComposedVideoFrame: out)
    }
}
