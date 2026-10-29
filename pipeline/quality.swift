// Local Vision facts, no remote inference. quality <video> <exposure-video> <profile>
// quality --duplicates <manifest.json> compares cached, revision-2 feature prints.
import Foundation
import AVFoundation
import Vision
import CoreImage

struct QualityError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}
func emit(_ row: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}
func rank(_ box: CGRect) -> CGFloat {
    let dx = box.midX - 0.5, dy = box.midY - 0.5
    return box.width * box.height / (1 + dx * dx + dy * dy)
}
func generator(_ path: String) -> (AVAssetImageGenerator, Double, Bool) {
    let asset = AVURLAsset(url: URL(fileURLWithPath: path))
    let g = AVAssetImageGenerator(asset: asset)
    g.appliesPreferredTrackTransform = true
    g.maximumSize = CGSize(width: 960, height: 960)
    g.requestedTimeToleranceBefore = .zero
    g.requestedTimeToleranceAfter = .zero
    var fullRange = false
    if let raw = asset.tracks(withMediaType: .video).first?.formatDescriptions.first {
        let description = raw as! CMFormatDescription
        fullRange = CMFormatDescriptionGetExtension(description,
            extensionKey: kCMFormatDescriptionExtension_FullRangeVideo) as? Bool ?? false
    }
    return (g, CMTimeGetSeconds(asset.duration), fullRange)
}
// AVFoundation's video-range YUV -> RGB maps legal black/white to 0/1.
// Restore Sony's 10-bit code scale (64..940), then invert S-Log3 per Sony's
// Technical Summary (1237494271406.pdf). S-Log2 uses the published 90%-reflection
// curve. No display gamma or creative LUT enters these luminance measurements.
func linear(_ value: Double, profile: String, fullRange: Bool = false) -> Double {
    if profile == "slog3" {
        let code = fullRange ? 1023 * value : 64 + 876 * value
        return max(0, code >= 171.2102946929
            ? pow(10, (code - 420) / 261.5) * 0.19 - 0.01
            : (code - 95) * 0.01125 / (171.2102946929 - 95))
    }
    if profile == "slog2" {
        let v = fullRange ? (1023 * value - 64) / 876 : value
        return max(0, (pow(10, (v - 0.616596 - 0.03) / 0.432699) - 0.037584) * 0.9 * 219 / 155)
    }
    return value < 0.081 ? value / 4.5 : pow((value + 0.099) / 1.099, 1 / 0.45)
}
func histogram(_ image: CGImage, face: CGRect?, profile: String, fullRange: Bool, context: CIContext) -> [String: Any] {
    let w = image.width, h = image.height
    var pixels = [UInt8](repeating: 0, count: w * h * 4)
    // Disable color management: encoded log numbers must remain encoded numbers.
    let ci = CIImage(cgImage: image, options: [.colorSpace: NSNull()])
    pixels.withUnsafeMutableBytes { bytes in
        context.render(ci, toBitmap: bytes.baseAddress!, rowBytes: w * 4,
                       bounds: ci.extent, format: .RGBA8, colorSpace: nil)
    }
    let lut = (0...255).map { linear(Double($0) / 255, profile: profile, fullRange: fullRange) }
    var frameHist = [Int](repeating: 0, count: 256), faceHist = frameHist
    var frameSum = 0.0, faceSum = 0.0, faceCount = 0
    // CI bitmap rows follow its bottom-left coordinates, like Vision boxes.
    for y in stride(from: 0, to: h, by: 2) {
        for x in stride(from: 0, to: w, by: 2) {
            let i = (y * w + x) * 4
            let r = Int(pixels[i]), g = Int(pixels[i + 1]), b = Int(pixels[i + 2])
            let encoded = 0.2126 * Double(r) + 0.7152 * Double(g) + 0.0722 * Double(b)
            let bin = min(255, max(0, Int(encoded.rounded())))
            let luma = 0.2126 * lut[r] + 0.7152 * lut[g] + 0.0722 * lut[b]
            frameHist[bin] += 1; frameSum += luma
            if let box = face, box.contains(CGPoint(x: Double(x) / Double(w), y: Double(y) / Double(h))) {
                faceHist[bin] += 1; faceSum += luma; faceCount += 1
            }
        }
    }
    let count = frameHist.reduce(0, +)
    var row: [String: Any] = ["frameLuma": frameSum / Double(max(1, count)),
        "frameClipped": Double(frameHist[252...255].reduce(0, +)) / Double(max(1, count))]
    if faceCount > 0 {
        row["faceLuma"] = faceSum / Double(faceCount)
        row["faceClipped"] = Double(faceHist[252...255].reduce(0, +)) / Double(faceCount)
    }
    return row
}
struct DuplicateClip: Decodable {
    let id: String; let duration: Double; let prints: [String]; let fresh: Bool?
}
func duplicates(_ path: String, focused: Bool = false) throws {
    let clips = try JSONDecoder().decode([DuplicateClip].self, from: Data(contentsOf: URL(fileURLWithPath: path)))
    let prints = try clips.map { clip in
        try clip.prints.map { value -> VNFeaturePrintObservation in
            guard let data = Data(base64Encoded: value),
                  let print = try NSKeyedUnarchiver.unarchivedObject(ofClass: VNFeaturePrintObservation.self, from: data) else {
                throw QualityError(message: "invalid cached feature print")
            }
            return print
        }
    }
    var result: [String: String] = [:]
    var pairs: [[String: Any]] = []
    for i in clips.indices {
        guard prints[i].count == 3 else { continue }
        for j in 0..<i {
            guard prints[j].count == 3 else { continue }
            if focused && clips[i].fresh != true && clips[j].fresh != true { continue }
            var distances: [Float] = []
            for k in 0..<3 {
                var distance: Float = 0
                try prints[i][k].computeDistance(&distance, to: prints[j][k])
                distances.append(distance)
            }
            // Rev 2 normalized distances. Require all three temporal positions,
            // conservatively: sharing a location/scene alone is not a duplicate.
            if distances.allSatisfy({ $0.isFinite }) {
                pairs.append(["a": clips[j].id, "b": clips[i].id,
                              "mean": distances.reduce(0, +) / 3, "max": distances.max()!,
                              "spread": distances.max()! - distances.min()!, "aligned": distances])
            }
            if abs(clips[i].duration - clips[j].duration) <= max(0.5, clips[i].duration * 0.02),
               distances.allSatisfy({ $0.isFinite && $0 <= 0.08 }), result[clips[i].id] == nil {
                result[clips[i].id] = result[clips[j].id] ?? clips[j].id
            }
        }
    }
    try emit(["duplicates": result, "pairs": pairs])
}
func run() throws {
    guard #available(macOS 14.0, *) else { throw QualityError(message: "Vision revision-2 measurements require macOS 14 or later") }
    let args = CommandLine.arguments
    if args.count == 3 && args[1] == "--duplicates" { try duplicates(args[2]); return }
    if args.count == 3 && args[1] == "--compare" { try duplicates(args[2], focused: true); return }
    if args.count == 3 && args[1] == "--prints" {
        let (g, duration, _) = generator(args[2])
        var prints: [String] = []
        let total = Int(ceil(duration * 2))
        for share in [0.2, 0.5, 0.8] {
            let at = Double(min(total - 1, Int(Double(total - 1) * share))) / 2
            let image = try g.copyCGImage(at: CMTime(seconds: at, preferredTimescale: 60000), actualTime: nil)
            let request = VNGenerateImageFeaturePrintRequest()
            request.revision = VNGenerateImageFeaturePrintRequestRevision2
            try VNImageRequestHandler(cgImage: image).perform([request])
            guard let print = request.results?.first else { throw QualityError(message: "no feature print") }
            prints.append(try NSKeyedArchiver.archivedData(withRootObject: print, requiringSecureCoding: true).base64EncodedString())
        }
        try emit(["prints": prints, "duration": duration]); return
    }
    guard args.count == 4, ["rec709", "slog2", "slog3"].contains(args[3]) else {
        throw QualityError(message: "usage: quality video exposure-video rec709|slog2|slog3")
    }
    let (g, duration, _) = generator(args[1]), (exposure, exposureDuration, fullRange) = generator(args[2])
    guard duration.isFinite, duration > 0, exposureDuration.isFinite,
          abs(duration - exposureDuration) < 0.5 else { throw QualityError(message: "invalid video duration") }
    let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull(), .cacheIntermediates: false])
    let total = Int(ceil(duration * 2))
    let printIndices = [0.2, 0.5, 0.8].map { min(total - 1, Int(Double(total - 1) * $0)) }
    var prints: [String] = [], scores: [String: Double] = [:], classified = 0
    for n in 0..<total {
        try autoreleasepool {
            let t = Double(n) / 2, time = CMTime(seconds: t, preferredTimescale: 60000)
            let image = try g.copyCGImage(at: time, actualTime: nil)
            let handler = VNImageRequestHandler(cgImage: image, options: [:])
            let faces = VNDetectFaceCaptureQualityRequest()
            try handler.perform([faces])
            let face = faces.results?.max { rank($0.boundingBox) < rank($1.boundingBox) }
            let raw = args[1] == args[2] ? image : try exposure.copyCGImage(at: time, actualTime: nil)
            var row = histogram(raw, face: face?.boundingBox, profile: args[3], fullRange: fullRange, context: context)
            row["t"] = t
            if let quality = face?.faceCaptureQuality { row["faceQuality"] = Double(quality) }
            try emit(row)
            if n % 2 == 0 {
                let request = VNClassifyImageRequest()
                try handler.perform([request]); classified += 1
                for label in request.results ?? [] where label.confidence >= 0.1 {
                    scores[label.identifier, default: 0] += Double(label.confidence)
                }
            }
            let copies = printIndices.filter { $0 == n }.count
            if copies > 0 {
                let request = VNGenerateImageFeaturePrintRequest()
                request.revision = VNGenerateImageFeaturePrintRequestRevision2
                try handler.perform([request])
                guard let print = request.results?.first else { throw QualityError(message: "no feature print") }
                let data = try NSKeyedArchiver.archivedData(withRootObject: print, requiringSecureCoding: true)
                for _ in 0..<copies { prints.append(data.base64EncodedString()) }
            }
        }
    }
    let tags = scores.map { ["label": $0.key, "confidence": $0.value / Double(max(1, classified))] as [String: Any] }
        .sorted { ($0["confidence"] as! Double) > ($1["confidence"] as! Double) }.prefix(8)
    try emit(["done": true, "duration": duration, "tags": Array(tags), "prints": prints,
              "exposureCurve": args[3], "fullRange": fullRange])
}
do { try run() }
catch {
    FileHandle.standardError.write(Data(("quality: \(error.localizedDescription)\n").utf8))
    exit(1)
}
