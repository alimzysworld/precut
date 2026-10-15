// On-device measurements only. Clip kind, verdict and shot remain the judge's call.
// Usage: subject <video> [samples-per-second]
import Foundation
import AVFoundation
import Vision

struct SubjectError: LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

func rank(_ box: CGRect) -> CGFloat {
    let dx = box.midX - 0.5
    let dy = box.midY - 0.5
    return box.width * box.height / (1 + dx * dx + dy * dy)
}

func mainSubject(_ image: CGImage) throws -> (CGRect, String)? {
    let faces = VNDetectFaceRectanglesRequest()
    let people = VNDetectHumanRectanglesRequest()
    // Upper bodies also work for a seated speaker whose legs are out of frame.
    people.upperBodyOnly = true
    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([faces, people])
    let face = faces.results?.max { rank($0.boundingBox) < rank($1.boundingBox) }
    let bodies = people.results ?? []
    if let face = face {
        let box = face.boundingBox
        let centre = CGPoint(x: box.midX, y: box.midY)
        // Widen only to this face's person, never to a different bystander.
        if let body = bodies.filter({ $0.boundingBox.contains(centre) })
            .max(by: { rank($0.boundingBox) < rank($1.boundingBox) }) {
            return (body.boundingBox.union(box), "body")
        }
        return (box, "face")
    }
    if let body = bodies.max(by: { rank($0.boundingBox) < rank($1.boundingBox) }) {
        return (body.boundingBox, "body")
    }
    let attention = VNGenerateAttentionBasedSaliencyImageRequest()
    try handler.perform([attention])
    if let salient = attention.results?.first?.salientObjects?
        .max(by: { $0.confidence == $1.confidence
            ? rank($0.boundingBox) < rank($1.boundingBox)
            : $0.confidence < $1.confidence }) {
        return (salient.boundingBox, "salient")
    }
    return nil
}

func run() throws {
    let args = CommandLine.arguments
    guard args.count == 2 || args.count == 3 else {
        throw SubjectError(message: "usage: subject <video> [samples-per-second]")
    }
    let rate = args.count == 3 ? (Double(args[2]) ?? .nan) : 2
    guard rate.isFinite, rate > 0 else {
        throw SubjectError(message: "sample rate must be finite and positive")
    }
    let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
    let duration = CMTimeGetSeconds(asset.duration)
    guard duration.isFinite, duration > 0, !asset.tracks(withMediaType: .video).isEmpty else {
        throw SubjectError(message: "video has no readable duration or video track: \(args[1])")
    }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 1280, height: 1280)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    var n = 0
    while Double(n) / rate < duration {
        let t = Double(n) / rate
        try autoreleasepool {
            let image: CGImage
            do {
                image = try generator.copyCGImage(at: CMTime(seconds: t, preferredTimescale: 60000),
                                                 actualTime: nil)
            } catch {
                throw SubjectError(message: "frame at \(t)s: \(error as NSError)")
            }
            var row: [String: Any] = ["t": t]
            do {
                if let (rawBox, kind) = try mainSubject(image) {
                    let box = rawBox.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
                    guard !box.isNull, box.width > 0, box.height > 0 else {
                        throw SubjectError(message: "Vision returned an invalid box")
                    }
                    // Vision uses a bottom-left origin. The contract stores the centre;
                    // use top-left image coordinates so drawbox/crop can consume it.
                    row.merge(["x": Double(box.midX), "y": Double(1 - box.midY),
                               "w": Double(box.width), "h": Double(box.height),
                               "kind": kind]) { _, new in new }
                } else {
                    row["subject"] = NSNull()
                }
            } catch {
                throw SubjectError(message: "Vision at \(t)s: \(error as NSError)")
            }
            let data = try JSONSerialization.data(withJSONObject: row, options: [.sortedKeys])
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([10]))
        }
        n += 1
    }
}

do {
    try run()
} catch {
    FileHandle.standardError.write(Data(("subject: \(error.localizedDescription)\n").utf8))
    exit(1)
}
