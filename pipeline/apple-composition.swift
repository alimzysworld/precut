// AV1/AV1b: the one AVFoundation composition builder for precut's Apple player.
// Compiled into both the command line helper (build/tools/apple-player: validate,
// frame, rms for tests) and the in-process addon (build/tools/apple-player.node,
// which plays the picture behind precut's page). The manifest is built by
// src/shared/apple-playback.ts from the same timeline and live mix the Chrome
// viewer plays. This file holds no editing rules, only how to compose them.
import Foundation
import AVFoundation

struct Crop: Decodable { let x: Double; let y: Double; let w: Double; let h: Double }
struct VolumeKey: Decodable { let t: Double; let gain: Double }
/// AV3: one key of a piece's clock, reel seconds `t` to file seconds `s` (the plan's timeMap, piecewise linear).
struct TimeKey: Decodable { let t: Double; let s: Double }
struct VideoSeg: Decodable {
    let file: String; let timelineStart: Double; let timelineEnd: Double
    let sourceStart: Double; let sourceEnd: Double; let crop: Crop?; let rotation: Double; let clipId: String
    let lutId: String?; let look: SegmentLook?
    /// AV3: speed and ramps, present only when the clock is not plain 1x (see composeClock).
    let timeMap: [TimeKey]?
    /// AV3: the piece's transform as the viewer's shader takes it (src/shared/apple-playback.ts appleTransformNumbers).
    let transform: [Double]?
    /// AV4: the piece's lane (0 the spine) and how it is drawn over time (apple-playback appleLayerPlan).
    let layer: Int?
    let visual: LayerPlan?
}
/// AV4: one sampled moment of a picture layer, from the viewer's own functions (apple-playback AppleLayerKey).
struct LayerKey: Decodable { let t: Double; let rect: [Double]?; let region: [Double]?; let opacity: Double; let shape: Double; let blur: [Double]; let radius: Double; let pixels: [Double] }
struct LayerBackground: Decodable { let kind: Int; let blur: Double; let dim: Double; let stops: [[Double]]; let direction: [Double]; let image: String? }
struct LayerPlan: Decodable {
    let order: Double; let owner: String; let region: Bool; let circle: Bool; let sceneMask: Bool; let dim: Bool; let colour: [Double]
    let background: LayerBackground?; let framing: String; let turn: Int; let keys: [LayerKey]
}
struct AudioSeg: Decodable {
    let file: String; let timelineStart: Double; let timelineEnd: Double
    let sourceStart: Double; let sourceEnd: Double; let gainDb: Double
    let fadeInS: Double?; let fadeOutS: Double?; let kind: String; let volumeKeys: [VolumeKey]?
    /// A looped effect (room tone): the file repeats to fill the span, as the Chrome mix loops it.
    let loop: Bool?
    /// AV3: speed and ramps on this sound, in file seconds (the voice keeps its pitch: the reader's time pitch).
    let timeMap: [TimeKey]?
}
struct Manifest: Decodable {
    let version: Int; let width: Double; let height: Double; let fps: Double; let durationS: Double
    let video: [VideoSeg]; let audio: [AudioSeg]
    // AV2: the Look's finish and shader (pipeline/apple-look.swift) and the sound buses' plan.
    let finish: FinishPlan?; let sound: SoundPlan?; let shader: ShaderPlan?
    init(version: Int, width: Double, height: Double, fps: Double, durationS: Double, video: [VideoSeg], audio: [AudioSeg], finish: FinishPlan? = nil, sound: SoundPlan? = nil, shader: ShaderPlan? = nil) {
        self.version = version; self.width = width; self.height = height; self.fps = fps; self.durationS = durationS
        self.video = video; self.audio = audio; self.finish = finish; self.sound = sound; self.shader = shader
    }
}

enum CompositionError: Error, CustomStringConvertible {
    case message(String)
    var description: String { if case .message(let text) = self { return text }; return "composition failed" }
}

func loadManifestFile(_ path: String) throws -> Manifest {
    guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else { throw CompositionError.message("cannot read manifest \(path)") }
    do { return try JSONDecoder().decode(Manifest.self, from: data) }
    catch { throw CompositionError.message("bad manifest: \(error)") }
}
/// 60000 holds 24, 25, 30, 50 and 60 fps frames and 59.94 (1001/60000) exactly; 600 rounded 59.94 pictures and cuts.
let compositionTimescale: CMTimeScale = 60000
func seconds(_ value: Double) -> CMTime { CMTime(seconds: max(0, value), preferredTimescale: compositionTimescale) }
func gainLinear(_ db: Double) -> Float { Float(pow(10.0, db / 20.0)) }

struct BuiltComposition {
    let composition: AVMutableComposition
    let videoComposition: AVMutableVideoComposition?
    let audioMix: AVMutableAudioMix?
    /// The kind of each composition audio track, in audioMix.inputParameters order.
    let audioKinds: [String]
    /// AV4: where each picture sits in the composed picture, span by span.
    let layout: PictureLayout
}

/// AV3: one asset per file for the whole run, never one per segment or per plan: an edit has dozens of segments
/// over a handful of files, an asset each exhausts decoder sessions, and an edit while playing rebuilds the plan
/// (its tracks are read once, so a rebuild costs milliseconds). Shared by every composition this process builds.
final class AppleAssets {
    static let shared = AppleAssets()
    private let lock = NSLock()
    private var assets: [String: AVURLAsset] = [:]
    private var videoTracks: [String: AVAssetTrack] = [:]
    private var audioTracks: [String: AVAssetTrack] = [:]
    /// A file by path, size and change time: a preview made again in place is a new file.
    static func key(_ file: String) -> String {
        let attributes = try? FileManager.default.attributesOfItem(atPath: file)
        let size = (attributes?[.size] as? NSNumber)?.int64Value ?? -1
        let changed = (attributes?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0
        return "\(file)|\(size)|\(changed)"
    }
    func asset(for file: String) -> AVURLAsset {
        let key = Self.key(file)
        lock.lock(); defer { lock.unlock() }
        if let cached = assets[key] { return cached }
        let made = AVURLAsset(url: URL(fileURLWithPath: file), options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        assets[key] = made
        // A long session can open hundreds of files; the oldest go (a plan in use keeps its own references).
        if assets.count > 400 { assets.removeAll(); videoTracks.removeAll(); audioTracks.removeAll(); assets[key] = made }
        return made
    }
    func track(_ file: String, _ type: AVMediaType) -> AVAssetTrack? {
        let key = Self.key(file)
        lock.lock()
        if let known = (type == .video ? videoTracks : audioTracks)[key] { lock.unlock(); return known }
        lock.unlock()
        let found = asset(for: file).tracks(withMediaType: type).first
        lock.lock()
        if let found { if type == .video { videoTracks[key] = found } else { audioTracks[key] = found } }
        lock.unlock()
        return found
    }
}

/// AV3: a piece's clock (the plan's timeMap) on a composition track: each straight part of the map is the file's span
/// inserted at its reel time and scaled to its reel length (speed), a flat part is one picture held (a freeze). The
/// same reel to file rule the Chrome viewer and the export read (DraftPiece.timeMap, piecewise linear).
func composeClock(_ track: AVMutableCompositionTrack, source: AVAssetTrack, keys: [TimeKey], hold: Double) throws {
    for (a, b) in zip(keys, keys.dropFirst()) {
        let reel = b.t - a.t
        guard reel > 1e-6 else { continue }
        let span = b.s - a.s
        if span < 0 { throw CompositionError.message("a reversed clock cannot be composed") }
        let from = span > 1e-6 ? span : hold
        guard let range = sourceRange(source, start: a.s, duration: from) else { continue }
        try track.insertTimeRange(range, of: source, at: seconds(a.t))
        let inserted = CMTimeRange(start: seconds(a.t), duration: range.duration)
        if abs(CMTimeGetSeconds(range.duration) - reel) > 1e-6 { track.scaleTimeRange(inserted, toDuration: seconds(reel * CMTimeGetSeconds(range.duration) / max(1e-9, from))) }
    }
}
/// AV4: a source span as the file holds it: cut to the track's own time range (an edit can name a span a frame past a
/// file's end; AVFoundation refuses the whole composition then: -11800, -12780, while the viewer's decoder just stops at
/// the last frame). Nil when less than a tick is left.
func sourceRange(_ source: AVAssetTrack, start: Double, duration: Double) -> CMTimeRange? {
    let range = CMTimeRange(start: seconds(start), duration: seconds(duration)).intersection(source.timeRange)
    return range.duration.value > 0 && range.duration.timescale > 0 && CMTimeGetSeconds(range.duration) > 0 ? range : nil
}
/// True when a clock is plain 1x from its first key (nothing to scale).
func plainClock(_ keys: [TimeKey]?) -> Bool {
    guard let keys, keys.count >= 2 else { return true }
    return zip(keys, keys.dropFirst()).allSatisfy { abs(($1.s - $0.s) - ($1.t - $0.t)) < 1e-6 }
}

// MARK: AV4 layers

/// One moment of a picture layer: the keys interpolated (every key is a moment the viewer's own functions were sampled
/// at, every knot included, so the straight line between two keys is the viewer's number).
struct LayerValues {
    var rect: [Double]?; var region: [Double]?; var opacity: Double; var shape: Double
    var blur: [Double]; var radius: Double; var pixels: [Double]
}

/// AV4: which pictures the edit draws at each moment and where each sits in the composed picture. The composition's
/// picture is a column of tiles, each the size of the output: tile k holds the k-th picture of the moment (in the
/// viewer's draw order) framed into its layout region, and a picture with the viewer's screen background also has a
/// tile of itself fitted to the whole frame (the backdrop's source). The presenter draws the Look and the layout on
/// them at display time (AppleLookRenderer.encodeFrame). Built from the manifest alone, so the compositor and the
/// presenter build the same one.
final class PictureLayout {
    struct Tile { let seg: Int; let backdrop: Bool }
    struct Span { let start: Double; let end: Double; let tiles: [Tile] }
    let width: Int; let height: Int
    let segs: [VideoSeg]
    let spans: [Span]
    let tileCount: Int
    /// The composition track each segment plays from (set by the builder).
    var trackIDs: [CMPersistentTrackID] = []

    init(_ manifest: Manifest) {
        width = max(1, Int(manifest.width.rounded())); height = max(1, Int(manifest.height.rounded()))
        segs = manifest.video
        var cuts = Set<Double>([0, manifest.durationS])
        for seg in manifest.video { cuts.insert(seg.timelineStart); cuts.insert(seg.timelineEnd) }
        // Edges closer than half a millisecond are one edge (an edit's rounding leaves pieces a few microseconds apart;
        // a span between them would have no picture: a black frame if one landed there).
        var times = cuts.sorted().reduce(into: [Double]()) { list, t in if let last = list.last, t - last < 0.0005 { return }; list.append(t) }
        // The last edge is the latest end exactly: instructions must reach the end of every track (AVFoundation fails an
        // item whose video composition stops short of its duration: -11800, -12780).
        if let end = cuts.max(), let last = times.last, end > last { times[times.count - 1] = end }
        var made: [Span] = []
        for (a, b) in zip(times, times.dropFirst()) {
            let active = manifest.video.indices.filter { manifest.video[$0].timelineStart <= a + 0.0005 && manifest.video[$0].timelineEnd >= b - 0.0005 && PictureLayout.lasts(manifest.video[$0]) }
            // The viewer's draw order: its layout order (the lane), then the later piece on top (a dissolve).
            let ordered = active.sorted { (x, y) in
                let ox = manifest.video[x].visual?.order ?? Double(manifest.video[x].layer ?? 0), oy = manifest.video[y].visual?.order ?? Double(manifest.video[y].layer ?? 0)
                return ox != oy ? ox < oy : manifest.video[x].timelineStart != manifest.video[y].timelineStart ? manifest.video[x].timelineStart < manifest.video[y].timelineStart : x < y
            }
            var tiles: [Tile] = []
            for index in ordered {
                tiles.append(Tile(seg: index, backdrop: false))
                if manifest.video[index].visual?.background?.kind == 1 { tiles.append(Tile(seg: index, backdrop: true)) }
            }
            made.append(Span(start: a, end: b, tiles: tiles))
        }
        spans = made
        tileCount = max(1, made.map { $0.tiles.count }.max() ?? 1)
    }

    /// A segment long enough to compose (an empty time range is refused by AVFoundation: -12780).
    static func lasts(_ seg: VideoSeg) -> Bool { seg.timelineEnd - seg.timelineStart >= 0.0001 }
    /// The span showing at reel `t` (its start included).
    func spanIndex(at t: Double) -> Int? {
        var lo = 0, hi = spans.count - 1, found: Int? = nil
        while lo <= hi { let mid = (lo + hi) / 2; if spans[mid].start <= t + 1e-6 { found = mid; lo = mid + 1 } else { hi = mid - 1 } }
        return found
    }

    /// A segment's numbers at reel `t`. An older plan without layer keys frames its crop over the whole frame.
    func values(_ seg: Int, at t: Double) -> LayerValues {
        let s = segs[seg]
        guard let keys = s.visual?.keys, let first = keys.first else {
            let c = s.crop
            return LayerValues(rect: c.map { [$0.x, $0.y, $0.w, $0.h] } ?? [0, 0, 1, 1], region: nil, opacity: 1, shape: 1, blur: [0, 0], radius: 0, pixels: [960, 960 * Double(height) / Double(width)])
        }
        let after = keys.firstIndex { $0.t > t } ?? keys.count
        if after == 0 || keys.count == 1 { return Self.make(first) }
        if after >= keys.count { return Self.make(keys[keys.count - 1]) }
        let a = keys[after - 1], b = keys[after], u = max(0, min(1, (t - a.t) / max(1e-9, b.t - a.t)))
        func lerp(_ x: [Double]?, _ y: [Double]?) -> [Double]? {
            guard let x else { return nil }
            guard let y, y.count == x.count else { return x }
            return zip(x, y).map { $0 + ($1 - $0) * u }
        }
        return LayerValues(rect: lerp(a.rect, b.rect), region: lerp(a.region, b.region), opacity: a.opacity + (b.opacity - a.opacity) * u, shape: a.shape + (b.shape - a.shape) * u,
                           blur: lerp(a.blur, b.blur) ?? [0, 0], radius: a.radius + (b.radius - a.radius) * u, pixels: lerp(a.pixels, b.pixels) ?? a.pixels)
    }
    private static func make(_ k: LayerKey) -> LayerValues {
        LayerValues(rect: k.rect, region: k.region, opacity: k.opacity, shape: k.shape, blur: k.blur, radius: k.radius, pixels: k.pixels)
    }

    /// The layer's viewport in output pixels (x, y, w, h from the top left), rounded as the viewer's gl.viewport is.
    func box(_ v: LayerValues) -> (x: Int, y: Int, w: Int, h: Int) {
        guard let r = v.region, r.count == 4 else { return (0, 0, width, height) }
        let W = Double(width), H = Double(height)
        return (Int((W * r[0]).rounded()), Int((H * r[1]).rounded()), Int((W * r[2]).rounded()), Int((H * r[3]).rounded()))
    }

    /// Tile pixels (output pixels in the tile, top left, pixel centres at +0.5) to source pixels, as the viewer's
    /// pictureAt reads its texture: the framing rect (or the fit, or the backdrop's centred fit) over the viewport,
    /// through the picture's quarter turn (LivePlayer turned()). Rows of a 2x3 matrix: s = m0 * x + m1 * y + m2.
    func sourceMap(_ seg: Int, _ v: LayerValues, backdrop: Bool, sourceWidth: Double, sourceHeight: Double) -> (m0: SIMD2<Double>, m1: SIMD2<Double>, m2: SIMD2<Double>) {
        let s = segs[seg], plan = s.visual
        let turn = ((plan?.turn ?? Int(s.rotation)) % 360 + 360) % 360
        let natural = sourceWidth / max(1, sourceHeight), aspect = turn % 180 != 0 ? 1 / natural : natural
        let W = Double(width), H = Double(height)
        let b = backdrop ? (x: 0, y: 0, w: width, h: height) : box(v)
        let bx = Double(b.x), by = Double(b.y), bw = Double(max(1, b.w)), bh = Double(max(1, b.h))
        let region = v.region ?? [0, 0, 1, 1]
        let target = backdrop ? W / H : region[2] * W / max(1e-9, region[3] * H)
        // q = q0 + qd * (p - box origin), per axis, in the turned picture's 0..1 coordinates.
        var q0 = SIMD2<Double>(0, 0), qd = SIMD2<Double>(1 / bw, 1 / bh)
        if backdrop {
            let h = min(1, aspect / (W / H)), w = h * (W / H) / aspect
            q0 = SIMD2((1 - w) / 2, (1 - h) / 2); qd = SIMD2(w / bw, h / bh)
        } else if plan?.framing == "centre" {
            let w = min(1, target / aspect), h = min(1, aspect / target)
            q0 = SIMD2((1 - w) / 2, (1 - h) / 2); qd = SIMD2(w / bw, h / bh)
        } else if let r = v.rect, r.count == 4 {
            q0 = SIMD2(r[0], r[1]); qd = SIMD2(r[2] / bw, r[3] / bh)
        } else {
            // Fitted: the whole picture inside the viewport (LivePlayer pictureAt, fitted).
            let fit = aspect > target ? SIMD2<Double>(1, target / aspect) : SIMD2<Double>(aspect / target, 1)
            q0 = SIMD2(0.5 - 0.5 / fit.x, 0.5 - 0.5 / fit.y); qd = SIMD2(1 / (bw * fit.x), 1 / (bh * fit.y))
        }
        // q(p) = a + d * p per axis, with the box origin taken out.
        let ax = q0.x - qd.x * bx, ay = q0.y - qd.y * by
        // The quarter turn: normalised source = turned(q).
        var m0 = SIMD2<Double>(0, 0), m1 = SIMD2<Double>(0, 0), m2 = SIMD2<Double>(0, 0)
        switch turn {
        case 90: m1 = SIMD2(qd.y, 0); m0 = SIMD2(0, -qd.x); m2 = SIMD2(ay, 1 - ax)
        case 180: m0 = SIMD2(-qd.x, 0); m1 = SIMD2(0, -qd.y); m2 = SIMD2(1 - ax, 1 - ay)
        case 270: m1 = SIMD2(-qd.y, 0); m0 = SIMD2(0, qd.x); m2 = SIMD2(1 - ay, ax)
        default: m0 = SIMD2(qd.x, 0); m1 = SIMD2(0, qd.y); m2 = SIMD2(ax, ay)
        }
        let size = SIMD2(sourceWidth, sourceHeight)
        return (m0 * size, m1 * size, m2 * size)
    }

    /// True when the moment is one whole frame picture with nothing of the layout on it: the presenter's plain path
    /// (AV2 and AV3's renderer, unchanged), reading tile 0.
    func plain(_ span: Int, at t: Double) -> Bool {
        guard span < spans.count, spans[span].tiles.count == 1, let tile = spans[span].tiles.first, !tile.backdrop else { return spans.indices.contains(span) && spans[span].tiles.isEmpty }
        let v = values(tile.seg, at: t), plan = segs[tile.seg].visual
        let full = v.region.map { abs($0[0]) < 1e-9 && abs($0[1]) < 1e-9 && abs($0[2] - 1) < 1e-9 && abs($0[3] - 1) < 1e-9 } ?? true
        return full && v.opacity * v.shape >= 0.9999 && v.blur.allSatisfy { abs($0) < 1e-12 } && v.radius <= 0 && !(plan?.circle ?? false) && !(plan?.dim ?? false) && plan?.background == nil
    }
}

/// AV4: a span of the edit for the compositor: which segments' pictures it frames into which tiles.
final class TileInstruction: NSObject, AVVideoCompositionInstructionProtocol {
    let timeRange: CMTimeRange
    let enablePostProcessing = false
    let containsTweening = true
    let requiredSourceTrackIDs: [NSValue]?
    let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
    let layout: PictureLayout
    let span: Int
    init(timeRange: CMTimeRange, layout: PictureLayout, span: Int) {
        self.timeRange = timeRange; self.layout = layout; self.span = span
        let ids = Set(layout.spans[span].tiles.map { layout.trackIDs[$0.seg] })
        requiredSourceTrackIDs = ids.isEmpty ? nil : ids.sorted().map { NSNumber(value: $0) }
    }
}

/// One composition, its video composition (crop and rotation) and its audio mix.
func buildComposition(_ manifest: Manifest) throws -> BuiltComposition {
    let composition = AVMutableComposition()
    let layout = PictureLayout(manifest)
    // AV4: one track per picture showing at once (a layout's pictures, a dissolve's two, the overlay lane): each
    // segment goes on the lowest track free at its start.
    var tracks: [(track: AVMutableCompositionTrack, end: Double)] = []
    func newTrack() throws -> AVMutableCompositionTrack {
        guard let made = composition.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid) else { throw CompositionError.message("no video track") }
        // One fine clock for the picture track, so no file's frame times are moved onto a coarser one (measured: with a
        // mixed 25p, 30p and 59.94p edit, pictures sat up to 7 ms off their files' own times).
        made.naturalTimeScale = compositionTimescale
        return made
    }
    tracks.append((try newTrack(), 0))
    var trackOf = [CMPersistentTrackID](repeating: kCMPersistentTrackID_Invalid, count: manifest.video.count)
    for (index, seg) in manifest.video.enumerated().sorted(by: { $0.element.timelineStart < $1.element.timelineStart }) where PictureLayout.lasts(seg) {
        guard let source = AppleAssets.shared.track(seg.file, .video) else { throw CompositionError.message("no video in \(seg.file)") }
        var k = tracks.firstIndex { $0.end <= seg.timelineStart + 1e-6 }
        if k == nil { tracks.append((try newTrack(), 0)); k = tracks.count - 1 }
        let videoTrack = tracks[k!].track
        if let keys = seg.timeMap, !plainClock(keys) {
            // A held picture is one of the file's own frames long (its nominal rate), never a fraction of one.
            let rate = Double(source.nominalFrameRate)
            try composeClock(videoTrack, source: source, keys: keys, hold: rate > 1 ? 1 / rate : 1.0 / 30)
        } else if let range = sourceRange(source, start: seg.sourceStart, duration: seg.sourceEnd - seg.sourceStart) {
            try videoTrack.insertTimeRange(range, of: source, at: seconds(seg.timelineStart))
        }
        tracks[k!].end = seg.timelineEnd
        trackOf[index] = videoTrack.trackID
    }
    layout.trackIDs = trackOf
    var audioParams: [AVMutableAudioMixInputParameters] = []
    var audioKinds: [String] = []
    for seg in manifest.audio {
        guard let source = AppleAssets.shared.track(seg.file, .audio) else { throw CompositionError.message("no audio in \(seg.file)") }
        guard let track = composition.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else { continue }
        let duration = seg.timelineEnd - seg.timelineStart
        if let keys = seg.timeMap, !plainClock(keys) {
            // AV3: speed on sound, the same clock as its picture; a held stretch is silent (nothing inserted).
            for (a, b) in zip(keys, keys.dropFirst()) where b.t - a.t > 1e-6 && b.s - a.s > 1e-6 {
                guard let range = sourceRange(source, start: a.s, duration: b.s - a.s) else { continue }
                let got = CMTimeGetSeconds(range.duration)
                try track.insertTimeRange(range, of: source, at: seconds(a.t))
                if abs(got - (b.t - a.t)) > 1e-6 { track.scaleTimeRange(CMTimeRange(start: seconds(a.t), duration: range.duration), toDuration: seconds((b.t - a.t) * got / (b.s - a.s))) }
            }
        } else if seg.loop == true {
            // Fill the span with the file, wrapping at its end, from the looped offset.
            let fileLength = CMTimeGetSeconds(source.timeRange.duration)
            guard fileLength > 0.01 else { throw CompositionError.message("empty loop \(seg.file)") }
            var at = 0.0
            var offset = seg.sourceStart.truncatingRemainder(dividingBy: fileLength)
            while at < duration - 0.0005 {
                let take = min(fileLength - offset, duration - at)
                if take > 0.0005 { try track.insertTimeRange(CMTimeRange(start: seconds(offset), duration: seconds(take)), of: source, at: seconds(seg.timelineStart + at)) }
                at += take; offset = 0
            }
        } else {
            if let range = sourceRange(source, start: seg.sourceStart, duration: min(seg.sourceEnd - seg.sourceStart, duration)) {
                try track.insertTimeRange(range, of: source, at: seconds(seg.timelineStart))
            }
        }
        let params = AVMutableAudioMixInputParameters(track: track)
        let base = gainLinear(seg.gainDb)
        let start = seconds(seg.timelineStart), end = seconds(seg.timelineEnd)
        if let keys = seg.volumeKeys, !keys.isEmpty {
            var last = start
            var lastGain = base * Float(keys[0].gain)
            params.setVolume(lastGain, at: start)
            for key in keys {
                let at = seconds(seg.timelineStart + key.t)
                let gain = base * Float(key.gain)
                if at > last { params.setVolumeRamp(fromStartVolume: lastGain, toEndVolume: gain, timeRange: CMTimeRange(start: last, duration: at - last)); last = at; lastGain = gain }
            }
            if end > last { params.setVolume(base * Float(keys.last?.gain ?? 1), at: last) }
        } else if let fadeIn = seg.fadeInS, fadeIn > 0 {
            params.setVolumeRamp(fromStartVolume: 0, toEndVolume: base, timeRange: CMTimeRange(start: start, duration: seconds(fadeIn)))
            if let fadeOut = seg.fadeOutS, fadeOut > 0 {
                params.setVolumeRamp(fromStartVolume: base, toEndVolume: 0, timeRange: CMTimeRange(start: seconds(seg.timelineEnd - fadeOut), duration: seconds(fadeOut)))
            } else { params.setVolume(base, at: seconds(seg.timelineStart + fadeIn)) }
        } else if let fadeOut = seg.fadeOutS, fadeOut > 0 {
            params.setVolume(base, at: start)
            params.setVolumeRamp(fromStartVolume: base, toEndVolume: 0, timeRange: CMTimeRange(start: seconds(seg.timelineEnd - fadeOut), duration: seconds(fadeOut)))
        } else {
            params.setVolume(base, at: start)
        }
        audioParams.append(params)
        audioKinds.append(seg.kind)
    }
    // AV4: every picture is framed by the compositor (PictureCompositor) into its tile, span by span; gaps are spans
    // with no tiles (black). The picture is a column of tiles, one output frame each.
    let vc = AVMutableVideoComposition()
    vc.customVideoCompositorClass = PictureCompositor.self
    vc.renderSize = CGSize(width: Double(layout.width), height: Double(layout.height * layout.tileCount))
    vc.frameDuration = CMTime(seconds: 1 / max(1, manifest.fps), preferredTimescale: compositionTimescale)
    if let first = tracks.first?.track { vc.sourceTrackIDForFrameTiming = first.trackID }
    var instructions: [AVVideoCompositionInstructionProtocol] = []
    // The last instruction runs to the end of the composition as built (a track can end a timescale tick past the plan).
    let edges = layout.spans.map { seconds($0.start) } + [CMTimeMaximum(seconds(layout.spans.last?.end ?? manifest.durationS), composition.duration)]
    for (index, _) in layout.spans.enumerated() where edges[index + 1] > edges[index] {
        instructions.append(TileInstruction(timeRange: CMTimeRange(start: edges[index], end: edges[index + 1]), layout: layout, span: index))
    }
    vc.instructions = instructions
    let videoComposition: AVMutableVideoComposition? = manifest.video.isEmpty ? nil : vc
    var audioMix: AVMutableAudioMix? = nil
    if !audioParams.isEmpty { let mix = AVMutableAudioMix(); mix.inputParameters = audioParams; audioMix = mix }
    return BuiltComposition(composition: composition, videoComposition: videoComposition, audioMix: audioMix, audioKinds: audioKinds, layout: layout)
}

/// Some framed edits are more than AVFoundation will compose. True when the first framed frame renders.
func firstFramedFrameRenders(_ built: BuiltComposition) -> Bool {
    guard let videoComposition = built.videoComposition else { return true }
    guard let reader = try? AVAssetReader(asset: built.composition) else { return false }
    let output = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video), videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.videoComposition = videoComposition
    guard reader.canAdd(output) else { return false }
    reader.add(output)
    let renders = reader.startReading() && output.copyNextSampleBuffer() != nil
    reader.cancelReading()
    return renders
}
