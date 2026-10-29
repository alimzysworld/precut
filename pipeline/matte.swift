// Measurements only: white = person. No inference about picks, titles or clip kind.
// matte <source> <s> <e> <fps> <width> <height> <crop JSON|null> <ffmpeg> <out>
import Foundation
import AVFoundation
import Vision
import CoreImage
import ImageIO

struct MatteError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
struct Key: Decodable { let t: Double; let x: Double }
struct Crop: Decodable {
    let x: Double; let y: Double; let w: Double; let h: Double
    let keyframes: [Key]?
    func position(_ t: Double) -> Double {
        guard let keys = keyframes, let first = keys.first else { return x }
        if t <= first.t { return first.x }
        for i in 1..<keys.count where t < keys[i].t {
            let a = keys[i - 1], b = keys[i], u = (t - a.t) / (b.t - a.t)
            let eased = u < 0.15 ? u * u / 0.255 :
                (u > 0.85 ? 1 - (1 - u) * (1 - u) / 0.255 : (u - 0.075) / 0.85)
            return a.x + (b.x - a.x) * eased
        }
        return keys.last!.x
    }
}
func emit(_ row: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}
func renderGray(_ image: CIImage, context: CIContext, width: Int, height: Int, flipped: Bool) throws -> Data {
    var data = Data(count: width * height)
    try data.withUnsafeMutableBytes { bytes in
        let destination = CIRenderDestination(bitmapData: bytes.baseAddress!, width: width, height: height,
                                              bytesPerRow: width, format: .L8)
        destination.colorSpace = nil // Masks are measurements, not display colors.
        destination.isFlipped = flipped
        let task = try context.startTask(toRender: image, from: CGRect(x: 0, y: 0, width: width, height: height),
                                         to: destination, at: .zero)
        _ = try task.waitUntilCompleted()
    }
    return data
}
func run() throws {
    let args = CommandLine.arguments
    guard args.count == 10, let s = Double(args[2]), let e = Double(args[3]),
          let fps = Double(args[4]), let width = Int(args[5]), let height = Int(args[6]),
          s.isFinite, e.isFinite, fps.isFinite, s >= 0, e > s, fps > 0, fps <= 240,
          width > 0, height > 0, width <= 8192, height <= 8192 else {
        throw MatteError(message: "usage: matte source s e fps width height crop-JSON ffmpeg out")
    }
    let crop = try JSONDecoder().decode(Crop?.self, from: Data(args[7].utf8))
    let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
    guard let track = asset.tracks(withMediaType: .video).first,
          e <= CMTimeGetSeconds(asset.duration) + 1e-6 else {
        throw MatteError(message: "no video track or span exceeds source duration")
    }
    let transform = track.preferredTransform
    let bounds = CGRect(origin: .zero, size: track.naturalSize).applying(transform)
    let sourceSize = CGSize(width: abs(bounds.width), height: abs(bounds.height))
    guard sourceSize.width > 0, sourceSize.height > 0 else {
        throw MatteError(message: "invalid source geometry")
    }
    if let c = crop {
        let xs = [c.x] + (c.keyframes ?? []).map { $0.x }
        guard [c.x, c.y, c.w, c.h].allSatisfy({ $0.isFinite }), c.w > 0, c.h > 0,
              c.y >= 0, c.y + c.h <= sourceSize.height + 1e-4,
              xs.allSatisfy({ $0.isFinite && $0 >= 0 && $0 + c.w <= sourceSize.width + 1e-4 }) else {
            throw MatteError(message: "crop is outside the oriented source")
        }
        var last = -Double.infinity
        for key in c.keyframes ?? [] {
            guard key.t.isFinite, key.t >= 0, key.t <= e - s + 1e-6, key.t > last else {
                throw MatteError(message: "crop keyframes must increase in piece-relative seconds")
            }
            last = key.t
        }
    }
    // Sequential decode avoids a seek/GOP decode per mask. Scale only the Vision
    // input: all crop values remain in full-resolution, oriented source pixels.
    let scale = min(1, 1280 / max(sourceSize.width, sourceSize.height))
    let renderSize = CGSize(width: max(2, floor(sourceSize.width * scale / 2) * 2),
                            height: max(2, floor(sourceSize.height * scale / 2) * 2))
    let composition = AVMutableVideoComposition()
    composition.renderSize = renderSize
    composition.frameDuration = CMTime(seconds: 1 / max(fps, Double(track.nominalFrameRate)), preferredTimescale: 600000)
    let layer = AVMutableVideoCompositionLayerInstruction(assetTrack: track)
    layer.setTransform(transform.concatenating(CGAffineTransform(translationX: -bounds.minX, y: -bounds.minY))
        .concatenating(CGAffineTransform(scaleX: renderSize.width / sourceSize.width,
                                        y: renderSize.height / sourceSize.height)), at: .zero)
    let instruction = AVMutableVideoCompositionInstruction()
    instruction.timeRange = CMTimeRange(start: .zero, duration: asset.duration)
    instruction.layerInstructions = [layer]
    composition.instructions = [instruction]
    let reader = try AVAssetReader(asset: asset)
    reader.timeRange = CMTimeRange(start: CMTime(seconds: s, preferredTimescale: 600000),
                                  duration: CMTime(seconds: e - s, preferredTimescale: 600000))
    let output = AVAssetReaderVideoCompositionOutput(videoTracks: [track], videoSettings: [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    output.videoComposition = composition
    output.alwaysCopiesSampleData = false
    guard reader.canAdd(output) else { throw MatteError(message: "cannot attach video decoder") }
    reader.add(output)
    guard reader.startReading() else { throw reader.error ?? MatteError(message: "cannot start decoding") }
    defer { reader.cancelReading() }

    let encoder = Process(), pipe = Pipe()
    encoder.executableURL = URL(fileURLWithPath: args[8])
    encoder.arguments = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-f", "rawvideo", "-pixel_format", "gray", "-video_size", "\(width)x\(height)",
        "-framerate", String(fps), "-i", "pipe:0", "-an", "-c:v", "ffv1", "-level", "3",
        "-pix_fmt", "gray", "-f", "matroska", args[9]]
    encoder.standardInput = pipe
    encoder.standardOutput = FileHandle.standardError
    encoder.standardError = FileHandle.standardError
    signal(SIGPIPE, SIG_IGN)
    try encoder.run()
    // Do not retain the parent's read end: a dead encoder must produce EPIPE.
    pipe.fileHandleForReading.closeFile()
    var complete = false
    defer {
        try? pipe.fileHandleForWriting.close()
        if !complete && encoder.isRunning { encoder.terminate() }
        encoder.waitUntilExit()
    }
    let request = VNGeneratePersonSegmentationRequest()
    request.qualityLevel = .accurate
    request.outputPixelFormat = kCVPixelFormatType_OneComponent8
    let handler = VNSequenceRequestHandler()
    let context = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
    var previous: CIImage?
    var next = output.copyNextSampleBuffer()
    var current: CMSampleBuffer?
    let count = Int(ceil((e - s) * fps - 1e-7))
    let start = ProcessInfo.processInfo.systemUptime
    for n in 0..<count {
        try autoreleasepool {
            let t = s + Double(n) / fps
            while let sample = next, CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) <= t + 1e-7 {
                current = sample
                next = output.copyNextSampleBuffer()
            }
            if reader.status == .failed { throw reader.error ?? MatteError(message: "decode failed") }
            let chosen: CMSampleBuffer?
            if let a = current, let b = next {
                let ta = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(a))
                let tb = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(b))
                chosen = t - ta <= tb - t ? a : b
            } else { chosen = current ?? next }
            guard let sample = chosen, let pixels = CMSampleBufferGetImageBuffer(sample) else {
                throw MatteError(message: "no decoded frame at \(t)s")
            }
            try handler.perform([request], on: pixels, orientation: .up)
            guard let mask = request.results?.first?.pixelBuffer else {
                throw MatteError(message: "Vision returned no mask at \(t)s")
            }
            let raw = CIImage(cvPixelBuffer: mask, options: [.colorSpace: NSNull()]), extent = raw.extent
            var softened = raw.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 0.65]).cropped(to: extent)
            if let old = previous {
                func weight(_ image: CIImage, _ value: CGFloat) -> CIImage {
                    image.applyingFilter("CIColorMatrix", parameters: [
                        "inputRVector": CIVector(x: value, y: 0, z: 0, w: 0),
                        "inputGVector": CIVector(x: 0, y: value, z: 0, w: 0),
                        "inputBVector": CIVector(x: 0, y: 0, z: value, w: 0)])
                }
                softened = weight(softened, 0.85).applyingFilter("CIAdditionCompositing",
                    parameters: [kCIInputBackgroundImageKey: weight(old, 0.15)]).cropped(to: extent)
            }
            // Materialize the small smoothed mask so CI does not retain a growing
            // history or Vision's recyclable buffers. Smooth before any moving crop.
            let mw = Int(extent.width), mh = Int(extent.height)
            let small = try renderGray(softened, context: context, width: mw, height: mh, flipped: true)
            let stable = CIImage(bitmapData: small, bytesPerRow: mw, size: extent.size, format: .L8, colorSpace: nil)
            previous = stable
            let c = crop ?? Crop(x: 0, y: 0, w: sourceSize.width, h: sourceSize.height, keyframes: nil)
            // CI is bottom-left; framing.ts crop rectangles are top-left.
            let rect = CGRect(x: c.position(Double(n) / fps), y: sourceSize.height - c.y - c.h, width: c.w, height: c.h)
            let image = stable.transformed(by: CGAffineTransform(scaleX: sourceSize.width / extent.width, y: sourceSize.height / extent.height))
                .cropped(to: rect).transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
                .transformed(by: CGAffineTransform(scaleX: Double(width) / c.w, y: Double(height) / c.h))
            // FFmpeg rawvideo begins with the top row; CI's logical origin is bottom-left.
            let frame = try renderGray(image, context: context, width: width, height: height, flipped: true)
            try pipe.fileHandleForWriting.write(contentsOf: frame)
            if n == 0 || (n + 1) % max(1, Int(fps)) == 0 {
                try emit(["frames": n + 1, "totalFrames": count, "pct": min(99, Double(n + 1) / Double(count) * 100)])
            }
        }
    }
    try pipe.fileHandleForWriting.close()
    encoder.waitUntilExit()
    guard encoder.terminationStatus == 0 else { throw MatteError(message: "ffmpeg failed (\(encoder.terminationStatus))") }
    complete = true
    let seconds = ProcessInfo.processInfo.systemUptime - start
    try emit(["pct": 100, "frames": count, "seconds": seconds, "fps": Double(count) / seconds,
              "sourceWidth": sourceSize.width, "sourceHeight": sourceSize.height])
}

do { try run() }
catch {
    FileHandle.standardError.write(Data(("matte: \(error.localizedDescription)\n").utf8))
    exit(1)
}
