// V1: rank already-decoded pictures. No source movie is opened here.
import Foundation
import Vision
import ImageIO

func run() throws {
    let input = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))) as! [String: Any]
    let candidates = input["candidates"] as! [[String: Any]]
    let duration = input["duration"] as! Double, count = input["count"] as! Int
    var selected = [[String: Any]](), previous: VNFeaturePrintObservation?
    for bin in 0..<count {
        var best: [String: Any]?, bestPrint: VNFeaturePrintObservation?, bestScore = -Double.infinity
        for row in candidates where min(count - 1, Int((row["t"] as! Double) / max(0.001, duration) * Double(count))) == bin {
            try autoreleasepool {
                let url = URL(fileURLWithPath: row["path"] as! String)
                guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
                    throw NSError(domain: "smart-frames: unreadable candidate", code: 1)
                }
                let request = VNGenerateImageFeaturePrintRequest()
                var distanceScale = 20.0
                request.revision = VNGenerateImageFeaturePrintRequestRevision1
                if #available(macOS 14.0, *) {
                    request.revision = VNGenerateImageFeaturePrintRequestRevision2
                    distanceScale = 1
                }
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
                guard let feature = request.results?.first else { throw NSError(domain: "smart-frames: no feature", code: 2) }
                var change: Float = 0
                if let previous = previous { try previous.computeDistance(&change, to: feature) }
                let sharp = row["sharpness"] as! Double, shake = row["shake"] as! Double
                // Sampling only: these scores never set a usability verdict.
                let score = log1p(max(0, sharp)) / 10 + 1 / (1 + max(0, shake)) + min(1, Double(change) / distanceScale)
                if score > bestScore {
                    bestScore = score; bestPrint = feature; best = row
                    best?["change"] = Double(change); best?["score"] = score
                }
            }
        }
        if let best = best { selected.append(best); previous = bestPrint }
    }
    let output = try JSONSerialization.data(withJSONObject: selected, options: [.sortedKeys])
    FileHandle.standardOutput.write(output)
}
do { try run() } catch { FileHandle.standardError.write(Data("\(error)\n".utf8)); exit(1) }
