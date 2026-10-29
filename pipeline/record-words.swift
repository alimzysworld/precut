// 48 kHz mono s16le on stdin, partial words as JSON lines on stdout.
// Uses the recorder's selected input. Never opens a second microphone or a URL.
import Foundation
import AVFoundation
import Speech

func emit(_ value: [String: Any]) {
    if let bytes = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(bytes + Data([10]))
    }
}
func unavailable() -> Never { emit(["words": [], "available": false]); exit(0) }
// The executable embeds its purpose string, including outside an app bundle.
guard Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") != nil,
      let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.supportsOnDeviceRecognition else { unavailable() }
var request: SFSpeechAudioBufferRecognitionRequest?
var task: SFSpeechRecognitionTask?
func recognize() {
    guard recognizer.isAvailable else { unavailable() }
    let next = SFSpeechAudioBufferRecognitionRequest()
    next.requiresOnDeviceRecognition = true
    next.shouldReportPartialResults = true
    next.taskHint = .dictation
    request = next
    emit(["words": [], "available": true])
    task = recognizer.recognitionTask(with: next) { result, error in
        if let result = result {
            emit(["words": result.bestTranscription.segments.map { $0.substring }])
            if result.isFinal { unavailable() }
        }
        if error != nil { unavailable() }
    }
}
switch SFSpeechRecognizer.authorizationStatus() {
case .authorized: recognize()
case .notDetermined:
    emit(["words": [], "available": false])
    // Authorization is an OS permission, never a server recognition request.
    // Drain stdin while the prompt is open; microphone capture must not wait.
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async { if status == .authorized { recognize() } else { unavailable() } }
    }
default: unavailable()
}
let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 48000, channels: 1, interleaved: false)!
DispatchQueue.global(qos: .userInitiated).async {
    var carry = Data()
    while true {
        let bytes = FileHandle.standardInput.readData(ofLength: 4800)
        if bytes.isEmpty { break }
        carry.append(bytes)
        let count = carry.count / 2
        if count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) {
            buffer.frameLength = AVAudioFrameCount(count)
            carry.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
                for i in 0..<count {
                    let sample = UInt16(raw[i * 2]) | UInt16(raw[i * 2 + 1]) << 8
                    buffer.floatChannelData![0][i] = Float(Int16(bitPattern: sample)) / 32768
                }
            }
            DispatchQueue.main.async { request?.append(buffer) }
            carry.removeFirst(count * 2)
        }
    }
    DispatchQueue.main.async {
        request?.endAudio()
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { task?.cancel(); exit(0) }
    }
}
RunLoop.main.run()
