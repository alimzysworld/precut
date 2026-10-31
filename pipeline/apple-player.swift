// AV1/AV1b: the Apple player's command line helper, for tests and QA only.
// Playback itself runs in process (pipeline/apple-view.swift, built into
// build/tools/apple-player.node), behind precut's page in precut's own window.
// Both are built from pipeline/apple-composition.swift: one composition builder.
// Modes:
//   apple-player validate <manifest.json>   build the composition, print facts as JSON, exit
//   apple-player frame <manifest.json> <seconds> <out.png>   one composited frame as PNG
//   apple-player rms <manifest.json> [window seconds]   RMS (dB) of the mixed sound per window (default one second), as JSON
//   apple-player play <manifest.json> <seconds>...   AV4: the plan's picture in an AVPlayer, as the window plays it (its
//     framing compositor), seeked to each time and played a moment: whether the item stays ready, or why it failed
import Foundation
import AVFoundation
import AppKit

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(Data(("apple-player: " + message + "\n").utf8))
    exit(1)
}
func loadManifest(_ path: String) -> Manifest {
    do { return try loadManifestFile(path) } catch { fail(String(describing: error)) }
}
func printJSON(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value), let text = String(data: data, encoding: .utf8) { print(text) }
}

@main
enum ApplePlayerCommand {
    static func main() {
        let args = Array(CommandLine.arguments.dropFirst())
        guard let mode = args.first else { fail("usage: apple-player validate|frame|rms ...") }
        switch mode {
        case "validate": validate(args)
        case "frame": frame(args)
        case "rms": rms(args)
        case "play": play(args)
        default: fail("usage: apple-player validate|frame|rms|play ...")
        }
    }

    static func validate(_ args: [String]) {
        guard args.count == 2 else { fail("usage: apple-player validate <manifest.json>") }
        let manifest = loadManifest(args[1])
        do {
            let built = try buildComposition(manifest)
            let duration = CMTimeGetSeconds(built.composition.duration)
            printJSON(["ok": true, "durationS": duration, "videoSegments": manifest.video.count, "audioSegments": manifest.audio.count,
                       "videoTracks": built.composition.tracks(withMediaType: .video).count, "audioTracks": built.composition.tracks(withMediaType: .audio).count])
        } catch { printJSON(["ok": false, "error": String(describing: error)]); exit(1) }
        exit(0)
    }

    static func frame(_ args: [String]) {
        guard args.count == 4, let at = Double(args[2]) else { fail("usage: apple-player frame <manifest.json> <seconds> <out.png>") }
        let manifest = loadManifest(args[1])
        do {
            let built = try buildComposition(manifest)
            let composition = built.composition
            // The image generator refuses large compositions (dozens of framed pieces at
            // 1080x1920). Reading through a video composition output renders the same frame.
            func readerImage() throws -> CGImage {
                let reader = try AVAssetReader(asset: composition)
                let tracks = composition.tracks(withMediaType: .video)
                let output = AVAssetReaderVideoCompositionOutput(videoTracks: tracks, videoSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
                // AV2: the same framing compositor the window plays, then the same Look renderer its presenter draws with,
                // so a grabbed frame is the shown frame.
                AppleLookState.shared.load(manifest: manifest)
                // AV4: the builder's video composition frames every picture into its tile (a column of output frames).
                guard let screen = built.videoComposition?.mutableCopy() as? AVMutableVideoComposition else { throw CompositionError.message("no pictures") }
                screen.customVideoCompositorClass = PictureCompositor.self
                output.videoComposition = screen
                guard reader.canAdd(output) else { throw CompositionError.message("cannot read composed video") }
                reader.add(output)
                // AV3: read only up to just past the asked time, so the reader ends there rather than wait for a picture
                // after it (a held picture, AV3 speed, has none for a while: an unbounded read once waited forever).
                reader.timeRange = CMTimeRange(start: .zero, end: seconds(min(CMTimeGetSeconds(composition.duration), at + 0.05)))
                guard reader.startReading() else { throw reader.error ?? CompositionError.message("cannot start reading") }
                var last: CVPixelBuffer?
                var lastPts = at
                while let buffer = output.copyNextSampleBuffer() {
                    let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
                    if pts > at + 0.001 { break }
                    if let pixels = CMSampleBufferGetImageBuffer(buffer) { last = pixels; lastPts = pts }
                }
                guard var pixels = last else { throw CompositionError.message("no frame at that time") }
                var ci: CIImage
                if manifest.shader != nil {
                    // The span the compositor framed it for rides on the picture, as in the window.
                    let span = (CVBufferCopyAttachment(pixels, appleSpanKey, nil) as? NSNumber)?.intValue
                    let frame = AppleLookState.shared.frame(at: lastPts, span: span, wait: 10)
                    guard frame.ready, let graded = AppleLookRenderer().render(framed: pixels, time: lastPts, frame: frame) else { throw CompositionError.message("cannot draw the Look") }
                    pixels = graded
                    ci = CIImage(cvPixelBuffer: pixels)
                } else {
                    // No Look: the first tile as composed (Core Image is bottom up: the top rows are the last).
                    let whole = CIImage(cvPixelBuffer: pixels), h = CGFloat(manifest.height)
                    ci = whole.cropped(to: CGRect(x: 0, y: whole.extent.height - h, width: CGFloat(manifest.width), height: h)).transformed(by: CGAffineTransform(translationX: 0, y: -(whole.extent.height - h)))
                }
                // No colour conversion: the pixels are the screen's sRGB values, as the window shows them.
                let plain = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
                guard let image = plain.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else { throw CompositionError.message("cannot convert frame") }
                return image
            }
            func generatorImage() throws -> CGImage {
                let generator = AVAssetImageGenerator(asset: composition)
                generator.appliesPreferredTrackTransform = true
                generator.requestedTimeToleranceBefore = .zero
                generator.requestedTimeToleranceAfter = .zero
                return try generator.copyCGImage(at: seconds(at), actualTime: nil)
            }
            var degraded = false
            let image: CGImage
            // The reader path carries framing and the Look; the generator is only a fallback and is marked degraded.
            do { image = try readerImage() } catch { degraded = true; image = try generatorImage() }
            let rep = NSBitmapImageRep(cgImage: image)
            guard let data = rep.representation(using: .png, properties: [:]) else { fail("cannot encode frame") }
            try data.write(to: URL(fileURLWithPath: args[3]))
            printJSON(["ok": true, "width": image.width, "height": image.height, "atS": at, "degraded": degraded])
        } catch { printJSON(["ok": false, "error": String(describing: error)]); exit(1) }
        exit(0)
    }

    static func play(_ args: [String]) {
        guard args.count >= 2 else { fail("usage: apple-player play <manifest.json> <seconds>...") }
        let manifest = loadManifest(args[1])
        let times = args.dropFirst(2).compactMap(Double.init)
        do {
            let built = try buildComposition(Manifest(version: manifest.version, width: manifest.width, height: manifest.height, fps: manifest.fps, durationS: manifest.durationS, video: manifest.video, audio: [], finish: manifest.finish, sound: manifest.sound, shader: manifest.shader, gridFps: manifest.gridFps))
            AppleLookState.shared.load(manifest: manifest)
            let item = AVPlayerItem(asset: built.composition)
            guard let screen = built.videoComposition?.mutableCopy() as? AVMutableVideoComposition else { throw CompositionError.message("no pictures") }
            screen.customVideoCompositorClass = PictureCompositor.self
            item.videoComposition = screen
            let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
            item.add(output)
            let player = AVPlayer(playerItem: item)
            player.isMuted = true
            player.automaticallyWaitsToMinimizeStalling = false
            func spin(_ s: Double) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
            var waited = 0.0
            while item.status == .unknown && waited < 10 { spin(0.05); waited += 0.05 }
            var steps: [[String: Any]] = []
            for t in times {
                var done = false
                player.seek(to: seconds(t), toleranceBefore: .zero, toleranceAfter: .zero) { _ in done = true }
                var w = 0.0; while !done && w < 5 { spin(0.02); w += 0.02 }
                player.rate = 1; spin(0.4); player.rate = 0
                steps.append(["t": t, "status": item.status.rawValue, "error": item.error.map { String(describing: $0) } ?? NSNull(), "now": CMTimeGetSeconds(player.currentTime())])
                if item.status == .failed { break }
            }
            let log = item.errorLog()?.events.map { "\($0.errorStatusCode) \($0.errorDomain) \($0.errorComment ?? "")" } ?? []
            printJSON(["ok": item.status == .readyToPlay, "status": item.status.rawValue, "error": item.error.map { String(describing: $0) } ?? NSNull(), "steps": steps, "errorLog": log,
                       "composerFailure": PictureCompositor.lastFailure ?? NSNull()])
        } catch { printJSON(["ok": false, "error": String(describing: error)]); exit(1) }
        exit(0)
    }

    static func rms(_ args: [String]) {
        guard args.count == 2 || args.count == 3 else { fail("usage: apple-player rms <manifest.json> [window seconds]") }
        let window = args.count == 3 ? max(0.001, Double(args[2]) ?? 1) : 1
        let manifest = loadManifest(args[1])
        do {
            let built = try buildComposition(manifest)
            let composition = built.composition
            if composition.tracks(withMediaType: .audio).isEmpty { printJSON(["ok": true, "windowS": window, "perSecondDb": [Double]()]); exit(0) }
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: false]
            let mixReader = try AVAssetReader(asset: composition)
            let mixOutput = AVAssetReaderAudioMixOutput(audioTracks: composition.tracks(withMediaType: .audio), audioSettings: settings)
            if let audioMix = built.audioMix { mixOutput.audioMix = audioMix }
            guard mixReader.canAdd(mixOutput) else { fail("cannot mix audio") }
            mixReader.add(mixOutput)
            guard mixReader.startReading() else { fail("cannot read audio: \(String(describing: mixReader.error))") }
            var sums: [Double] = []
            var counts: [Int] = []
            while let buffer = mixOutput.copyNextSampleBuffer() {
                let start = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer))
                guard let block = CMSampleBufferGetDataBuffer(buffer), let format = CMSampleBufferGetFormatDescription(buffer),
                      let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee else { continue }
                let length = CMBlockBufferGetDataLength(block)
                var bytes = [UInt8](repeating: 0, count: length)
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: length, destination: &bytes)
                let channels = max(1, Int(asbd.mChannelsPerFrame)), rate = asbd.mSampleRate > 0 ? asbd.mSampleRate : 44100
                bytes.withUnsafeBytes { raw in
                    let samples = raw.bindMemory(to: Float.self)
                    let frames = samples.count / channels
                    for frame in 0..<frames {
                        // Each sample frame lands in its own window, so window edges are sample exact.
                        let idx = Int(floor(max(0, start + Double(frame) / rate) / window))
                        while sums.count <= idx { sums.append(0); counts.append(0) }
                        for c in 0..<channels { let s = Double(samples[frame * channels + c]); sums[idx] += s * s; counts[idx] += 1 }
                    }
                }
            }
            let levels = zip(sums, counts).map { (sum, count) -> Double in count > 0 ? 10 * log10(max(1e-12, sum / Double(count))) : -120 }
            printJSON(["ok": true, "windowS": window, "perSecondDb": levels.map { ($0 * 100).rounded() / 100 }])
        } catch { printJSON(["ok": false, "error": String(describing: error)]); exit(1) }
        exit(0)
    }
}
