// Built with the app. Never invokes a compiler or sends pictures off device.
import Foundation
import AVFoundation
import Vision
import ImageIO
import UniformTypeIdentifiers
import CoreGraphics

func emit(_ row: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}
guard CommandLine.arguments.count == 3 else { exit(2) }
let asset = AVURLAsset(url: URL(fileURLWithPath: CommandLine.arguments[1]))
let destination = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
let duration = CMTimeGetSeconds(asset.duration)
guard duration.isFinite && duration > 0 else { exit(2) }
let generator = AVAssetImageGenerator(asset: asset)
generator.appliesPreferredTrackTransform = true
generator.maximumSize = CGSize(width: 1920, height: 1920)
generator.requestedTimeToleranceBefore = CMTime(seconds: 0.15, preferredTimescale: 600)
generator.requestedTimeToleranceAfter = CMTime(seconds: 0.15, preferredTimescale: 600)
var previous: [UInt8]? = nil
var segments = [[String: Any]]()
let began = Date()
for t in stride(from: 0.0, to: duration, by: 2.0) {
    try autoreleasepool {
        let picture = try generator.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 600), actualTime: nil)
        var pixels = [UInt8](repeating: 0, count: 160 * 100)
        pixels.withUnsafeMutableBytes { bytes in
            let context = CGContext(data: bytes.baseAddress, width: 160, height: 100, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0)!
            context.draw(picture, in: CGRect(x: 0, y: 0, width: 160, height: 100))
        }
        let change = previous.map { old in zip(old, pixels).reduce(0.0) { $0 + Double(abs(Int($1.0) - Int($1.1))) } / Double(pixels.count * 255) } ?? 1
        // Compare to the last saved moment, so slow scrolls accumulate.
        if previous == nil || change >= 0.018 {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            try VNImageRequestHandler(cgImage: picture, options: [:]).perform([request])
            let rows = (request.results ?? []).sorted { a, b in
                abs(a.boundingBox.midY - b.boundingBox.midY) < 0.012 ? a.boundingBox.minX < b.boundingBox.minX : a.boundingBox.midY > b.boundingBox.midY
            }
            let text = rows.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            let name = String(format: "%.3f.jpg", t)
            let file = destination.appendingPathComponent(name)
            if let values = try? file.resourceValues(forKeys: [.isSymbolicLinkKey]), values.isSymbolicLink == true {
                throw NSError(domain: "Redirected screen still", code: 1)
            }
            guard let writer = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { throw NSError(domain: "Screen still", code: 1) }
            CGImageDestinationAddImage(writer, picture, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
            guard CGImageDestinationFinalize(writer) else { throw NSError(domain: "Screen still", code: 2) }
            if !segments.isEmpty { segments[segments.count - 1]["e"] = t }
            // OCR and image change are facts. The wording pass decides app and action.
            segments.append(["s": t, "e": duration, "text": text, "still": name, "change": change])
            previous = pixels
        }
        let elapsed = Date().timeIntervalSince(began)
        let done = min(duration, t + 2)
        try emit(["pct": done / duration * 100, "etaS": max(0, elapsed * (duration - done) / done)])
    }
}
try emit(["segments": segments, "readMs": Date().timeIntervalSince(began) * 1000])
