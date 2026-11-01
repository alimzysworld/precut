// TRK1: follow one picked thing through a source span with Vision, both directions from the pick frame. Measurements only.
// track <source> <s> <e> <pickS> <object|plane> <pick JSON> [longSide]
// pick JSON: {"x","y","w","h"} (a box) or {"corners":[[x,y],[x,y],[x,y],[x,y]]} (TL, TR, BR, BL); top-left normalised,
// in the file's oriented picture. object = VNTrackObjectRequest; plane = frame-to-frame homography inside the quad,
// held to the quad's border by patches matched against a key frame (TRK2).
// One line per frame, forward from the pick frame then backward from it:
// {t, b:[x,y,w,h], c, q?:[8 corner numbers], a?: area ratio to the previous frame, k?: 1 when the border held it,
// e?: why the tracker gave up}
// then {done, frames, seconds, fps, width, height, rate, pickT}. A direction stops once its thing is gone.
import Foundation
import AVFoundation
import Vision
import CoreImage

struct TrackError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct Pick: Decodable { let x: Double?; let y: Double?; let w: Double?; let h: Double?; let corners: [[Double]]? }

func emit(_ row: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}
func r5(_ v: CGFloat) -> Double { (Double(v) * 1e5).rounded() / 1e5 }
// Vision is bottom-left normalised; precut placement is top-left normalised.
func topLeft(_ b: CGRect) -> [Double] { [r5(b.minX), r5(1 - b.maxY), r5(b.width), r5(b.height)] }
func area(_ p: [CGPoint]) -> CGFloat {
    var s: CGFloat = 0
    for i in 0..<4 { let j = (i + 1) % 4; s += p[i].x * p[j].y - p[j].x * p[i].y }
    return abs(s) / 2
}

protocol Follower: AnyObject {
    var gone: Bool { get }
    func step(_ pixels: CVPixelBuffer, _ row: inout [String: Any])
}

final class ObjectFollower: Follower {
    let handler = VNSequenceRequestHandler()
    var observation: VNDetectedObjectObservation
    var gone = false
    init(_ rect: CGRect) { observation = VNDetectedObjectObservation(boundingBox: rect) }
    func step(_ pixels: CVPixelBuffer, _ row: inout [String: Any]) {
        let request = VNTrackObjectRequest(detectedObjectObservation: observation)
        request.trackingLevel = .accurate
        do {
            try handler.perform([request], on: pixels, orientation: .up)
            guard let result = request.results?.first as? VNDetectedObjectObservation else { throw TrackError(message: "no result") }
            observation = result
            row["b"] = topLeft(result.boundingBox); row["c"] = r5(CGFloat(result.confidence))
        } catch {
            // Vision throws once the box collapses (the thing left the frame): a loss, not a crash.
            gone = true; row["c"] = 0; row["e"] = error.localizedDescription
        }
    }
}

// ---- TRK2: plane geometry and patch matching in top-left pixels (the picture's rows go down)
/// Least-squares projective map from points to points (h22 = 1), or nil when they don't pin one down.
func fitHomography(_ from: [SIMD2<Double>], _ to: [SIMD2<Double>]) -> [Double]? {
    var ata = [[Double]](repeating: [Double](repeating: 0, count: 9), count: 8)
    for i in 0..<from.count {
        let x = from[i].x, y = from[i].y, u = to[i].x, v = to[i].y
        for r in [[x, y, 1, 0, 0, 0, -u * x, -u * y, u], [0, 0, 0, x, y, 1, -v * x, -v * y, v]] {
            for j in 0..<8 { for k in 0..<9 { ata[j][k] += r[j] * r[k] } }
        }
    }
    for c in 0..<8 {
        var p = c
        for r in (c + 1)..<8 where abs(ata[r][c]) > abs(ata[p][c]) { p = r }
        ata.swapAt(c, p)
        let d = ata[c][c]
        if abs(d) < 1e-12 { return nil }
        for k in c..<9 { ata[c][k] /= d }
        for r in 0..<8 where r != c && ata[r][c] != 0 { let f = ata[r][c]; for k in c..<9 { ata[r][k] -= f * ata[c][k] } }
    }
    return ata.map { $0[8] } + [1]
}
func applyH(_ m: [Double], _ p: SIMD2<Double>) -> SIMD2<Double> {
    let w = m[6] * p.x + m[7] * p.y + m[8]
    return SIMD2((m[0] * p.x + m[1] * p.y + m[2]) / w, (m[3] * p.x + m[4] * p.y + m[5]) / w)
}
struct Gray {
    let w: Int, h: Int, v: [Float]
    init(_ pixels: CVPixelBuffer) {
        CVPixelBufferLockBaseAddress(pixels, .readOnly); defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
        w = CVPixelBufferGetWidth(pixels); h = CVPixelBufferGetHeight(pixels)
        let stride = CVPixelBufferGetBytesPerRow(pixels), base = CVPixelBufferGetBaseAddress(pixels)!.assumingMemoryBound(to: UInt8.self)
        var out = [Float](repeating: 0, count: w * h)
        for y in 0..<h { let row = base + y * stride; for x in 0..<w { let q = row + x * 4; out[y * w + x] = 0.114 * Float(q[0]) + 0.587 * Float(q[1]) + 0.299 * Float(q[2]) } }
        v = out
    }
    func at(_ x: Double, _ y: Double) -> Float {
        let x0 = Int(floor(x)), y0 = Int(floor(y))
        guard x0 >= 0, y0 >= 0, x0 + 1 < w, y0 + 1 < h else { return -1 }
        let fx = Float(x - Double(x0)), fy = Float(y - Double(y0)), i = y0 * w + x0
        return (v[i] * (1 - fx) + v[i + 1] * fx) * (1 - fy) + (v[i + w] * (1 - fx) + v[i + w + 1] * fx) * fy
    }
}

final class PlaneFollower: Follower {
    var quad: [CGPoint]   // bottom-left normalised, TL, TR, BR, BL
    var previous: CIImage?
    var gone = false
    let size: CGSize
    // TRK2: what is on a screen moves on its own (a chat scrolls, an app slides in), and frame-to-frame registration of
    // the whole quad follows it, so the surface drifts off the thing (30 to 50 px over a few seconds on TRK0's phone).
    // The quad is held to its edges instead: patches along its border (the bezel, the case, the status bar) matched
    // against a key frame warped by the predicted plane, so nothing adds up from frame to frame. The chained
    // registration only predicts. When too few patches agree (covered, blurred, an app sliding in), the prediction
    // stands and the next frames look further for the border. Two keys: the pick frame, kept for good (the bezel and
    // status bar look the same whatever the screen shows, so the quad can always come back to them), and a recent
    // confirmed frame (the phone tilts and the light changes). An unconfirmed quad never becomes a key: it would hold
    // the error for good (31 Oct: an app switch on TRK0's phone grew the quad 110 px and every later frame kept it).
    var pickKey: Gray?
    var pickQuad: [SIMD2<Double>] = []
    var key: Gray?
    var keyQuad: [SIMD2<Double>] = []
    var held = 0
    var misses = 0
    var lastArea = 0.0
    var velocity: [SIMD2<Double>] = Array(repeating: SIMD2(0, 0), count: 4)
    // On the rim (just outside the quad: the bezel and the case, and on it), and the status bar along the top: what
    // stays put while the screen's content changes.
    static let border: [SIMD2<Double>] = {
        var p: [SIMD2<Double>] = []
        for e in [-0.03, 0.0] { for k in 0..<4 { let t = 0.05 + 0.9 * Double(k) / 4; p += [SIMD2(t, e), SIMD2(1 - e, t), SIMD2(1 - t, 1 - e), SIMD2(e, 1 - t)] } }
        for k in 0..<4 { p.append(SIMD2(0.12 + 0.76 * Double(k) / 3, 0.04)) }
        return p
    }()
    init(_ quad: [CGPoint], _ size: CGSize) { self.quad = quad; self.size = size }
    func pixels(_ q: [CGPoint]) -> [SIMD2<Double>] { q.map { SIMD2(Double($0.x * size.width), Double((1 - $0.y) * size.height)) } }
    func points(_ p: [SIMD2<Double>]) -> [CGPoint] { p.map { CGPoint(x: $0.x / Double(size.width), y: 1 - $0.y / Double(size.height)) } }
    static let unit: [SIMD2<Double>] = [SIMD2(0, 0), SIMD2(1, 0), SIMD2(1, 1), SIMD2(0, 1)]
    /// The predicted quad (pixels) moved onto a key frame's border, or nil when too few patches agree. far: the last
    /// frames were unconfirmed, so look twice as far and let the size come back towards the last confirmed one.
    func refine(_ frame: Gray, _ predicted: [SIMD2<Double>], _ key: Gray?, _ keyQuad: [SIMD2<Double>], far: Bool) -> [SIMD2<Double>]? {
        guard let key, keyQuad.count == 4, let toPredicted = fitHomography(Self.unit, predicted), let back = fitHomography(predicted, keyQuad) else { return nil }
        let side = min(hypot(predicted[1].x - predicted[0].x, predicted[1].y - predicted[0].y), hypot(predicted[3].x - predicted[0].x, predicted[3].y - predicted[0].y))
        let half = max(8, Int(side * 0.06)), reach = max(8, Int(side * (far ? 0.16 : 0.08)))
        var found: [(SIMD2<Double>, SIMD2<Double>)] = []
        for uv in Self.border {
            let c = applyH(toPredicted, uv), cx = Int(c.x.rounded()), cy = Int(c.y.rounded())
            // The key frame seen through the predicted plane, around this point: the template.
            var tpl = [Float](), ok = true
            for y in -half..<half { for x in -half..<half { let k = applyH(back, SIMD2(Double(cx + x), Double(cy + y))), g = key.at(k.x, k.y); if g < 0 { ok = false }; tpl.append(g) } }
            if !ok || cx - half - reach - 2 < 0 || cy - half - reach - 2 < 0 || cx + half + reach + 2 >= frame.w || cy + half + reach + 2 >= frame.h { continue }
            let n = Float(tpl.count), mean = tpl.reduce(0, +) / n
            for i in tpl.indices { tpl[i] -= mean }
            let energy = tpl.reduce(0) { $0 + $1 * $1 }
            if energy < n * 9 { continue }   // a flat patch says nothing
            // Normalised cross-correlation with the template, on every s-th pixel each way (2 for the coarse pass).
            let side2 = 2 * half
            func score(_ dx: Int, _ dy: Int, _ s: Int = 1) -> Float {
                var sum: Float = 0, sq: Float = 0, cross: Float = 0, tsum: Float = 0, tsq: Float = 0, m: Float = 0
                for y in stride(from: -half, to: half, by: s) {
                    let row = (cy + dy + y) * frame.w + cx + dx, trow = (y + half) * side2 + half
                    for x in stride(from: -half, to: half, by: s) { let g = frame.v[row + x], t = tpl[trow + x]; sum += g; sq += g * g; cross += g * t; tsum += t; tsq += t * t; m += 1 }
                }
                let variance = sq - sum * sum / m, tvar = tsq - tsum * tsum / m
                return variance > 1 && tvar > 1 ? (cross - sum * tsum / m) / sqrt(variance * tvar) : 0
            }
            // Coarse on a grid (every 2nd pixel of the patch), then every place around the best at full detail.
            let grid = 2
            // The three best coarse places (a blurred frame can put the true one second), each looked at closely.
            var top: [(Int, Int, Float)] = []
            for dy in stride(from: -reach, through: reach, by: grid) { for dx in stride(from: -reach, through: reach, by: grid) {
                let v = score(dx, dy, 2)
                if top.count < 3 || v > top[2].2 { top.append((dx, dy, v)); top.sort { $0.2 > $1.2 }; if top.count > 3 { top.removeLast() } }
            } }
            var best = (0, 0, Float(-2))
            for coarse in top { for dy in (coarse.1 - grid)...(coarse.1 + grid) { for dx in (coarse.0 - grid)...(coarse.0 + grid) where abs(dx) <= reach + 1 && abs(dy) <= reach + 1 { let v = score(dx, dy); if v > best.2 { best = (dx, dy, v) } } } }
            if best.2 < 0.6 || abs(best.0) > reach || abs(best.1) > reach { continue }
            let l = score(best.0 - 1, best.1), r = score(best.0 + 1, best.1), u = score(best.0, best.1 - 1), d = score(best.0, best.1 + 1)
            func sub(_ a: Float, _ c: Float, _ b: Float) -> Double { let d = a - 2 * c + b; return d < -1e-6 ? Double(max(-0.5, min(0.5, (a - b) / (2 * d)))) : 0 }
            let sx = sub(l, best.2, r), sy = sub(u, best.2, d)
            found.append((SIMD2(Double(cx), Double(cy)), SIMD2(Double(cx + best.0) + sx, Double(cy + best.1) + sy)))
        }
        guard found.count >= 6 else { return nil }
        // The largest set of patches one plane explains (a deterministic sample of fours), then fit on them: what scrolls
        // on the screen, a thumb or a reflection moves differently and is left out.
        var bestKept: [(SIMD2<Double>, SIMD2<Double>)] = [], seed: UInt64 = 0x9E3779B97F4A7C15
        func next(_ n: Int) -> Int { seed = seed &* 6364136223846793005 &+ 1442695040888963407; return Int((seed >> 33) % UInt64(n)) }
        for _ in 0..<160 {
            var pick = Set<Int>(); while pick.count < 4 { pick.insert(next(found.count)) }
            let four = pick.map { found[$0] }
            guard let m = fitHomography(four.map { $0.0 }, four.map { $0.1 }) else { continue }
            let kept = found.filter { let p = applyH(m, $0.0); return hypot(p.x - $0.1.x, p.y - $0.1.y) < 1.5 }
            if kept.count > bestKept.count { bestKept = kept }
        }
        guard bestKept.count >= 8, let fix = fitHomography(bestKept.map { $0.0 }, bestKept.map { $0.1 }) else { return nil }
        let held = predicted.map { applyH(fix, $0) }
        // A correction that grows, shrinks or bends the surface is a wrong match, not the thing: keep the prediction.
        func size(_ q: [SIMD2<Double>]) -> Double { var s = 0.0; for i in 0..<4 { let j = (i + 1) % 4; s += q[i].x * q[j].y - q[j].x * q[i].y }; return abs(s) / 2 }
        let change = size(held) / max(size(predicted), 1e-9), back2 = lastArea > 0 ? size(held) / lastArea : 1
        let plausible = (change > 0.97 && change < 1.03) || (far && back2 > 0.9 && back2 < 1.1 && abs(back2 - 1) < abs(size(predicted) / max(lastArea, 1e-9) - 1))
        if !plausible || zip(held, predicted).contains(where: { hypot($0.x - $1.x, $0.y - $1.y) > Double(reach) * 1.5 }) { return nil }
        return held
    }
    func step(_ pixels: CVPixelBuffer, _ row: inout [String: Any]) {
        let W = size.width, H = size.height, current = CIImage(cvPixelBuffer: pixels)
        defer { previous = current }
        row["c"] = 1
        let gray = Gray(pixels)
        guard let prev = previous else {
            key = gray; keyQuad = self.pixels(quad); pickKey = gray; pickQuad = keyQuad; lastArea = sizeOf(keyQuad)
            emitQuad(&row); return
        }
        let xs = quad.map { $0.x * W }, ys = quad.map { $0.y * H }
        var region = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
        region = region.insetBy(dx: -region.width * 0.1, dy: -region.height * 0.1).integral.intersection(CGRect(origin: .zero, size: size))
        if region.isNull || region.width < 16 || region.height < 16 { gone = true; row["c"] = 0; row["e"] = "left frame"; return }
        let shift = CGAffineTransform(translationX: -region.minX, y: -region.minY)
        let a = prev.cropped(to: region).transformed(by: shift), b = current.cropped(to: region).transformed(by: shift)
        let request = VNHomographicImageRegistrationRequest(targetedCIImage: a, options: [:])
        do {
            try VNImageRequestHandler(ciImage: b, options: [:]).perform([request])
            guard let observation = request.results?.first as? VNImageHomographicAlignmentObservation else { throw TrackError(message: "no registration") }
            let m = observation.warpTransform
            let moved: [CGPoint] = quad.map { q in
                let v = m * SIMD3<Float>(Float(q.x * W - region.minX), Float(q.y * H - region.minY), 1)
                return CGPoint(x: (CGFloat(v.x / v.z) + region.minX) / W, y: (CGFloat(v.y / v.z) + region.minY) / H)
            }
            // A flat thing cannot change area by 30% in one frame: keep the last quad and say so.
            let ratio = area(moved) / max(area(quad), 1e-9)
            row["a"] = r5(ratio)
            if ratio.isFinite && ratio > 0.7 && ratio < 1.3 {
                let was = self.pixels(quad), far = misses > 0
                let tries = [self.pixels(moved), was]
                var found: [SIMD2<Double>]? = nil
                for (k, kq) in [(key, keyQuad), (pickKey, pickQuad)] { for p in tries where found == nil { found = refine(gray, p, k, kq, far: far) } }
                if let held = found {
                    velocity = zip(held, was).map { $0 - $1 }; quad = points(held); misses = 0; row["k"] = 1
                    lastArea = sizeOf(held); self.held += 1
                    // A recent key every dozen confirmed frames, for the tilt and the light.
                    if self.held % 12 == 0 { key = gray; keyQuad = held }
                } else {
                    // Unconfirmed: carry on at half the last confirmed move (what slides on the screen is no guide).
                    velocity = velocity.map { $0 * 0.5 }
                    quad = points(zip(was, velocity).map { $0 + $1 }); misses += 1
                    // A second without its border (25 frames): it is gone, and following on only costs time.
                    if misses >= 25 { gone = true; row["c"] = 0; row["e"] = "lost" }
                }
            } else { row["c"] = 0; row["e"] = "implausible jump" }
        } catch { row["c"] = 0; row["e"] = error.localizedDescription }
        emitQuad(&row)
    }
    func sizeOf(_ q: [SIMD2<Double>]) -> Double { var s = 0.0; for i in 0..<4 { let j = (i + 1) % 4; s += q[i].x * q[j].y - q[j].x * q[i].y }; return abs(s) / 2 }
    func emitQuad(_ row: inout [String: Any]) {
        let xs = quad.map { $0.x }, ys = quad.map { $0.y }
        row["b"] = topLeft(CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!))
        row["q"] = quad.flatMap { [r5($0.x), r5(1 - $0.y)] }
    }
}

func run() throws {
    let args = CommandLine.arguments
    guard args.count >= 7, let s = Double(args[2]), let e = Double(args[3]), let pickS = Double(args[4]),
          s >= 0, e > s, pickS >= s, pickS <= e, ["object", "plane"].contains(args[5]) else {
        throw TrackError(message: "usage: track source s e pickS object|plane pick-JSON [longSide]")
    }
    let mode = args[5]
    let pick = try JSONDecoder().decode(Pick.self, from: Data(args[6].utf8))
    let inside = { (v: Double) in v.isFinite && v >= -1e-6 && v <= 1 + 1e-6 }
    // quad in bottom-left normalised coordinates, TL, TR, BR, BL.
    var quad: [CGPoint]
    if let corners = pick.corners {
        guard corners.count == 4, corners.allSatisfy({ $0.count == 2 && inside($0[0]) && inside($0[1]) }) else { throw TrackError(message: "corners must be four points inside the frame") }
        quad = corners.map { CGPoint(x: $0[0], y: 1 - $0[1]) }
        guard area(quad) > 1e-5 else { throw TrackError(message: "corners must enclose an area") }
    } else if let x = pick.x, let y = pick.y, let w = pick.w, let h = pick.h, inside(x), inside(y), w > 0, h > 0, inside(x + w), inside(y + h) {
        quad = [CGPoint(x: x, y: 1 - y), CGPoint(x: x + w, y: 1 - y), CGPoint(x: x + w, y: 1 - y - h), CGPoint(x: x, y: 1 - y - h)]
    } else { throw TrackError(message: "the pick box must be inside the frame") }
    let xs = quad.map { $0.x }, ys = quad.map { $0.y }
    let startRect = CGRect(x: xs.min()!, y: ys.min()!, width: xs.max()! - xs.min()!, height: ys.max()! - ys.min()!)
    let longSide = args.count > 7 ? Double(args[7]) ?? 1920 : 1920

    let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
    guard let track = asset.tracks(withMediaType: .video).first else { throw TrackError(message: "no video track") }
    let transform = track.preferredTransform
    let bounds = CGRect(origin: .zero, size: track.naturalSize).applying(transform)
    let sourceSize = CGSize(width: abs(bounds.width), height: abs(bounds.height))
    // The same oriented, scaled decode as matte.swift: Vision sees the picture the way the edit does.
    let scale = min(1, longSide / max(sourceSize.width, sourceSize.height))
    let renderSize = CGSize(width: max(2, floor(sourceSize.width * scale / 2) * 2), height: max(2, floor(sourceSize.height * scale / 2) * 2))
    let rate = Double(max(1, track.nominalFrameRate)), half = 0.5 / rate
    // The composition renders a frame every frameDuration from the start of a read, so every read starts on the
    // source's own frame grid: otherwise a frame would carry a time between two source frames.
    let step = track.minFrameDuration.isValid && track.minFrameDuration.seconds > 0 ? track.minFrameDuration : CMTime(seconds: 1 / rate, preferredTimescale: 600000)
    let composition = AVMutableVideoComposition()
    composition.renderSize = renderSize
    composition.frameDuration = step
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
    layer.setTransform(transform.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        .concatenating(CGAffineTransform(scaleX: renderSize.width / sourceSize.width, y: renderSize.height / sourceSize.height)), at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
    instruction.layerInstructions = [layer]
    composition.instructions = [instruction]
    // Calls back with each decoded frame in [from, to] until it returns false.
    func decode(_ from: Double, _ to: Double, _ body: (CVPixelBuffer, Double) throws -> Bool) throws {
        let reader = try AVAssetReader(asset: asset)
        let start = CMTimeMultiply(step, multiplier: Int32(max(0, (from / step.seconds + 1e-6).rounded(.down))))
        reader.timeRange = CMTimeRange(start: start, end: CMTime(seconds: to, preferredTimescale: 600000))
        let output = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        output.videoComposition = composition
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw TrackError(message: "cannot attach decoder") }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TrackError(message: "cannot start decoding") }
        defer { reader.cancelReading() }
        var more = true
        while more, let sample = output.copyNextSampleBuffer() {
            try autoreleasepool {
                guard let pixels = CMSampleBufferGetImageBuffer(sample) else { return }
                more = try body(pixels, CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)))
            }
        }
        if reader.status == .failed { throw reader.error ?? TrackError(message: "decode failed") }
    }
    func follower() -> Follower { mode == "object" ? ObjectFollower(startRect) : PlaneFollower(quad, renderSize) }
    func row(_ t: Double) -> [String: Any] { ["t": (t * 1e5).rounded() / 1e5] }

    var frames = 0
    let wall = ProcessInfo.processInfo.systemUptime
    // Forward: the pick frame is the first frame shown at pickS; Vision takes its template there.
    let ahead = follower()
    var pickT: Double?
    try decode(pickS, e + half) { pixels, t in
        if pickT == nil { pickT = t }
        var r = row(t)
        ahead.step(pixels, &r)
        try emit(r); frames += 1
        return !ahead.gone
    }
    guard let pickT else { throw TrackError(message: "no frames at the pick") }
    // Backward: half-second chunks decoded forward, then tracked in reverse. The pick frame starts the tracker again
    // (template from the same frame) and is not written twice.
    let behind = follower()
    var upper = pickT, first = true
    while !behind.gone && upper > s + half {
        let lower = max(s - half, upper - 0.5)
        var chunk: [(CVPixelBuffer, Double)] = []
        try decode(lower, upper + (first ? half : 0)) { pixels, t in
            if t >= s - half && (t < upper - 1e-4 || first && abs(t - pickT) < 1e-4) { chunk.append((pixels, t)) }
            return true
        }
        if chunk.isEmpty { break }
        for (pixels, t) in chunk.reversed() {
            var r = row(t)
            behind.step(pixels, &r)
            if first && abs(t - pickT) < 1e-4 { continue }
            try emit(r); frames += 1
            if behind.gone { break }
        }
        upper = chunk.map { $0.1 }.min()!
        first = false
        if lower <= s - half { break }
    }
    let seconds = ProcessInfo.processInfo.systemUptime - wall
    try emit(["done": true, "frames": frames, "seconds": seconds, "fps": Double(frames) / max(seconds, 1e-9),
              "width": Double(renderSize.width), "height": Double(renderSize.height), "rate": rate, "pickT": pickT, "mode": mode])
}

do { try run() }
catch {
    FileHandle.standardError.write(Data(("track: \(error.localizedDescription)\n").utf8))
    exit(1)
}
