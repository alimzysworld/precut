// voice WAV: where people are speaking in one clip's audio, measured on the Mac.
// Apple's built-in sound classifier (SoundAnalysis, version 1) scores spoken words
// in one-second windows, half overlapping. Prints [{"s","e","speech"}] as JSON.
// Reads one file; writes nothing. No network, no model download.
import Foundation
import SoundAnalysis
import AVFoundation

let spoken: Set<String> = ["speech", "whispering", "shout", "yell"]

final class Collector: NSObject, SNResultsObserving {
    var rows: [[String: Double]] = []
    var failure: Error?
    func request(_ request: SNRequest, didProduce result: SNResult) {
        guard let result = result as? SNClassificationResult else { return }
        let start = result.timeRange.start.seconds, length = result.timeRange.duration.seconds
        // Spoken words at any loudness: the classifier's speech, whispering, shout and yell labels.
        let speech = result.classifications.filter { spoken.contains($0.identifier) }.map(\.confidence).max() ?? 0
        rows.append(["s": start, "e": start + length, "speech": speech])
    }
    func request(_ request: SNRequest, didFailWithError error: Error) { failure = error }
    func requestDidComplete(_ request: SNRequest) {}
}

guard CommandLine.arguments.count == 2 else {
    FileHandle.standardError.write("usage: voice AUDIO\n".data(using: .utf8)!)
    exit(2)
}
do {
    let request = try SNClassifySoundRequest(classifierIdentifier: .version1)
    request.windowDuration = CMTime(seconds: 1.0, preferredTimescale: 1000)
    request.overlapFactor = 0.5
    let analyzer = try SNAudioFileAnalyzer(url: URL(fileURLWithPath: CommandLine.arguments[1]))
    let collector = Collector()
    try analyzer.add(request, withObserver: collector)
    analyzer.analyze()
    if let failure = collector.failure { throw failure }
    let rows = collector.rows.sorted { ($0["s"] ?? 0) < ($1["s"] ?? 0) }
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: rows))
} catch {
    FileHandle.standardError.write("voice: \(error)\n".data(using: .utf8)!)
    exit(1)
}
