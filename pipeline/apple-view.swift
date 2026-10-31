// AV1b and AV2: the Apple player inside precut's own window, behind the page.
// Built with pipeline/apple-composition.swift, pipeline/apple-look.swift and pipeline/apple-addon.c into
// build/tools/apple-player.node and loaded by src/main/apple-player.ts in main.
//
// Picture: a Metal layer backed view added to precut's window content view directly above the window's vibrancy view
// and below the web contents view, so captions, titles and the play bar (all page content) are always drawn on top.
// The page leaves the viewer's picture rect transparent while the Apple picture shows. A window move carries the view
// with it in the same frame; a resize keeps the view's top left offset until the page reports the new rect.
// AV2: AVPlayer composes the framed pictures (PictureCompositor); a presenter on the display link takes the picture
// due at each refresh from the player's own clock (AVPlayerItemVideoOutput), draws the Look on it (AppleLookRenderer)
// and presents it at that refresh. The Look is drawn at display time because AVPlayer composes about 0.7 s ahead: a
// Look drawn while composing showed a slider step that late (measured, qa/AV2). A Look change redraws at once.
//
// Sound: the same composition's audio mix (one builder, pipeline/apple-composition.swift), read through
// AVAssetReaderAudioMixOutput (the path `apple-player rms` measures) into an AVAudioEngine that stays running while an
// edit is loaded: three buses (voice with the plan's EQ, music, effects levelled under the voice with Audio Auto) into
// one limiter, the Chrome mix's chain (liveMix). AVPlayer's own audio route needs about 300 ms to start from pause on
// this Mac, so a timed start 80 ms ahead dropped the first 130 to 220 ms of sound (measured with calibrated audio taps,
// AV1b). The picture plays from a video only AVPlayer item, and both start on one host clock time: the player with
// setRate(atHostTime:), the sound with AVAudioPlayerNode.play(at:) less the output latency.
//
// Everything here runs on the main thread (Electron's main process thread is AppKit's), except the presenter (display
// link thread), the Look's queue, the sound queue and the sound taps, which share state only under locks.
import Foundation
import AVFoundation
import AVFAudio
import AudioToolbox
import AppKit
import CoreVideo
import QuartzCore

// MARK: events back to JavaScript

public typealias APVEmitter = @convention(c) (UnsafePointer<CChar>?) -> Void
private var emitter: APVEmitter?
@_cdecl("apv_set_emitter") public func apv_set_emitter(_ fn: APVEmitter?) { emitter = fn }
func emitEvent(_ value: [String: Any]) {
    let safe = jsonSafe(value)
    guard let fn = emitter, JSONSerialization.isValidJSONObject(safe),
          let data = try? JSONSerialization.data(withJSONObject: safe), let text = String(data: data, encoding: .utf8) else { return }
    text.withCString { fn($0) }
}
private func round3(_ value: Double) -> Double { (value * 1000).rounded() / 1000 }
private func round1(_ value: Double) -> Double { (value * 10).rounded() / 10 }
private func hostSeconds(_ hostTime: UInt64) -> Double { AVAudioTime.seconds(forHostTime: hostTime) }

/// AV2 QA: sample every displayed picture's brightness (black picture count). On for background QA launches only.
let watchPictures = ProcessInfo.processInfo.environment["PRECUT_QA_BACKGROUND"] == "1"

// MARK: views

/// Fills the window's content view, below the page. Flipped, so rects from the page (top left origin) apply as is.
final class PictureContainer: NSView {
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }
    override func isAccessibilityElement() -> Bool { false }
}

/// The picture: a Metal layer as the view's own backing layer, so frame changes never animate. AV2: the presenter
/// draws each framed picture into it with the Look at display time (AV1b used an AVPlayerLayer, which shows pictures
/// AVPlayer composed about 0.7 s earlier, so a Look change could not show within a frame). Tagged sRGB like the page.
final class PictureView: NSView {
    let metalLayer = CAMetalLayer()
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        metalLayer.device = AppleGPU.shared.device
        metalLayer.pixelFormat = .bgra8Unorm
        metalLayer.framebufferOnly = false
        metalLayer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
        metalLayer.isOpaque = true
        metalLayer.contentsGravity = .resize
        metalLayer.maximumDrawableCount = 3
        metalLayer.allowsNextDrawableTimeout = true
        metalLayer.backgroundColor = NSColor.black.cgColor
        wantsLayer = true
        layerContentsRedrawPolicy = .never
    }
    required init?(coder: NSCoder) { nil }
    override func makeBackingLayer() -> CALayer { metalLayer }
    override var isFlipped: Bool { true }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }
    override func isAccessibilityElement() -> Bool { false }
}

// MARK: playback stats (display link and sound tap write, main reads)

final class PlayStats {
    let lock = NSLock()
    var generation = 0
    var whenHost = 0.0          // host seconds picture and sound were asked to start
    var startItem = 0.0         // item seconds play started from
    var rate = 1.0
    var fps = 25.0
    var changes: [(host: Double, item: Double)] = []
    /// The first audible sample of this play: host seconds it reaches the output, and its item time.
    var sound: (host: Double, item: Double)?
    var soundScheduledLeadMs: Double?
    var listening = false        // the sound tap records the first audible sample of the current play
    /// AV2: a Look change waiting to be seen (its generation and when it was asked, host seconds), and what the
    /// display showed since: when each change first appeared, and pictures that were black (QA samples them).
    var pendingLook: (generation: Int, askedHost: Double, epochMs: Double)?
    /// A play is being measured (picture changes recorded for its opening and holds).
    var measuring = false
    /// A seek waiting for its picture on screen: target item seconds, when asked and when AVPlayer finished (host).
    var pendingSeek: (target: Double, askedHost: Double, seekedHost: Double)?
    var failedDraws = 0
    var droppedDrawables = 0
    var presentedDrawables = 0
    var drawableWaitMs = 0.0
    /// The longest Look draw on the GPU, and timed pictures the GPU finished after their refresh.
    var gpuMs = 0.0
    var latePictures = 0
    var lookShown: [[String: Any]] = []
    var blackPictures = 0
    var blackAt: [Double] = []
    var sampled = 0
    /// AV3: swaps handed to the presenter (when each was asked: host seconds and epoch ms), until their first picture shows.
    var swapAsked: [Int: (host: Double, epochMs: Double, startHost: Double?)] = [:]
    var swapShown: [[String: Any]] = []
}

/// AV5 QA (PRECUT_QA_BACKGROUND=1 only, and only while QA arms it): the exact pixels the presenter put into each
/// drawable it presented, read back from that drawable in the same command buffer, after the Look, the layout and
/// every picture of the moment were drawn into it. Nothing is drawn again: what is read is what the layer shows.
/// Each read carries its own sequence number, the item time of its picture and the refresh it was due on, so QA can
/// prove a grab belongs to the time it asked for (a window capture of the native view could hand back an older one).
///   full:  the newest presented drawable, kept whole (8 MB at 1080 x 1920) for `grab`.
///   probe: every presented drawable's 6 x 6 brightness grid over one rect, with its times (a cut's host time).
final class QaReadback {
    let lock = NSLock()
    var full = false
    var probe: (x: Double, y: Double, w: Double, h: Double)?
    var seq = 0
    private var pool: [MTLBuffer] = []
    private var next = 0
    struct Frame { let seq: Int; let item: Double; let due: Double; let look: Int; let fresh: Bool; let width: Int; let height: Int; let row: Int; let data: Data; let encodedHost: Double }
    var latest: Frame?
    /// When the system said each recent drawable reached the screen (0: it never did; absent: no word yet).
    var presented: [Int: Double] = [:]
    var probes: [[Double]] = []   // [seq, item, due host, fresh, presented host or -1, then a 6 x 6 luma grid]
    var armed: Bool { lock.lock(); defer { lock.unlock() }; return full || probe != nil }

    /// A buffer for the next read (four in turn: at most three drawables are in flight).
    func buffer(_ device: MTLDevice, length: Int) -> MTLBuffer? {
        lock.lock(); defer { lock.unlock() }
        if pool.count < 4 || pool[next % pool.count].length < length {
            guard let made = device.makeBuffer(length: length, options: .storageModeShared) else { return nil }
            if pool.count < 4 { pool.append(made) } else { pool[next % pool.count] = made }
            next += 1
            return made
        }
        defer { next += 1 }
        return pool[next % pool.count]
    }
    func nextSeq() -> Int { lock.lock(); defer { lock.unlock() }; seq += 1; return seq }

    /// The GPU finished the drawable: keep what QA asked for.
    func done(seq: Int, buffer: MTLBuffer, width: Int, height: Int, row: Int, item: Double, due: Double, look: Int, fresh: Bool) {
        lock.lock(); let keepFull = full, rect = probe; lock.unlock()
        let bytes = buffer.contents().assumingMemoryBound(to: UInt8.self)
        // A 6 x 6 grid of mean Rec.709 luma (0 to 255) over the rect, each cell from 8 x 8 samples of the BGRA pixels:
        // a cut shows as a jump between one picture's grid and the next.
        var grid: [Double] = []
        if let rect {
            let x0 = Double(width) * rect.x, y0 = Double(height) * rect.y, w = Double(width) * rect.w, h = Double(height) * rect.h
            for cy in 0..<6 { for cx in 0..<6 {
                var sum = 0.0
                for sy in 0..<8 { for sx in 0..<8 {
                    let x = min(width - 1, Int(x0 + w * (Double(cx * 8 + sx) + 0.5) / 48)), y = min(height - 1, Int(y0 + h * (Double(cy * 8 + sy) + 0.5) / 48)), p = bytes + y * row + x * 4
                    sum += 0.0722 * Double(p[0]) + 0.7152 * Double(p[1]) + 0.2126 * Double(p[2])
                } }
                grid.append((sum / 64 * 10).rounded() / 10)
            } }
        }
        let data = keepFull ? Data(bytes: bytes, count: row * height) : nil
        let host = CACurrentMediaTime()
        lock.lock()
        if let data { latest = Frame(seq: seq, item: item, due: due, look: look, fresh: fresh, width: width, height: height, row: row, data: data, encodedHost: host) }
        if rect != nil {
            probes.append([Double(seq), item, due, fresh ? 1 : 0, presented[seq] ?? -1] + grid)
            if probes.count > 20000 { probes.removeFirst(10000) }
        }
        lock.unlock()
    }
    func wasPresented(seq: Int, host: Double) {
        lock.lock()
        presented[seq] = host
        if presented.count > 400 { for key in presented.keys.sorted().prefix(200) { presented.removeValue(forKey: key) } }
        if let i = probes.lastIndex(where: { Int($0[0]) == seq }) { probes[i][4] = host }
        lock.unlock()
    }
}

/// What a picture's Look depends on, as a string: its piece's tables and numbers and the edit's finish.
func appleLookKey(_ snap: AppleLookState.Snapshot) -> String {
    let c = snap.colour
    let table = c?.table.map { "\(ObjectIdentifier($0).hashValue)" } ?? "-", lattice = c?.lattice.map { "\(ObjectIdentifier($0).hashValue)" } ?? "-"
    let g = snap.grain.map { "\($0.amount),\($0.size),\($0.roughness),\($0.colour),\($0.shadows),\($0.highlights)" } ?? "-"
    let v = snap.vignette.map { "\($0.amount),\($0.midpoint),\($0.feather)" } ?? "-"
    let d = snap.detail.map { "\($0.amount),\($0.radius),\($0.detail),\($0.masking),\($0.texture),\($0.clarity),\($0.diffusion)" } ?? "-"
    let t = c?.transform.map { $0.map { "\($0)" }.joined(separator: ",") } ?? "-"
    return "\(snap.start ?? -1)|\(c?.mode ?? 0)|\(table)|\(lattice)|\(c?.diffusion ?? -1)|\(g)|\(v)|\(d)|\(snap.scoped)|\(t)"
}

/// AV4: what a whole composed picture's drawing depends on: its span, each picture's Look and the edit's finish.
func appleFrameKey(_ frame: AppleLookState.FrameSnapshot) -> String {
    let parts = frame.layers.map { layer in
        appleLookKey(AppleLookState.Snapshot(start: layer.start, colour: layer.colour, grain: frame.grain, vignette: frame.vignette, detail: frame.detail, scoped: frame.scoped, fps: frame.fps, generation: frame.generation, ready: frame.ready))
    }
    return "\(frame.span ?? -1)|\(frame.bypass)|" + parts.joined(separator: "/")
}

/// A value a completion handler fills in for a later one.
final class Box<T> { var value: T; init(_ value: T) { self.value = value } }

/// AV2 QA: the mean of a sparse grid of a picture's pixels (0 to 255), to count black pictures on the display.
func sampleLuma(_ buffer: CVPixelBuffer) -> Double {
    guard CVPixelBufferLockBaseAddress(buffer, .readOnly) == kCVReturnSuccess else { return -1 }
    defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buffer) else { return -1 }
    let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer), row = CVPixelBufferGetBytesPerRow(buffer)
    let bytes = base.assumingMemoryBound(to: UInt8.self)
    var sum = 0.0, n = 0
    for gy in 1...8 { for gx in 1...8 {
        let x = width * gx / 9, y = height * gy / 9, p = bytes + y * row + x * 4
        sum += 0.0722 * Double(p[0]) + 0.7152 * Double(p[1]) + 0.2126 * Double(p[2]); n += 1
    } }
    return sum / Double(max(1, n))
}

// MARK: sound

/// AV2: effects level under voice, the Chrome mix's rule (liveMix sync): with Audio Auto on, once the voice bus
/// (after its EQ, before the mix's output level) passes 0.025 RMS, effects drop by (0.025 / rms)^(5/6), the export's
/// 6:1 sidechain curve. `outputDb` is the mix's output level the plan baked into every segment, taken back out.
func appleEffectsDuck(voiceRms: Double, auto: Bool, outputDb: Double = 0) -> Double {
    let rms = voiceRms / pow(10, outputDb / 20)
    guard auto, rms > 0.025 else { return 1 }
    return pow(0.025 / rms, 5.0 / 6.0)
}

/// One bus of the edit's sound (voice, music or effects), read ahead from its own tracks of the composition's
/// audio mix. Same read-ahead and timed start as the single stream AV1b measured; buses start on one host time.
final class BusStream {
    let node = AVAudioPlayerNode()
    let pitch = AVAudioUnitTimePitch()
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private var asset: AVAsset?
    private var tracks: [AVAssetTrack] = []
    private var mix: AVAudioMix?
    private var durationS = 0.0
    private var reader: AVAssetReader?
    private var output: AVAssetReaderAudioMixOutput?
    private var pending: [AVAudioPCMBuffer] = []
    private var pendingFrames = 0
    private var preparedAt: Double?
    private var finished = false
    private var playing = false
    private var scheduledFrames = 0
    private var rate = 1.0
    private var token = 0
    /// AV3: buffers handed to the node and not yet consumed, with the node sample (item paced, from this play's start)
    /// each begins at. The node reads a buffer's memory as it renders it (checked: a scheduled buffer rewritten before
    /// it plays is heard rewritten), so an edit landing while playing rewrites the samples not yet rendered.
    private var inFlight: [(buffer: AVAudioPCMBuffer, start: Int)] = []
    /// The node sample after the last one scheduled, and where the next buffer must start if the node ran dry.
    private var scheduledEnd = 0
    private var nextAt: Int? = nil
    /// The first buffer a reader gives is cut to the asked time (a play's start, or an edit's splice point).
    private var trimNext = true
    /// The item time this play started from (node sample 0), and the host time the node started.
    private var playStart = 0.0
    private var startHost = 0.0
    var renderLeadMs = 0.0, lateSpliceMs = 0.0

    func configure(asset: AVAsset, tracks: [AVAssetTrack], mix: AVAudioMix?, durationS: Double) {
        stopLocked(); dropReaderLocked()
        self.asset = asset; self.tracks = tracks; self.mix = mix; self.durationS = durationS
    }
    func clear() { stopLocked(); dropReaderLocked(); asset = nil; tracks = []; mix = nil }
    func prepareLocked(at: Double, seconds: Double) {
        if preparedAt.map({ abs($0 - at) < 0.0005 }) == true && (finished || pendingFrames >= Int(seconds * format.sampleRate) / 2) { return }
        dropReaderLocked()
        guard let asset, !tracks.isEmpty, durationS > at + 0.001 else { finished = true; preparedAt = at; return }
        do {
            let made = try AVAssetReader(asset: asset)
            let settings: [String: Any] = [AVFormatIDKey: kAudioFormatLinearPCM, AVSampleRateKey: format.sampleRate, AVNumberOfChannelsKey: 2,
                                           AVLinearPCMBitDepthKey: 32, AVLinearPCMIsFloatKey: true, AVLinearPCMIsNonInterleaved: true, AVLinearPCMIsBigEndianKey: false]
            let out = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: settings)
            out.audioMix = mix
            out.alwaysCopiesSampleData = false
            // AV3: a sped up piece keeps its pitch (the voice keeps its pitch at any speed, as in the viewer and export).
            out.audioTimePitchAlgorithm = .spectral
            guard made.canAdd(out) else { finished = true; preparedAt = at; return }
            made.add(out)
            made.timeRange = CMTimeRange(start: CMTime(seconds: at, preferredTimescale: 48000), end: CMTime(seconds: durationS, preferredTimescale: 48000))
            guard made.startReading() else { finished = true; preparedAt = at; return }
            reader = made; output = out; preparedAt = at; trimNext = true
            readLocked(until: Int(seconds * format.sampleRate))
        } catch { finished = true; preparedAt = at }
    }
    private func readLocked(until frames: Int) {
        guard let output, let start = preparedAt else { return }
        while pendingFrames < frames && !finished {
            guard let sample = output.copyNextSampleBuffer() else { finished = true; break }
            let count = CMSampleBufferGetNumSamples(sample)
            guard count > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { continue }
            buffer.frameLength = AVAudioFrameCount(count)
            guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList) == noErr else { continue }
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample))
            var use = buffer
            if !trimNext { pending.append(use); pendingFrames += Int(use.frameLength); continue }
            if pts < start - 0.5 / format.sampleRate {
                let skip = min(count, Int(((start - pts) * format.sampleRate).rounded()))
                if skip >= count { continue }
                guard let trimmed = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count - skip)) else { continue }
                trimmed.frameLength = AVAudioFrameCount(count - skip)
                for c in 0..<Int(format.channelCount) {
                    if let from = buffer.floatChannelData?[c], let to = trimmed.floatChannelData?[c] { memcpy(to, from + skip, (count - skip) * MemoryLayout<Float>.size) }
                }
                use = trimmed
            }
            trimNext = false
            pending.append(use); pendingFrames += Int(use.frameLength)
        }
    }
    private func feedLocked(_ myToken: Int, queue: DispatchQueue) {
        guard myToken == token, playing else { return }
        // Read a second ahead, hand the node 0.4 s of it: an edit landing while playing rewrites only what the node holds.
        let readAhead = Int(format.sampleRate * max(1, rate) * 1.0), ahead = Int(format.sampleRate * max(1, rate) * 0.4)
        if pendingFrames < readAhead { readLocked(until: readAhead) }
        while scheduledFrames < ahead, !pending.isEmpty {
            let buffer = pending.removeFirst()
            pendingFrames -= Int(buffer.frameLength)
            scheduledFrames += Int(buffer.frameLength)
            let frames = Int(buffer.frameLength)
            let start = nextAt ?? scheduledEnd
            inFlight.append((buffer, start))
            scheduledEnd = start + frames
            let done: AVAudioPlayerNodeCompletionHandler = { [weak self] _ in
                queue.async {
                    guard let self, myToken == self.token else { return }
                    self.scheduledFrames -= frames
                    if let i = self.inFlight.firstIndex(where: { $0.buffer === buffer }) { self.inFlight.remove(at: i) }
                    self.feedLocked(myToken, queue: queue)
                }
            }
            // After a gap (the node ran dry, or an edit brought sound where there was none) the buffer is placed at its
            // own sample, on the node's clock; otherwise it follows the one before.
            if let at = nextAt { nextAt = nil; node.scheduleBuffer(buffer, at: AVAudioTime(sampleTime: AVAudioFramePosition(at), atRate: format.sampleRate), options: [], completionCallbackType: .dataConsumed, completionHandler: done) }
            else { node.scheduleBuffer(buffer, completionCallbackType: .dataConsumed, completionHandler: done) }
        }
    }

    /// AV3: an edit landed while this bus plays. From item time `at` (`startItem` is this play's start), the bus plays
    /// the new plan's sound: samples already handed to the node from there on are rewritten in place, with a 2 ms cross
    /// fade at the splice, and the new reader carries on after them. Nothing stops, so the sound never restarts. False
    /// when the node has already rendered too close to `at` (the caller picks a later point).
    /// AV3, first step of a splice: the new plan's sound read from item time `wanted` (enough to cover what is already
    /// scheduled past it, and a little more), its reader taking over this bus's reading. Nothing heard changes yet.
    private var spliceFrom = 0
    func prepareSpliceLocked(asset: AVAsset, tracks: [AVAssetTrack], mix: AVAudioMix?, durationS: Double, at wanted: Double) {
        let sr = format.sampleRate
        spliceFrom = Int(((wanted - playStart) * sr).rounded())
        dropReaderLocked()
        self.asset = asset; self.tracks = tracks; self.mix = mix; self.durationS = durationS
        let cover = max(0, scheduledEnd - spliceFrom)
        if !tracks.isEmpty && durationS > wanted + 0.001 {
            prepareLocked(at: wanted, seconds: 0)
            readLocked(until: cover + Int(0.15 * sr))
        } else { finished = true }
    }
    /// The first node sample this bus may still change (one render slice and 10 ms past what it last rendered).
    func firstChangeableLocked() -> Int {
        guard let rendered = node.lastRenderTime, let player = node.playerTime(forNodeTime: rendered) else { return 0 }
        renderLeadMs = (Double(player.sampleTime) / format.sampleRate / max(0.01, rate) - (CACurrentMediaTime() - startHost)) * 1000
        return Int(player.sampleTime) + 1024 + Int(0.01 * format.sampleRate * max(1, rate))
    }
    /// Second step, all buses at one node sample (`splice`, at or after the prepared point): the samples already
    /// handed to the node from there on are rewritten with the new sound, a 2 ms cross fade at the splice, and the
    /// new reader carries on after them.
    func commitSpliceLocked(at splice: Int, queue: DispatchQueue) {
        let sr = format.sampleRate
        lateSpliceMs = Double(splice - spliceFrom) / sr * 1000
        dropTaken(max(0, splice - spliceFrom))
        let cover = max(0, scheduledEnd - splice)
        let fade = Int(0.002 * sr)
        for (buffer, start) in inFlight {
            let length = Int(buffer.frameLength)
            guard start + length > splice, let channels = buffer.floatChannelData else { continue }
            for i in max(0, splice - start)..<length {
                let n = start + i - splice
                let w = n < fade ? Float(n + 1) / Float(fade + 1) : 1
                for c in 0..<Int(format.channelCount) { channels[c][i] = channels[c][i] * (1 - w) + takeSample(n, channel: c) * w }
            }
        }
        dropTaken(cover)
        // The node ran dry before the splice (or never had sound): the new sound starts at its own sample.
        if scheduledEnd < splice { nextAt = splice; scheduledEnd = splice }
        feedLocked(token, queue: queue)
    }
    var isPlayingLocked: Bool { playing }
    var playStartItem: Double { playStart }
    /// Sample `n` (from the splice point) of the newly read sound, channel `c`; silence past its end.
    private func takeSample(_ n: Int, channel c: Int) -> Float {
        var offset = n
        for buffer in pending {
            let length = Int(buffer.frameLength)
            if offset < length { return buffer.floatChannelData?[c][offset] ?? 0 }
            offset -= length
        }
        return 0
    }
    /// Drop the first `count` frames of the newly read sound (they were written into scheduled buffers).
    private func dropTaken(_ count: Int) {
        var left = count
        while left > 0, let first = pending.first {
            let length = Int(first.frameLength)
            if length <= left { pending.removeFirst(); pendingFrames -= length; left -= length; continue }
            guard let rest = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(length - left)) else { pending.removeFirst(); pendingFrames -= length; break }
            rest.frameLength = AVAudioFrameCount(length - left)
            for c in 0..<Int(format.channelCount) {
                if let from = first.floatChannelData?[c], let to = rest.floatChannelData?[c] { memcpy(to, from + left, (length - left) * MemoryLayout<Float>.size) }
            }
            pending[0] = rest; pendingFrames -= left; left = 0
        }
    }
    /// AV4: false until the node has rendered since the engine (re)started. AVAudioPlayerNode.play(at:) with a host time
    /// raises "player did not see an IO cycle" (an Objective-C exception, which takes the app down) when asked before
    /// that; PAR1 saw it once in 8 fast play and pause starts.
    var sawIO: Bool { node.engine?.isRunning == true && node.lastRenderTime?.isSampleTimeValid == true }
    func startLocked(at: Double, rate: Double, audibleAt: Double, queue: DispatchQueue) {
        stopLocked()
        prepareLocked(at: at, seconds: 0.5)
        inFlight = []; scheduledEnd = 0; nextAt = nil; playStart = at; startHost = audibleAt
        self.rate = rate
        pitch.rate = Float(rate)
        pitch.bypass = abs(rate - 1) < 1e-6
        token += 1
        playing = true
        feedLocked(token, queue: queue)
        // A node that has not rendered yet starts on its first cycle instead (a few milliseconds late at worst).
        startedTimed = sawIO
        if sawIO { node.play(at: AVAudioTime(hostTime: AVAudioTime.hostTime(forSeconds: audibleAt))) }
        else if node.engine?.isRunning == true { node.play() }
    }
    /// AV6 (QA): whether this play's start was timed, and where the node's sample 0 sits on the host clock against the
    /// asked start (ms; 0 is exact), from the node's own render clock.
    var startedTimed = false
    var startOffsetMs: Double? {
        guard playing, let rendered = node.lastRenderTime, rendered.isHostTimeValid, let player = node.playerTime(forNodeTime: rendered) else { return nil }
        return ((hostSeconds(rendered.hostTime) - Double(player.sampleTime) / format.sampleRate) - startHost) * 1000
    }
    func stopLocked() {
        token += 1
        let wasPlaying = playing
        if playing || node.isPlaying { node.stop() }
        playing = false; scheduledFrames = 0; inFlight = []; scheduledEnd = 0; nextAt = nil
        if wasPlaying { dropReaderLocked() }
    }
    private func dropReaderLocked() {
        reader?.cancelReading(); reader = nil; output = nil
        pending = []; pendingFrames = 0; preparedAt = nil; finished = false
    }
}

/// The edit's sound on a running AVAudioEngine: three buses (voice with its EQ, music, effects levelled under
/// the voice) into one limiter, the Chrome mix's chain (liveMix). Segment levels and ducking stay in the mix.
final class SoundEngine {
    let engine = AVAudioEngine()
    let format = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    let queue = DispatchQueue(label: "com.sidething.precut.apple-sound", qos: .userInteractive)
    let stats: PlayStats
    let voice = BusStream()
    let music = BusStream()
    let effects = BusStream()
    let eq = AVAudioUnitEQ(numberOfBands: 3)
    // The SDK ships no Swift wrapper for the dynamics processor, so the Apple unit is loaded by component.
    let limiter = AVAudioUnitEffect(audioComponentDescription: AudioComponentDescription(
        componentType: kAudioUnitType_Effect, componentSubType: kAudioUnitSubType_DynamicsProcessor,
        componentManufacturer: kAudioUnitManufacturer_Apple, componentFlags: 0, componentFlagsMask: 0))
    let voiceMixer = AVAudioMixerNode()
    let musicMixer = AVAudioMixerNode()
    let effectsMixer = AVAudioMixerNode()
    let sumMixer = AVAudioMixerNode()
    var eqGains: [Double] = [0, 0, 0]
    var autoLevel = true
    var outputDb = 0.0
    var lastDuck = 1.0
    var playing = false
    var running: Bool { engine.isRunning }

    init(stats: PlayStats) {
        self.stats = stats
        for bus in [voice, music, effects] { engine.attach(bus.node); engine.attach(bus.pitch); bus.pitch.bypass = true }
        engine.attach(eq); engine.attach(limiter); engine.attach(voiceMixer); engine.attach(musicMixer); engine.attach(effectsMixer); engine.attach(sumMixer)
        // Voice: node, pitch, the plan's EQ (liveMix: low shelf 120, peak 2.5 kHz, high shelf 8 kHz), then its mixer.
        engine.connect(voice.node, to: voice.pitch, format: format)
        engine.connect(voice.pitch, to: eq, format: format)
        engine.connect(eq, to: voiceMixer, format: format)
        engine.connect(music.node, to: music.pitch, format: format)
        engine.connect(music.pitch, to: musicMixer, format: format)
        engine.connect(effects.node, to: effects.pitch, format: format)
        engine.connect(effects.pitch, to: effectsMixer, format: format)
        // One limiter on the sum, as in liveMix (threshold -1.5 dB, fast attack, 100 ms release, near 20 to 1).
        // Parameters are set once the engine has instantiated the unit (see startEngine).
        // The three buses sum in their own mixer (one input bus each) before the one limiter.
        engine.connect(voiceMixer, to: sumMixer, fromBus: 0, toBus: 0, format: format)
        engine.connect(musicMixer, to: sumMixer, fromBus: 0, toBus: 1, format: format)
        engine.connect(effectsMixer, to: sumMixer, fromBus: 0, toBus: 2, format: format)
        engine.connect(sumMixer, to: limiter, format: format)
        engine.connect(limiter, to: engine.mainMixerNode, format: format)
        let bands: [(AVAudioUnitEQFilterType, Float)] = [(.lowShelf, 120), (.parametric, 2500), (.highShelf, 8000)]
        for (index, band) in bands.enumerated() {
            eq.bands[index].filterType = band.0; eq.bands[index].frequency = band.1
            eq.bands[index].bandwidth = 1.9; eq.bands[index].gain = 0; eq.bands[index].bypass = false
        }
        eq.globalGain = 0
        voice.node.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, when in self?.listen(buffer, when) }
        // The voice as the Chrome mix's analyser hears it: after the EQ. Effects follow it (Audio Auto).
        eq.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, _ in self?.level(buffer) }
        // QA (background launches with --precut-apple-sound-tap): the whole mix after the limiter, as heard, in 2 ms
        // windows on the edit's clock, so QA can hold it against the export. Never on for a person.
        if watchPictures && ProcessInfo.processInfo.arguments.contains("--precut-apple-sound-tap") {
            limiter.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, when in self?.record(buffer, when) }
        }
        NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            // The output device changed (headphones, a display): the engine stopped. Start it again; the next play reschedules.
            self?.queue.async { self?.stopLocked(); self?.startEngine(onQueue: true) }
        }
    }

    func startEngine(onQueue: Bool = false) {
        if engine.isRunning { return }
        engine.prepare()
        // The limiter's values, in the Chrome chain's terms, now that its audio unit exists.
        let unit = limiter.audioUnit
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_Threshold, kAudioUnitScope_Global, 0, -1.5, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_HeadRoom, kAudioUnitScope_Global, 0, 1.5, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_ExpansionRatio, kAudioUnitScope_Global, 0, 1, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_ExpansionThreshold, kAudioUnitScope_Global, 0, -60, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_AttackTime, kAudioUnitScope_Global, 0, 0.001, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_ReleaseTime, kAudioUnitScope_Global, 0, 0.1, 0)
        AudioUnitSetParameter(unit, kDynamicsProcessorParam_OverallGain, kAudioUnitScope_Global, 0, 0, 0)
        do { try engine.start() } catch { emitEvent(["type": "soundFailed", "message": String(describing: error)]); return }
        // AV6: every bus's player runs (idle, nothing scheduled) from the engine's start. A player's first play(at:)
        // after the engine starts can begin its buffers up to a render cycle after the host time asked while its own
        // clock still says it began on time: measured 16 to 24 ms on the effects bus on a first play (qa/AV6
        // bus-sync.mjs, AV5 lipsync), 0 on every later play, whose player had played and stopped before. A play
        // stops these idle players and starts them on the asked host time, as every later play does.
        let warm = { if !self.playing { for bus in [self.voice, self.music, self.effects] where !bus.node.isPlaying { bus.node.play() } } }
        if onQueue { warm() } else { queue.sync(execute: warm) }
    }

    func setMuted(_ muted: Bool) { engine.mainMixerNode.outputVolume = muted ? 0 : 1 }

    /// Output latency: from a sample leaving the voice node to the speaker. AV4: every unit on the way counts, bypassed
    /// or not. Measured on this Mac (realtime, output silent): a click left the limiter 4352 samples (90.7 ms) after it
    /// left its player, the time pitch unit's reported 85.3 ms (bypassed) plus the limiter's 5.3 ms; the engine does no
    /// latency compensation. AV1 to PAR1 counted none of it, so the sound was heard about 90 ms after its picture (the
    /// QA tap after the limiter read +90 ms and was right).
    var latency: Double { engine.outputNode.presentationLatency + pathLatency }
    /// Every bus passes one time pitch unit and the limiter; the voice also its EQ (the same reported latency, 0).
    var pathLatency: Double { voice.pitch.auAudioUnit.latency + eq.auAudioUnit.latency + limiter.auAudioUnit.latency }

    /// Split the composition's tracks by kind (the builder's order) and give each bus its own slice of the mix.
    func configure(asset: AVAsset, mix: AVAudioMix?, kinds: [String] = [], eq: [Double] = [0, 0, 0], auto: Bool = true, outputDb: Double = 0, durationS: Double) {
        eqGains = [eq.count > 0 ? eq[0] : 0, eq.count > 1 ? eq[1] : 0, eq.count > 2 ? eq[2] : 0]
        autoLevel = auto
        self.outputDb = outputDb
        for (index, gain) in eqGains.enumerated() { self.eq.bands[index].gain = Float(max(-24, min(24, gain))) }
        effectsMixer.outputVolume = 1; lastDuck = 1
        queue.sync {
            stopLocked()
            let parts = slices(asset: asset, mix: mix, kinds: kinds)
            voice.configure(asset: asset, tracks: parts[0].tracks, mix: parts[0].mix, durationS: durationS)
            music.configure(asset: asset, tracks: parts[1].tracks, mix: parts[1].mix, durationS: durationS)
            effects.configure(asset: asset, tracks: parts[2].tracks, mix: parts[2].mix, durationS: durationS)
        }
        startEngine()
    }

    /// The composition's tracks by bus (voice, music, effects), each with its own slice of the mix.
    /// A kind mismatch (an older manifest) keeps every track on the voice bus, as AV1b played it.
    private func slices(asset: AVAsset, mix: AVAudioMix?, kinds: [String]) -> [(tracks: [AVAssetTrack], mix: AVAudioMix?)] {
        let tracks = asset.tracks(withMediaType: .audio)
        guard kinds.count == tracks.count else { return [(tracks, mix), ([], nil), ([], nil)] }
        func slice(_ wanted: (String) -> Bool) -> (tracks: [AVAssetTrack], mix: AVAudioMix?) {
            let picked = zip(tracks, kinds).filter { wanted($0.1) }
            guard !picked.isEmpty else { return ([], nil) }
            guard let mix, let all = (mix as? AVMutableAudioMix)?.inputParameters ?? (mix.inputParameters as? [AVMutableAudioMixInputParameters]) else { return (picked.map { $0.0 }, mix) }
            let params = all.filter { param in picked.contains { $0.0.trackID == param.trackID } }
            let sub = AVMutableAudioMix(); sub.inputParameters = params
            return (picked.map { $0.0 }, sub)
        }
        // AV4: a bleep's beep plays into the mix's output, as the viewer's tone does: on the music bus, which carries
        // no processing of its own (no EQ, no levelling under the voice).
        return [slice { $0 == "clip" || $0 == "voiceover" }, slice { $0 == "music" || $0 == "tone" }, slice { $0 == "effect" }]
    }

    /// AV3: an edit landed while playing. Every bus plays the new plan's sound from one item time on, in place (see
    /// BusStream: no stop, no restart), at `at` or, for a bus whose render head passed it meanwhile, just after its
    /// head. Returns the latest item time a bus's sound changes at (the picture changes at `at`).
    func splice(asset: AVAsset, mix: AVAudioMix?, kinds: [String], eq: [Double], auto: Bool, outputDb: Double, durationS: Double, at: Double) -> Double {
        var changed = at
        queue.sync {
            let parts = slices(asset: asset, mix: mix, kinds: kinds)
            let buses = [voice, music, effects]
            guard voice.isPlayingLocked else {
                for (bus, part) in zip(buses, parts) { bus.configure(asset: asset, tracks: part.tracks, mix: part.mix, durationS: durationS) }
                return
            }
            // Bus by bus, each read and written in one go (a read of all three first let the render head run past the
            // point under load: measured 50 to 260 ms late against 0 to 22 ms this way).
            let sr = format.sampleRate, start = voice.playStartItem, wanted = Int(((at - start) * sr).rounded())
            var latest = wanted
            for (bus, part) in zip(buses, parts) {
                bus.prepareSpliceLocked(asset: asset, tracks: part.tracks, mix: part.mix, durationS: durationS, at: at)
                let sample = max(wanted, bus.firstChangeableLocked())
                bus.commitSpliceLocked(at: sample, queue: queue)
                latest = max(latest, sample)
            }
            changed = start + Double(latest) / sr
        }
        eqGains = [eq.count > 0 ? eq[0] : 0, eq.count > 1 ? eq[1] : 0, eq.count > 2 ? eq[2] : 0]
        autoLevel = auto
        self.outputDb = outputDb
        for (index, gain) in eqGains.enumerated() { self.eq.bands[index].gain = Float(max(-24, min(24, gain))) }
        return changed
    }
    /// The voice bus's last splice check: render head ahead of its start clock, room to the splice point (ms).
    var spliceCheck: [String: Double] { ["renderLeadMs": (voice.renderLeadMs * 10).rounded() / 10, "lateSpliceMs": (voice.lateSpliceMs * 10).rounded() / 10] }
    /// True while a play's sound runs.
    var isPlaying: Bool { queue.sync { playing } }

    func clear() {
        queue.sync { stopLocked(); voice.clear(); music.clear(); effects.clear() }
    }

    /// Read the first moments of sound at `at`, so Play can start at once. Safe to call on every seek.
    func prepare(at: Double) {
        queue.async { [weak self] in
            guard let self, !self.playing else { return }
            self.voice.prepareLocked(at: at, seconds: 0.5)
            self.music.prepareLocked(at: at, seconds: 0.5)
            self.effects.prepareLocked(at: at, seconds: 0.5)
        }
    }

    /// Start at item `at`, heard at host seconds `whenHost`. Returns how long reading the opening took (ms).
    @discardableResult
    func start(at: Double, rate: Double, whenHost: Double) -> Double {
        let begun = CACurrentMediaTime()
        startEngine()
        // AV4: an engine just (re)started has not rendered yet: wait for its first cycle (bounded), so the buses can
        // start on the host time (see BusStream.sawIO).
        let deadline = CACurrentMediaTime() + 0.1
        while engine.isRunning && !voice.sawIO && CACurrentMediaTime() < deadline { usleep(2000) }
        queue.sync {
            stopLocked()
            let audibleAt = whenHost - latency
            stats.lock.lock()
            stats.listening = true
            stats.soundScheduledLeadMs = round1((audibleAt - CACurrentMediaTime()) * 1000)
            stats.lock.unlock()
            playing = true
            tapLock.lock(); tapStart = (at, audibleAt, rate); tapLock.unlock()
            voice.startLocked(at: at, rate: rate, audibleAt: audibleAt, queue: queue)
            music.startLocked(at: at, rate: rate, audibleAt: audibleAt, queue: queue)
            effects.startLocked(at: at, rate: rate, audibleAt: audibleAt, queue: queue)
        }
        return (CACurrentMediaTime() - begun) * 1000
    }

    func stop() { queue.sync { stopLocked() } }

    private func stopLocked() {
        playing = false
        stats.lock.lock(); stats.listening = false; stats.lock.unlock()
        voice.stopLocked(); music.stopLocked(); effects.stopLocked()
    }

    /// QA sound tap state: the play's start (item seconds, and the render host time it starts at) and 2 ms windows.
    let tapLock = NSLock()
    var tapStart: (item: Double, host: Double, rate: Double)?
    var tapWindows: [[Double]] = []   // [item seconds, sum of squares, samples]
    private func record(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let sr = buffer.format.sampleRate, window = Int(sr / 500), frames = Int(buffer.frameLength), count = Int(buffer.format.channelCount)
        // 2 ms sums now; placed on the edit's clock later, off the tap (see mapQueue).
        var sums: [(offset: Int, sum: Double, n: Int)] = []
        var at = 0
        while at < frames {
            let end = min(frames, at + window); var sum = 0.0
            for i in at..<end { for c in 0..<count { let v = Double(channels[c][i]); sum += v * v } }
            sums.append((at, sum, (end - at) * count)); at = end
        }
        mapQueue.async { [weak self] in
            guard let self else { return }
            self.tapLock.lock(); let start = self.tapStart; self.tapLock.unlock()
            // Placed by sample count from the voice player's own start (the mapping the first audible sample uses):
            // every bus starts on one host time, so the voice node's clock is the play's.
            guard let start, let played = self.voice.node.playerTime(forNodeTime: when) else { return }
            // AV4: this tap is after the time pitch unit and the limiter: what it renders at the voice player's sample n
            // left that player the path's latency earlier, so its content is n less the path (it read +90 ms before).
            let first = start.item + (Double(played.sampleTime) / sr - self.pathLatency) * start.rate
            // AV5: when each window is heard, on the host clock: the render cycle's own host time plus the output's
            // presentation latency (the tap is after the limiter, the last unit with latency). -1 when not known.
            let heard = when.isHostTimeValid ? hostSeconds(when.hostTime) + self.engine.outputNode.presentationLatency : -1
            self.tapLock.lock()
            for w in sums { self.tapWindows.append([first + Double(w.offset) / sr * start.rate, w.sum, Double(w.n), heard < 0 ? -1 : heard + Double(w.offset) / sr]) }
            if self.tapWindows.count > 60000 { self.tapWindows.removeFirst(20000) }
            self.tapLock.unlock()
        }
    }

    /// Work a tap hands off: a tap block must never call into the engine (setting a node's volume or asking a
    /// player's time takes the engine's lock, which a node's stop holds while it waits for the tap: a deadlock seen
    /// at the end of a play). Nothing waits on this queue.
    let mapQueue = DispatchQueue(label: "com.sidething.precut.apple-sound-map", qos: .userInitiated)
    private let duckLock = NSLock()
    private var duckWanted = 1.0
    private var duckQueued = false

    /// The EQ tap: effects levelling under the voice, from the last 512 samples (the Chrome analyser's window).
    private func level(_ buffer: AVAudioPCMBuffer) {
        guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let frames = Int(buffer.frameLength), count = max(1, Int(buffer.format.channelCount))
        let from = max(0, frames - 512)
        var sum = 0.0
        // The analyser reads the bus downmixed to one channel.
        for i in from..<frames { var v = 0.0; for c in 0..<count { v += Double(channels[c][i]) }; v /= Double(count); sum += v * v }
        let rms = sqrt(sum / Double(max(1, frames - from)))
        let duck = appleEffectsDuck(voiceRms: rms, auto: autoLevel, outputDb: outputDb)
        lastDuck = duck
        duckLock.lock(); duckWanted = duck; let queue = !duckQueued; duckQueued = true; duckLock.unlock()
        if queue { mapQueue.async { [weak self] in
            guard let self else { return }
            self.duckLock.lock(); let value = self.duckWanted; self.duckQueued = false; self.duckLock.unlock()
            self.effectsMixer.outputVolume = Float(value)
        } }
    }

    /// The voice tap: the first audible sample of a play.
    private func listen(_ buffer: AVAudioPCMBuffer, _ when: AVAudioTime) {
        stats.lock.lock()
        let wanted = stats.sound == nil && stats.listening && when.isHostTimeValid
        let generation = stats.generation, startItem = stats.startItem, rate = stats.rate
        stats.lock.unlock()
        guard wanted, let channels = buffer.floatChannelData else { return }
        let frames = Int(buffer.frameLength)
        var first: Int? = nil
        outer: for i in 0..<frames {
            for c in 0..<Int(buffer.format.channelCount) where abs(channels[c][i]) > 1e-5 { first = i; break outer }
        }
        guard let first else { return }
        let sr = buffer.format.sampleRate
        mapQueue.async { [weak self] in
            guard let self, let playerTime = self.voice.node.playerTime(forNodeTime: when) else { return }
            // Node time runs at the item's own pace; the time pitch unit after it plays it at `rate`.
            let item = startItem + (Double(playerTime.sampleTime) + Double(first)) / sr
            let host = hostSeconds(when.hostTime) + Double(first) / sr / max(0.01, rate) + self.latency
            self.stats.lock.lock()
            if self.stats.sound == nil && self.stats.listening && self.stats.generation == generation { self.stats.sound = (host, item) }
            self.stats.lock.unlock()
        }
    }

    func shutdown() {
        queue.sync { stopLocked(); voice.clear(); music.clear(); effects.clear() }
        engine.stop()
    }
}

// MARK: the player host

final class ApplePlayerHost: NSObject {
    static let shared = ApplePlayerHost()
    var container: PictureContainer?
    var picture: PictureView?
    weak var window: NSWindow?
    var player: AVPlayer?
    var videoOutput: AVPlayerItemVideoOutput?
    var timeObserver: Any?
    var statusObservation: NSKeyValueObservation?
    var endObserver: NSObjectProtocol?
    var pendingPlay: (Double, Double)?
    /// AV4: raised by every play, pause and seek; a play whose preroll lands after a newer command does not start.
    var playToken = 0
    var muted = false { didSet { sound?.setMuted(muted) } }
    var fps = 25.0
    var loadGeneration = 0
    let stats = PlayStats()
    /// AV5 QA: reads back what the presenter presented (armed by QA only).
    let qa = QaReadback()
    var sound: SoundEngine?
    /// The presenter's display link (AV2: it runs while an edit is loaded, and measures plays as it presents).
    var displayLink: CVDisplayLink?
    var measuring = false
    var openingTimer: Timer?
    var lastOpening: [String: Any]?
    var lastHolds: [String: Any]?
    /// Every piece's timeline span and the reel times of the source pictures it shows (from its file's own picture
    /// times, through its clock). An edit mixes 25p, 30p, 60p and variable rate clips, and AV3 speed: "every picture"
    /// and "a picture's interval" come from the files and the piece's clock.
    struct PictureSpan { let start: Double; let end: Double; let shown: [Double]; let fileIntervalMs: Double? }
    var pictureSegments: [PictureSpan] = []
    func segment(at item: Double) -> PictureSpan? {
        // A piece's first picture can sit a fraction of a millisecond before its timeline start (timescale rounding).
        pictureSegments.first { item >= $0.start - 0.002 && item < $0.end - 0.002 }
    }
    /// Timeline times of the source pictures a piece shows in [from, to).
    func pictureTimes(from: Double, to: Double) -> [Double] {
        var out: [Double] = []
        for seg in pictureSegments where seg.end > from && seg.start < to {
            let lo = max(from, seg.start), hi = min(to, seg.end)
            for t in seg.shown {
                if t >= hi - 0.0005 { break }
                if t >= lo - 0.0005 { out.append(t) }
            }
        }
        return out
    }
    func picturesDue(from: Double, to: Double) -> Int { pictureTimes(from: from, to: to).count }
    /// How long the picture at `item` is meant to stay up: from its own source picture to the next one shown, or to
    /// the piece's end. The shown time can sit a fraction of a millisecond off its source time (timescale rounding).
    func pictureDuration(at item: Double) -> Double {
        guard let seg = segment(at: item), !seg.shown.isEmpty else { return 1 / fps }
        let own = seg.shown.lastIndex { $0 <= item + 0.006 } ?? 0
        let at = seg.shown[own]
        let next = own + 1 < seg.shown.count ? seg.shown[own + 1] : seg.end
        return max(0.001, min(next, seg.end) - max(at, seg.start))
    }
    /// AV3: one piece's pictures on the reel, through its clock (1x, speed, ramps or a hold), from its file's times.
    static func pictureSpan(_ seg: VideoSeg, times: [Double]) -> PictureSpan {
        var shown: [Double] = []
        if let keys = seg.timeMap, !plainClock(keys) {
            for (a, b) in zip(keys, keys.dropFirst()) where b.t - a.t > 1e-6 {
                let span = b.s - a.s
                if span <= 1e-6 { shown.append(a.t); continue }
                for p in times where p >= a.s - 0.0005 && p < b.s - 0.0005 { shown.append(a.t + (p - a.s) * (b.t - a.t) / span) }
            }
        } else {
            // AV6: on the frame grid, as the composition places it (VideoSeg.shownStart).
            for p in times {
                let t = seg.shownStart + (p - seg.shownSourceStart)
                if t >= seg.shownEnd - 0.0005 { break }
                if t >= seg.shownStart - 0.0005 { shown.append(t) }
            }
        }
        let interval = times.count > 1 ? ((times.last! - times.first!) / Double(times.count - 1) * 10000).rounded() / 10 : nil
        return PictureSpan(start: seg.shownStart, end: seg.shownEnd, shown: shown.sorted(), fileIntervalMs: interval)
    }
    /// AV3: each file's picture times, read once per run (a preview made again is a new file: AppleAssets.key).
    static var timesCache: [String: [Double]] = [:]
    func spans(for manifest: Manifest) -> [PictureSpan] {
        manifest.video.map { seg in
            let key = AppleAssets.key(seg.file)
            if Self.timesCache[key] == nil {
                let found = ApplePlayerHost.presentationTimes(AppleAssets.shared.asset(for: seg.file))
                // No sample table (never for a proxy): the edit's own frame grid stands in.
                Self.timesCache[key] = found.isEmpty ? stride(from: 0.0, to: seg.sourceEnd + 1, by: 1 / max(1, manifest.fps)).map { $0 } : found
                if Self.timesCache.count > 400 { Self.timesCache = [key: Self.timesCache[key]!] }
            }
            return Self.pictureSpan(seg, times: Self.timesCache[key]!)
        }
    }
    /// A file's picture times, read once from its sample table.
    static func presentationTimes(_ asset: AVURLAsset) -> [Double] {
        guard let track = asset.tracks(withMediaType: .video).first, let cursor = track.makeSampleCursorAtFirstSampleInDecodeOrder() else { return [] }
        var media: [Double] = []
        repeat { media.append(CMTimeGetSeconds(cursor.presentationTimeStamp)) } while cursor.stepInDecodeOrder(byCount: 1) == 1 && media.count < 200_000
        // Sample times are media times; the track's edit list maps them to the track time the composition cuts from.
        let edits = track.segments.filter { !$0.isEmpty }.map { (from: CMTimeGetSeconds($0.timeMapping.source.start), to: CMTimeGetSeconds($0.timeMapping.source.end), at: CMTimeGetSeconds($0.timeMapping.target.start)) }
        let times = media.compactMap { t -> Double? in
            guard !edits.isEmpty else { return t }
            guard let e = edits.first(where: { t >= $0.from - 0.0005 && t < $0.to - 0.0005 }) else { return nil }
            return e.at + (t - e.from)
        }
        return times.sorted()
    }
    var rect = NSRect.zero
    var sentinel = false
    var lead = 0.08

    // MARK: attach

    /// Put the picture view into the window whose content view is `view`, below the page. Returns the window number.
    func attach(_ view: NSView) -> Int {
        let content = view.window?.contentView ?? view
        if container == nil {
            let made = PictureContainer(frame: content.bounds)
            made.autoresizingMask = [.width, .height]
            made.wantsLayer = true
            made.isHidden = true
            let pic = PictureView(frame: .zero)
            made.addSubview(pic)
            container = made; picture = pic
            let env = ProcessInfo.processInfo.environment
            sentinel = env["PRECUT_QA_BACKGROUND"] == "1" && (env["PRECUT_APPLE_QA_SENTINEL"] == "1" || ProcessInfo.processInfo.arguments.contains("--precut-apple-qa-sentinel"))
            if sentinel { applySentinel() }
        }
        guard let container else { return -1 }
        if container.superview !== content {
            container.removeFromSuperview()
            container.frame = content.bounds
            // Directly above the window's vibrancy (when it has one), below every web contents view.
            if let effect = content.subviews.first(where: { $0 is NSVisualEffectView }) {
                content.addSubview(container, positioned: .above, relativeTo: effect)
            } else {
                content.addSubview(container, positioned: .below, relativeTo: nil)
            }
        }
        window = content.window
        return content.window?.windowNumber ?? -1
    }

    /// QA geometry only: a magenta backdrop, a green picture and a one point blue edge, so a capture shows any misfit.
    func applySentinel() {
        container?.layer?.backgroundColor = NSColor(srgbRed: 1, green: 0, blue: 1, alpha: 1).cgColor
        guard let layer = picture?.metalLayer else { return }
        layer.backgroundColor = NSColor(srgbRed: 0, green: 1, blue: 0, alpha: 1).cgColor
        layer.borderColor = NSColor(srgbRed: 0, green: 0, blue: 1, alpha: 1).cgColor
        layer.borderWidth = 1
    }

    func layout() -> [String: Any] {
        guard let container, let content = container.superview else { return ["attached": false] }
        let order = content.subviews.map { String(describing: type(of: $0)) }
        return ["attached": true, "order": order, "index": content.subviews.firstIndex(of: container) ?? -1,
                "hidden": container.isHidden, "rect": [rect.minX, rect.minY, rect.width, rect.height],
                "content": [content.bounds.width, content.bounds.height], "sentinel": sentinel]
    }

    var rectLink: CVDisplayLink?
    var rectTick = 0
    var pendingRects: [(rect: NSRect, due: Int)] = []

    /// Place the picture. `frames` display refreshes from now, so it lands with the page's own new layout: Chromium
    /// shows a layout change about two refreshes after the page lays it out, the native view one after it is moved.
    /// Counted on the display, never on the page's main thread, so a busy page cannot make the picture trail its hole.
    /// Each rect keeps its own due refresh, so a continuous resize is followed frame by frame, never postponed.
    func setRect(x: Double, y: Double, w: Double, h: Double, frames: Int = 0) {
        let next = NSRect(x: x, y: y, width: max(0, w), height: max(0, h))
        if frames <= 0 { pendingRects = []; applyRect(next); return }
        pendingRects.append((next, rectTick + frames))
        if rectLink != nil { return }
        var link: CVDisplayLink?
        guard CVDisplayLinkCreateWithActiveCGDisplays(&link) == kCVReturnSuccess, let link else { pendingRects = []; applyRect(next); return }
        if let screen = window?.screen, let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            CVDisplayLinkSetCurrentCGDisplay(link, CGDirectDisplayID(number.uint32Value))
        }
        CVDisplayLinkSetOutputHandler(link) { [weak self] _, _, _, _, _ in
            DispatchQueue.main.async {
                guard let self else { return }
                self.rectTick += 1
                if let due = self.pendingRects.lastIndex(where: { $0.due <= self.rectTick }) {
                    self.applyRect(self.pendingRects[due].rect)
                    self.pendingRects.removeFirst(due + 1)
                }
                if self.pendingRects.isEmpty, let link = self.rectLink { CVDisplayLinkStop(link); self.rectLink = nil }
            }
            return kCVReturnSuccess
        }
        rectLink = link
        CVDisplayLinkStart(link)
    }

    func applyRect(_ next: NSRect) {
        rect = next
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        picture?.frame = rect
        CATransaction.commit()
    }

    func setVisible(_ visible: Bool) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        container?.isHidden = !visible
        CATransaction.commit()
    }

    // MARK: load

    /// A plan made playable: its sound composition (for the buses), its picture item (framing compositor, an output
    /// the presenter reads) and its pictures' reel times.
    struct Playable {
        let manifest: Manifest; let built: BuiltComposition; let item: AVPlayerItem; let output: AVPlayerItemVideoOutput
        let spans: [PictureSpan]; let buildMs: Double
    }
    func makePlayable(path: String) throws -> Playable {
        let begun = CACurrentMediaTime()
        let manifest = try loadManifestFile(path)
        let built = try buildComposition(manifest)
        // Picture: the same composition without its sound tracks, as long as the edit.
        // Built by the same builder with no sound tracks: a copy with its sound tracks removed retimed pictures by
        // up to 7 ms off their files' own times (measured, AV1b).
        let pictureBuilt = try buildComposition(Manifest(version: manifest.version, width: manifest.width, height: manifest.height, fps: manifest.fps, durationS: manifest.durationS, video: manifest.video, audio: [], gridFps: manifest.gridFps))
        let pictureOnly = pictureBuilt.composition
        if let video = pictureOnly.tracks(withMediaType: .video).first, CMTimeGetSeconds(pictureOnly.duration) < manifest.durationS - 0.001 {
            let from = pictureOnly.duration
            video.insertEmptyTimeRange(CMTimeRange(start: from, end: seconds(manifest.durationS)))
        }
        let item = AVPlayerItem(asset: pictureOnly)
        // The builder's framing, composed for the screen with the page's colour (see PictureCompositor).
        let screen = (pictureBuilt.videoComposition?.mutableCopy() as? AVMutableVideoComposition) ?? AVMutableVideoComposition(propertiesOf: pictureOnly)
        screen.customVideoCompositorClass = PictureCompositor.self
        // AV4: the composed picture is a column of tiles (PictureLayout), as the builder sized it.
        // AV6: frames on the edit's grid (the builder's frameDuration), never one track's times (see buildComposition).
        item.videoComposition = screen
        let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
        item.add(output)
        return Playable(manifest: manifest, built: built, item: item, output: output, spans: spans(for: manifest), buildMs: (CACurrentMediaTime() - begun) * 1000)
    }
    /// A timed setRate start (one host clock for picture and sound) requires waiting to minimise stalling off.
    func configure(_ player: AVPlayer) {
        player.automaticallyWaitsToMinimizeStalling = false
        player.actionAtItemEnd = .pause
        player.isMuted = true
    }

    /// AV4: the plan asked for last, and how often a plan was built again because a file it reads was not readable yet.
    var latestPath = ""
    var buildRetries: [String: Int] = [:]
    /// A plan whose composition could not be built (a preview being made again in place, half written, as an edit asks
    /// for it): built again shortly, three times, while it is still the newest; then the standard player takes over.
    func retryBuild(_ path: String, at: Double, error: Error, swap: Bool) {
        let tries = buildRetries[path, default: 0]
        guard tries < 3, latestPath == path else { emitEvent(["type": "failed", "message": String(describing: error)]); return }
        buildRetries[path] = tries + 1
        emitEvent(["type": "planRetry", "reason": String(describing: error).prefix(200).description, "try": tries + 1])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
            guard let self, self.latestPath == path else { return }
            if swap { self.beginSwap(path: path, at: at) } else { self.load(path: path, at: at) }
        }
    }

    func load(path: String, at: Double) {
        latestPath = path
        // AV3: a new version of the edit on screen (an edit, an undo) swaps in place: the picture and sound carry on.
        if canSwap { beginSwap(path: path, at: at); return }
        cancelSwap()
        loadGeneration += 1
        let generation = loadGeneration
        teardownItem()
        let playable: Playable
        do { playable = try makePlayable(path: path) } catch { retryBuild(path, at: at, error: error, swap: false); return }
        let manifest = playable.manifest, built = playable.built
        fps = manifest.fps > 0 ? manifest.fps : 25
        // Each file's own picture times (an edit mixes frame rates): what "every picture" and "one picture" mean there.
        pictureSegments = playable.spans
        // AV4: no framing check here. AV1 read the first framed picture because AVFoundation's own compositor refused
        // framing on long edits; every picture is now framed by PictureCompositor, and the extra reader (one more set of
        // decoders beside the players) failed on its own under load, handing good edits to the standard player. A
        // plan that cannot play fails its item, which still hands over with the reason.
        _ = built
        // Sound: the composition's own audio mix on the running engine, in buses with the plan's EQ and limiter.
        let engine = sound ?? SoundEngine(stats: stats)
        sound = engine
        engine.setMuted(muted)
        engine.configure(asset: built.composition, mix: built.audioMix, kinds: built.audioKinds, eq: manifest.sound?.eq ?? [0, 0, 0], auto: manifest.sound?.auto ?? true, outputDb: manifest.sound?.outDb ?? 0, durationS: manifest.durationS)
        engine.prepare(at: at)
        appleLookEvent = { event in
            DispatchQueue.main.async {
                if event["type"] as? String == "lookFailed" { emitEvent(["type": "failed", "message": "Apple player could not draw this edit's Look. The standard player takes over."]) }
                else { emitEvent(event) }
            }
        }
        AppleLookState.shared.load(manifest: manifest)
        let item = playable.item, output = playable.output
        videoOutput = output
        let player = self.player ?? AVPlayer()
        configure(player)
        player.replaceCurrentItem(with: item)
        self.player = player
        picture?.metalLayer.drawableSize = CGSize(width: manifest.width, height: manifest.height)
        startPresenter(output: output, generation: generation)
        observe(item: item, player: player, generation: generation)
        if sentinel { DispatchQueue.main.async { emitEvent(["type": "display", "ready": true]) } }
        player.seek(to: seconds(at), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
            emitEvent(["type": "seeked", "time": at])
            // Preroll before ReadyToPlay throws. The status observer prerolls instead.
            if item.status == .readyToPlay { player.preroll(atRate: 1) { _ in } }
        }
        emitEvent(["type": "loaded", "durationS": manifest.durationS])
    }

    /// The item's status, its end and the clock reports, for the player on screen.
    func observe(item: AVPlayerItem, player: AVPlayer, generation: Int) {
        statusObservation = item.observe(\.status, options: [.new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, self.loadGeneration == generation else { return }
                if item.status == .readyToPlay {
                    emitEvent(["type": "ready", "durationS": CMTimeGetSeconds(item.duration)])
                    if let pending = self.pendingPlay { self.pendingPlay = nil; self.play(at: pending.0, rate: pending.1) }
                    else { self.player?.preroll(atRate: 1) { _ in } }
                }
                if item.status == .failed { emitEvent(["type": "failed", "message": item.error?.localizedDescription ?? "Could not play this edit natively."]) }
            }
        }
        endObserver = NotificationCenter.default.addObserver(forName: .AVPlayerItemDidPlayToEndTime, object: item, queue: .main) { [weak self] _ in
            guard let self, self.loadGeneration == generation else { return }
            self.sound?.stop()
            self.finishPlay(reason: "ended")
            emitEvent(["type": "ended"])
        }
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] time in
            emitEvent(["type": "time", "time": CMTimeGetSeconds(time), "playing": (self?.player?.rate ?? 0) != 0, "wall": Date().timeIntervalSince1970 * 1000])
        }
    }
    func unobserve() {
        if let timeObserver, let player { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObservation = nil
    }

    func teardownItem() {
        cancelSwap()
        stopPresenter()
        measuring = false
        stats.lock.lock(); stats.measuring = false; stats.pendingSeek = nil; stats.pendingLook = nil; stats.lock.unlock()
        openingTimer?.invalidate(); openingTimer = nil
        unobserve()
        pendingPlay = nil
        player?.pause()
        player?.replaceCurrentItem(with: nil)
        sound?.clear()
        videoOutput = nil
    }

    // MARK: live edits (AV3)

    /// A new version's plan readied beside the one on screen: its own player and item, its Look staged, then started
    /// on the playing clock (or seeked to the paused point) and handed to the presenter, which shows it from the first
    /// refresh its picture is ready for. The old player keeps playing until then: no black picture, no gap.
    final class PendingSwap {
        let id: Int; let path: String; let playable: Playable; let player: AVPlayer
        let askedHost: Double; let askedEpochMs: Double
        var at: Double
        var itemReady = false, lookReady = false, framingReady = false, started = false
        var lookStage = 0
        var lead = 0.06, tries = 0
        /// Paused when asked: the new player seeks to the shown point at once, while its item and Look get ready.
        var seekedEarly: Double? = nil
        var seekDone = false
        var seekDoneHost = 0.0
        /// Playing when asked: the item time the new player was seeked to at once, ahead of the clock by what readying
        /// is expected to take, so its seek overlaps the item and the Look getting ready.
        var playingEarly = false
        var statusObservation: NSKeyValueObservation?
        var timing: [String: Any] = [:]
        init(id: Int, path: String, playable: Playable, player: AVPlayer, at: Double) {
            self.id = id; self.path = path; self.playable = playable; self.player = player; self.at = at
            askedHost = CACurrentMediaTime(); askedEpochMs = Date().timeIntervalSince1970 * 1000
        }
    }
    var swapping: PendingSwap?
    /// AV4: how often each plan's swap was readied again after its item failed.
    var swapRetries: [String: Int] = [:]
    var swapCounter = 0
    /// How long readying the last playing swap took (seek and preroll), seconds.
    var swapPrepS = 0.08
    /// How far ahead of the clock a playing swap's first seek goes: what the whole of readying one took lately.
    var swapEstimateS = 0.12
    var sparePlayer: AVPlayer?
    /// A swap dropped for a transport command, begun again once the command has run (play: once playing).
    var swapAgain: String?
    /// The picture is up (a plan loaded and its first picture shown): a new plan swaps in rather than reloads.
    var canSwap: Bool {
        guard player?.currentItem != nil, videoOutput != nil, !sentinel else { return false }
        presenterLock.lock(); defer { presenterLock.unlock() }
        return presenter.shown && presenter.output != nil
    }

    func beginSwap(path: String, at: Double) {
        cancelSwap()
        swapCounter += 1
        let id = swapCounter
        let playable: Playable
        do { playable = try makePlayable(path: path) } catch { retryBuild(path, at: at, error: error, swap: true); return }
        let next = sparePlayer ?? AVPlayer()
        sparePlayer = nil
        configure(next)
        next.replaceCurrentItem(with: playable.item)
        let s = PendingSwap(id: id, path: path, playable: playable, player: next, at: at)
        s.timing["buildMs"] = round1(playable.buildMs)
        swapping = s
        // Seek the new player now (a seek may be asked before the item is ready; only a preroll may not), so its picture
        // decodes while the Look and the item get ready. Paused: to the shown point. Playing: ahead of the clock by
        // what readying a swap is expected to take.
        let rate = Double(player?.rate ?? 0)
        let now = player.map { CMTimeGetSeconds($0.currentTime()) } ?? at
        let early = rate != 0 ? now + swapEstimateS * rate : at
        let target = max(0, min(early, playable.manifest.durationS - 0.5 / max(1, playable.manifest.fps)))
        s.seekedEarly = target; s.playingEarly = rate != 0
        next.seek(to: seconds(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.swapping === s else { return }
                guard finished else { s.seekedEarly = nil; self.advanceSwap(s); return }
                s.seekDone = true; s.seekDoneHost = CACurrentMediaTime(); s.timing["seekMs"] = round1((s.seekDoneHost - s.askedHost) * 1000); self.advanceSwap(s)
            }
        }
        emitEvent(["type": "swapAsked", "id": id, "askedEpochMs": s.askedEpochMs, "at": round3(at), "buildMs": round1(playable.buildMs)])
        // AV4: no framing check (see load): PictureCompositor frames every picture.
        s.framingReady = true
        s.lookStage = AppleLookState.shared.stage(manifest: playable.manifest) { [weak self] ok, problem in
            DispatchQueue.main.async {
                guard let self, self.swapping === s else { return }
                if !ok { self.failSwap(s, "Apple player could not draw this edit's Look. The standard player takes over."); _ = problem; return }
                s.lookReady = true; s.timing["lookMs"] = round1((CACurrentMediaTime() - s.askedHost) * 1000); self.advanceSwap(s)
            }
        }
        s.statusObservation = playable.item.observe(\.status, options: [.initial, .new]) { [weak self] item, _ in
            DispatchQueue.main.async {
                guard let self, self.swapping === s else { return }
                if item.status == .readyToPlay && !s.itemReady { s.itemReady = true; s.timing["itemMs"] = round1((CACurrentMediaTime() - s.askedHost) * 1000); self.advanceSwap(s) }
                if item.status == .failed {
                    // AV4: an item that fails as it readies (seen under heavy load: AVFoundation -11800, -12780, while the
                    // shown player and the new one decode together) is readied once more before the standard player takes over.
                    if (self.swapRetries[s.path] ?? 0) < 2 {
                        self.swapRetries[s.path, default: 0] += 1
                        let path = s.path, at = s.at
                        self.cancelSwap()
                        emitEvent(["type": "swapRetry", "reason": String(describing: item.error ?? CompositionError.message("failed"))])
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.beginSwap(path: path, at: at) }
                        return
                    }
                    self.failSwap(s, item.error?.localizedDescription ?? "Could not play this edit natively.")
                }
            }
        }
    }

    func advanceSwap(_ s: PendingSwap) {
        // The framing check (AV1's guard) runs beside it and only stops a swap that has not shown yet.
        guard swapping === s, s.itemReady, s.lookReady, !s.started, let current = player else { return }
        s.started = true
        if current.rate != 0 { playingSwap(s, rate: Double(current.rate)) } else { pausedSwap(s) }
    }

    /// Paused: the new plan at the asked point (the play point, or the edit point the page moved to).
    func pausedSwap(_ s: PendingSwap) {
        let manifest = s.playable.manifest
        let target = max(0, min(s.at, manifest.durationS - 0.5 / max(1, manifest.fps)))
        s.timing["mode"] = "paused"
        let shown = { [weak self] in
            guard let self, self.swapping === s else { return }
            // Nothing plays: the buses read the new plan from the shown point.
            let built = s.playable.built
            self.sound?.configure(asset: built.composition, mix: built.audioMix, kinds: built.audioKinds, eq: manifest.sound?.eq ?? [0, 0, 0], auto: manifest.sound?.auto ?? true, outputDb: manifest.sound?.outDb ?? 0, durationS: manifest.durationS)
            self.sound?.prepare(at: target)
            self.stagePresenter(s, host: nil)
        }
        // Already seeked there while it got ready.
        if !s.playingEarly, s.seekDone, let early = s.seekedEarly, abs(early - target) < 1e-6 { shown(); return }
        if !s.playingEarly, !s.seekDone, let early = s.seekedEarly, abs(early - target) < 1e-6 { s.started = false; return }  // its seek lands next
        s.player.seek(to: seconds(target), toleranceBefore: .zero, toleranceAfter: .zero) { finished in
            DispatchQueue.main.async { [weak self] in
                guard let self, self.swapping === s else { return }
                guard finished else { s.started = false; self.advanceSwap(s); return }
                shown()
            }
        }
    }

    /// Playing: the new plan starts on the playing clock a little ahead (the lead), picture and sound together: the new
    /// player with a timed start, the buses spliced in place at the same item time. A lead too short for its preroll
    /// (or for the sound already rendered) is tried again, longer.
    func playingSwap(_ s: PendingSwap, rate: Double) {
        guard let current = player else { return }
        let manifest = s.playable.manifest
        let now = CMTimeGetSeconds(current.currentTime())
        // AV4: the picture's lead counts the output's own latency, not the sound path's (time pitch and limiter, about
        // 90 ms, see SoundEngine.latency): the buses splice at their first sample they may still change (just after the
        // picture, as AV3 allowed under load), so an edit's picture is not held back by the sound's longer path.
        let soonest = (sound.map { $0.latency - $0.pathLatency } ?? 0.02) + 0.03
        // The lead covers readying the new player (as the last swap took) and the sound already rendered ahead.
        if s.tries == 0 { s.lead = max(s.lead, swapPrepS * 1.25 + soonest) }
        let target = now + max(s.lead, soonest + 0.02) * rate
        s.timing["mode"] = "playing"; s.timing["soundLatencyMs"] = round1((sound?.latency ?? 0) * 1000)
        if target >= manifest.durationS - 0.05 {
            // The edit ends before the play point: play stops there, as at the end of the edit.
            current.pause(); sound?.stop(); finishPlay(reason: "ended")
            s.at = min(now, manifest.durationS)
            emitEvent(["type": "ended"])
            pausedSwap(s); return
        }
        // The first try uses the seek asked as the swap began, once it has landed (it lands, then this runs again).
        if s.tries == 0, s.playingEarly, let early = s.seekedEarly {
            if !s.seekDone { s.started = false; return }
            prerollSwap(s, rate: rate, target: early, begun: s.askedHost, seeked: s.seekDoneHost, soonest: soonest, attempt: ["early": true, "leadMs": round1(swapEstimateS * 1000), "soonestMs": round1(soonest * 1000)])
            return
        }
        let begun = CACurrentMediaTime()
        let attempt: [String: Any] = ["leadMs": round1(max(s.lead, soonest + 0.02) * 1000), "soonestMs": round1(soonest * 1000)]
        s.player.seek(to: seconds(target), toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            DispatchQueue.main.async {
                guard let self, self.swapping === s else { return }
                guard finished else { self.retrySwap(s, rate: rate); return }
                self.prerollSwap(s, rate: rate, target: target, begun: begun, seeked: CACurrentMediaTime(), soonest: soonest, attempt: attempt)
            }
        }
    }
    /// The new player seeked to `target`: preroll it, then start it on the clock with the sound spliced at the same time.
    func prerollSwap(_ s: PendingSwap, rate: Double, target: Double, begun: Double, seeked: Double, soonest: Double, attempt: [String: Any]) {
        let manifest = s.playable.manifest
        var attempt = attempt
        let note = { (more: [String: Any]) in for (k, v) in more { attempt[k] = v }; var list = s.timing["attempts"] as? [[String: Any]] ?? []; list.append(attempt); s.timing["attempts"] = list }
        // No preroll: the new player is already seeked to `target` (its picture decoded), and a timed start asked ahead
        // of its time starts decoding the pictures after it at once. Preroll measured 70 to 150 ms here, all of it lead.
        let started = { [weak self] (_: Bool) in
            DispatchQueue.main.async {
                guard let self, self.swapping === s, let current = self.player else { return }
                // Paused while it was readied: show it paused instead.
                guard current.rate != 0 else { s.at = CMTimeGetSeconds(current.currentTime()); self.pausedSwap(s); return }
                let aNow = CMTimeGetSeconds(current.currentTime()), hostNow = CACurrentMediaTime()
                let ahead = (target - aNow) / rate
                let prep: [String: Any] = ["seekMs": round1((seeked - begun) * 1000), "prerollMs": round1((hostNow - seeked) * 1000), "aheadMs": round1(ahead * 1000)]
                // What readying took, for the next swap's lead (with room for the sound).
                self.swapPrepS = max(0.02, min(0.6, (hostNow - seeked) + (seeked - begun)))
                self.swapEstimateS = max(0.07, min(0.8, 0.5 * self.swapEstimateS + 0.5 * ((hostNow - s.askedHost) + soonest + 0.04)))
                guard ahead > soonest + 0.03 else { note(prep); self.retrySwap(s, rate: rate); return }
                // The sound changes at `target` (a bus whose render head passed it, just after its head); the picture
                // changes at `target` on the playing clock.
                let changed = self.sound?.splice(asset: s.playable.built.composition, mix: s.playable.built.audioMix, kinds: s.playable.built.audioKinds,
                                                 eq: manifest.sound?.eq ?? [0, 0, 0], auto: manifest.sound?.auto ?? true, outputDb: manifest.sound?.outDb ?? 0, durationS: manifest.durationS, at: target) ?? target
                note(prep.merging(self.sound?.spliceCheck ?? [:]) { a, _ in a })
                s.timing["soundLateMs"] = round1(max(0, changed - target) * 1000)
                let start = target
                let host = CACurrentMediaTime() + (start - CMTimeGetSeconds(current.currentTime())) / rate
                s.player.setRate(Float(rate), time: seconds(start), atHostTime: CMClockMakeHostTimeFromSystemUnits(AVAudioTime.hostTime(forSeconds: host)))
                s.timing["leadMs"] = round1(ahead * 1000); s.timing["tries"] = s.tries; s.timing["targetS"] = round3(start)
                self.stagePresenter(s, host: host)
            }
        }
        started(true)
    }
    func retrySwap(_ s: PendingSwap, rate: Double) {
        s.tries += 1
        s.lead = min(0.8, max(s.lead * 1.5, swapPrepS * 1.25 + (sound.map { $0.latency - $0.pathLatency } ?? 0.02) + 0.03))
        if s.tries > 5 { failSwap(s, "Apple player could not line up the new version. The standard player takes over."); return }
        playingSwap(s, rate: rate)
    }

    func stagePresenter(_ s: PendingSwap, host: Double?) {
        stats.lock.lock(); stats.swapAsked[s.id] = (s.askedHost, s.askedEpochMs, host); stats.lock.unlock()
        presenterLock.lock(); presenter.next = (s.playable.output, host, s.id, s.lookStage, CACurrentMediaTime()); presenterLock.unlock()
        if host == nil { presentNow() }
    }

    /// The presenter has shown the new plan's first picture: it becomes the player on screen, the old one is let go.
    func finishSwap(_ id: Int) {
        guard let s = swapping, s.id == id else { return }
        swapping = nil
        s.statusObservation = nil
        let old = player
        unobserve()
        old?.pause()
        old?.replaceCurrentItem(with: nil)
        sparePlayer = old
        player = s.player
        videoOutput = s.playable.output
        pictureSegments = s.playable.spans
        let manifest = s.playable.manifest
        fps = manifest.fps > 0 ? manifest.fps : 25
        loadGeneration += 1
        let generation = loadGeneration
        presenterLock.lock(); presenter.generation = generation; presenterLock.unlock()
        observe(item: s.playable.item, player: s.player, generation: generation)
        if picture?.metalLayer.drawableSize != CGSize(width: manifest.width, height: manifest.height) { picture?.metalLayer.drawableSize = CGSize(width: manifest.width, height: manifest.height) }
        var event: [String: Any] = ["type": "swapped", "id": id, "durationS": manifest.durationS, "playing": (s.player.rate) != 0, "ms": round1((CACurrentMediaTime() - s.askedHost) * 1000)]
        for (key, value) in s.timing { event[key] = value }
        emitEvent(event)
        // A viewer from before AV3 waits for this to show the Apple picture again after a new plan.
        emitEvent(["type": "display", "ready": true, "swap": id])
    }

    func failSwap(_ s: PendingSwap, _ message: String) {
        cancelSwap()
        emitEvent(["type": "failed", "message": message])
    }

    func cancelSwap() {
        guard let s = swapping else { return }
        swapping = nil
        s.statusObservation = nil
        s.player.pause()
        s.player.replaceCurrentItem(with: nil)
        if s.player !== player { sparePlayer = s.player }
        presenterLock.lock(); if presenter.next?.id == s.id { presenter.next = nil }; presenterLock.unlock()
        AppleLookState.shared.dropStaged(s.lookStage)
    }

    /// A transport command while a swap is under way: if the presenter already shows the new plan, the swap finishes
    /// first; otherwise it is dropped and begun again after the command, from the new point.
    func settleSwap() {
        guard let s = swapping else { return }
        presenterLock.lock(); let shown = presenter.output === s.playable.output; presenterLock.unlock()
        if shown { finishSwap(s.id); return }
        cancelSwap()
        swapAgain = s.path
    }
    func resumeSwap(at: Double) {
        guard let path = swapAgain else { return }
        swapAgain = nil
        beginSwap(path: path, at: at)
    }

    // MARK: transport

    func play(at: Double, rate: Double) {
        settleSwap()
        guard let player, let item = player.currentItem else { emitEvent(["type": "failed", "message": "Nothing loaded."]); return }
        // Preroll before ReadyToPlay throws. A play asked for early runs when ready lands.
        if item.status != .readyToPlay { pendingPlay = (at, rate); player.seek(to: seconds(at), toleranceBefore: .zero, toleranceAfter: .zero) { _ in }; return }
        let generation = loadGeneration
        let asked = CACurrentMediaTime()
        // AV4: a pause or seek pressed while this play waits for its preroll wins: the play never starts after it
        // (fast play and pause left sound playing behind a paused picture).
        playToken += 1
        let token = playToken
        let startPlayback = { [weak self] in
            guard let self, let player = self.player, self.loadGeneration == generation, self.playToken == token else { return }
            let start = CMTimeGetSeconds(player.currentTime())
            // Picture and sound start on one host clock time. The sound's opening is read first (usually
            // already read at pause or seek), so neither waits on the other once the clock runs. AV4: the lead covers
            // the sound's whole path (about 0.1 s, see SoundEngine.latency) and the opening's read, as 0.08 s did when
            // the path was counted as 0.015 s.
            let hostNow = CACurrentMediaTime()
            self.lead = max(0.08, (self.sound?.latency ?? 0) + 0.065)
            let when = hostNow + self.lead
            self.stats.lock.lock()
            self.stats.generation += 1
            self.stats.whenHost = when
            self.stats.startItem = start
            self.stats.rate = rate; self.stats.fps = self.fps; self.stats.changes = []; self.stats.sound = nil; self.stats.soundScheduledLeadMs = nil
            self.stats.measuring = true
            self.stats.lock.unlock()
            let readMs = self.sound?.start(at: start, rate: rate, whenHost: when) ?? 0
            player.setRate(Float(rate), time: CMTime.invalid, atHostTime: CMClockMakeHostTimeFromSystemUnits(AVAudioTime.hostTime(forSeconds: when)))
            self.measuring = true
            self.openingTimer?.invalidate()
            self.openingTimer = Timer.scheduledTimer(withTimeInterval: max(0, when - CACurrentMediaTime()) + 1.15, repeats: false) { [weak self] _ in self?.reportOpening() }
            emitEvent(["type": "playing", "time": start, "askedMs": round1((hostNow - asked) * 1000), "soundReadMs": round1(readMs)])
            // A new version that was being readied when play was pressed: readied again, now on the playing clock.
            self.resumeSwap(at: start)
        }
        if abs(CMTimeGetSeconds(player.currentTime()) - at) > 0.5 / fps {
            player.seek(to: seconds(at), toleranceBefore: .zero, toleranceAfter: .zero) { _ in
                player.preroll(atRate: Float(rate)) { _ in DispatchQueue.main.async { startPlayback() } }
            }
        } else { player.preroll(atRate: Float(rate)) { _ in DispatchQueue.main.async { startPlayback() } } }
    }

    func pause() {
        playToken += 1
        pendingPlay = nil
        settleSwap()
        player?.pause()
        sound?.stop()
        finishPlay(reason: "paused")
        let time = player.map { CMTimeGetSeconds($0.currentTime()) } ?? 0
        sound?.prepare(at: time)
        emitEvent(["type": "paused", "time": time])
        resumeSwap(at: time)
    }

    func seek(_ at: Double) {
        playToken += 1
        pendingPlay = nil
        settleSwap()
        defer { resumeSwap(at: at) }
        guard let player else { return }
        let asked = CACurrentMediaTime()
        let target = seconds(at)
        if player.rate != 0 { player.pause(); sound?.stop(); finishPlay(reason: "seek") }
        sound?.prepare(at: at)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] finished in
            let seeked = CACurrentMediaTime()
            // The presenter reports when the new time's picture is on screen (with its Look): a seek's real cost.
            if finished, let self { self.stats.lock.lock(); self.stats.pendingSeek = (at, asked, seeked); self.stats.lock.unlock() }
            DispatchQueue.main.async {
                emitEvent(["type": "seeked", "time": at, "finished": finished])
                guard finished, let self else { return }
                let generation = self.loadGeneration
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { [weak self] in
                    guard let self, self.loadGeneration == generation else { return }
                    self.stats.lock.lock()
                    let late = self.stats.pendingSeek.map { abs($0.target - at) < 1e-9 && abs($0.askedHost - asked) < 1e-9 } ?? false
                    if late { self.stats.pendingSeek = nil }
                    self.stats.lock.unlock()
                    if late { emitEvent(["type": "seekShown", "time": at, "ms": round1((CACurrentMediaTime() - asked) * 1000), "seekMs": round1((seeked - asked) * 1000), "late": true]) }
                }
            }
        }
    }

    // MARK: Look (AV2)

    /// New Look numbers: the lattices bake off the main thread and swap in, and the presenter draws the picture showing
    /// with them on its next display refresh, playing or paused. The player item, its pictures and the sound are untouched.
    func setLook(_ json: String) {
        let askedHost = CACurrentMediaTime(), epochMs = Date().timeIntervalSince1970 * 1000
        let generation = loadGeneration
        // When the page and main sent it (epoch ms), for the step's timing.
        func stamp(_ key: String) -> Double? {
            guard let range = json.range(of: "\"\(key)\":") else { return nil }
            let rest = json[range.upperBound...].prefix { "0123456789.".contains($0) }
            return Double(rest)
        }
        let sentAt = stamp("sentAt"), mainAt = stamp("mainAt")
        _ = AppleLookState.shared.update(json: json) { [weak self] lookGeneration, totalMs in
            guard let self, self.loadGeneration == generation else { return }
            var event: [String: Any] = ["type": "look", "generation": lookGeneration, "ms": round1(totalMs), "bakeMs": round1(AppleLookState.shared.lastBakeMs), "playing": (self.player?.rate ?? 0) != 0, "arrivedAt": epochMs]
            if let sentAt { event["sentAt"] = sentAt }
            if let mainAt { event["mainAt"] = mainAt }
            emitEvent(event)
        } swapped: { [weak self] lookGeneration in
            // On the Look's own queue, the moment the new numbers are in: the presenter's next refresh shows them.
            guard let self else { return }
            self.stats.lock.lock(); self.stats.pendingLook = (lookGeneration, askedHost, epochMs); self.stats.lock.unlock()
            self.presentNow()
        }
    }

    func dispose() {
        teardownItem()
        setVisible(false)
        sound?.shutdown(); sound = nil
    }

    // MARK: presentation cadence

    // MARK: presenter (AV2)

    /// The presenter's state, read and written on the display link's thread.
    final class Presenter {
        var output: AVPlayerItemVideoOutput?
        var generation = 0
        var lastPicture: CVPixelBuffer?
        var lastItem = 0.0
        var drawnLook = -1
        var shown = false
        var ticks = 0
        var drawnKey = ""
        var lastTarget = 0.0
        var pendingSince = 0.0
        var pendingReported = false
        var asked = Set<Double>()
        /// AV3: a new plan's output to show from `host` (nil: as soon as its picture is ready), with its staged Look.
        var next: (output: AVPlayerItemVideoOutput, host: Double?, id: Int, stage: Int, since: Double)?
        /// The swap whose first picture is the next fresh one drawn.
        var swapPicture: Int?
        /// AV4: refreshes left to draw a paused picture again (see present).
        var redraws = 0
        let renderer = AppleLookRenderer()
        let queue = AppleGPU.shared.device?.makeCommandQueue()
    }
    let presenter = Presenter()
    let presenterLock = NSLock()

    /// Each display refresh: the picture due then (from the player's own clock) gets the Look and is presented at that
    /// refresh's time. A refresh with no new picture and no new Look draws nothing.
    func startPresenter(output: AVPlayerItemVideoOutput, generation: Int) {
        stopPresenter()
        presenterLock.lock()
        presenter.output = output; presenter.generation = generation; presenter.lastPicture = nil; presenter.drawnLook = -1; presenter.shown = false
        presenter.pendingSince = 0; presenter.pendingReported = false; presenter.asked = []; presenter.next = nil; presenter.swapPicture = nil
        presenterLock.unlock()
        var link: CVDisplayLink?
        guard CVDisplayLinkCreateWithActiveCGDisplays(&link) == kCVReturnSuccess, let link else { return }
        if let screen = window?.screen, let number = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber {
            CVDisplayLinkSetCurrentCGDisplay(link, CGDirectDisplayID(number.uint32Value))
        }
        CVDisplayLinkSetOutputHandler(link) { [weak self] _, _, outputTime, _, _ in
            let stamp = outputTime.pointee
            if stamp.videoTimeScale > 0 && stamp.videoRefreshPeriod > 0 { self?.refreshPeriod.value = Double(stamp.videoRefreshPeriod) / Double(stamp.videoTimeScale) }
            // One refresh beyond the link's own output time: drawing the Look takes a few milliseconds, and a picture
            // finished after its refresh would show a refresh late (sound would lead it). Look changes do not wait.
            self?.present(at: hostSeconds(stamp.hostTime) + (self?.refreshPeriod.value ?? 1.0 / 60))
            return kCVReturnSuccess
        }
        CVDisplayLinkStart(link)
        displayLink = link
    }

    func stopPresenter() {
        if let displayLink { CVDisplayLinkStop(displayLink) }
        displayLink = nil
        presenterLock.lock(); presenter.output = nil; presenter.lastPicture = nil; presenterLock.unlock()
    }

    /// A Look change: draw the picture showing again with it now, without waiting for the next display callback.
    func presentNow() { present(at: CACurrentMediaTime() + refreshInterval() / 2, now: true) }

    private func present(at target: Double, now: Bool = false) {
        presenterLock.lock(); defer { presenterLock.unlock() }
        presenter.ticks += 1
        // AV3: a new version takes over at its refresh, once its picture for that refresh is ready (the old player
        // keeps showing until then), and its Look becomes the one drawn in the same step.
        if let next = presenter.next, !sentinel, next.host.map({ target >= $0 - refreshInterval() / 2 }) ?? true {
            let late = CACurrentMediaTime() - (next.host ?? next.since) > 1.0
            if next.output.hasNewPixelBuffer(forItemTime: next.output.itemTime(forHostTime: target)) || late {
                if !AppleLookState.shared.commitStaged(next.stage) {
                    // Its Look is not there to draw with: tried again each refresh, then (never a stuck swap) the
                    // Chrome viewer takes over with its reason.
                    if CACurrentMediaTime() - (next.host ?? next.since) > 3 {
                        presenter.next = nil
                        let id = next.id
                        DispatchQueue.main.async { [weak self] in if let self, let s = self.swapping, s.id == id { self.failSwap(s, "Apple player could not show the new version. The standard player takes over.") } }
                    }
                } else {
                    presenter.next = nil
                    presenter.output = next.output
                    presenter.drawnLook = -1; presenter.drawnKey = ""; presenter.asked = []; presenter.pendingSince = 0; presenter.pendingReported = false
                    presenter.swapPicture = next.id
                    let id = next.id
                    DispatchQueue.main.async { [weak self] in self?.finishSwap(id) }
                }
            }
        }
        guard let output = presenter.output, let layer = picture?.metalLayer, !sentinel else { return }
        let itemTime = output.itemTime(forHostTime: target)
        var fresh: CVPixelBuffer? = nil
        var shownTime = CMTime.invalid
        if output.hasNewPixelBuffer(forItemTime: itemTime) { fresh = output.copyPixelBuffer(forItemTime: itemTime, itemTimeForDisplay: &shownTime) }
        let look = AppleLookState.shared.currentGeneration
        guard let picture = fresh ?? presenter.lastPicture else { return }
        if fresh == nil && look == presenter.drawnLook && presenter.redraws == 0 { return }
        let item = fresh != nil ? CMTimeGetSeconds(shownTime) : presenter.lastItem
        presenter.lastPicture = picture; presenter.lastItem = item
        // A Look still loading never draws: the page keeps the Chrome picture up until the first one is presented.
        // AV4: every picture of the moment (a layout's, a dissolve's), by the span the compositor framed it for.
        let span = (CVBufferCopyAttachment(picture, appleSpanKey, nil) as? NSNumber)?.intValue
        let snap = AppleLookState.shared.frame(at: item, span: span, wait: 0)
        guard snap.ready else {
            // A piece whose tables are still on their way holds the picture before it, and asks main to read it next.
            // Held over 4 s (they never came), the Chrome viewer takes over rather than freeze or show the piece
            // without its Look.
            if !snap.pending.isEmpty {
                for start in snap.pending where !presenter.asked.contains(start) {
                    presenter.asked.insert(start)
                    DispatchQueue.main.async { emitEvent(["type": "needLook", "start": start]) }
                }
                if presenter.pendingSince == 0 { presenter.pendingSince = CACurrentMediaTime() }
                else if CACurrentMediaTime() - presenter.pendingSince > 4 && !presenter.pendingReported {
                    presenter.pendingReported = true
                    let loadGeneration = presenter.generation
                    DispatchQueue.main.async { [weak self] in if self?.loadGeneration == loadGeneration { emitEvent(["type": "failed", "message": "Apple player could not draw this edit's Look. The standard player takes over."]) } }
                }
            }
            return
        }
        presenter.pendingSince = 0
        // A Look change that leaves the piece on screen as it was (another piece's tables or numbers) draws nothing.
        let key = appleFrameKey(snap)
        if fresh == nil && key == presenter.drawnKey && presenter.redraws == 0 { presenter.drawnLook = snap.generation; return }
        let gpu = AppleGPU.shared
        guard let queue = presenter.queue, let buffer = queue.makeCommandBuffer(), let source = gpu.wrap(picture) else {
            stats.lock.lock(); stats.failedDraws += 1; stats.lock.unlock(); return
        }
        let asked = CACurrentMediaTime()
        let next = layer.nextDrawable()
        let waited = (CACurrentMediaTime() - asked) * 1000
        stats.lock.lock(); stats.drawableWaitMs = max(stats.drawableWaitMs, waited); stats.lock.unlock()
        guard let drawable = next, presenter.renderer.encodeFrame(buffer, framed: source.1, out: drawable.texture, time: item, frame: snap) else {
            stats.lock.lock(); stats.failedDraws += 1; stats.lock.unlock()
            return
        }
        // Recorded when the GPU has drawn it, at the refresh it is due on (its target, or the first refresh after the GPU
        // finished if that was later). The system's own presentation reports stop for a window that is not on screen
        // (an invisible QA window under the desktop), so they only count presented and dropped drawables.
        // Never before, nor in the same refresh as, a picture already queued: that one would win and put the old Look
        // back on screen (seen paused: a Look change undone by the picture queued as play stopped). The same holds for a
        // refresh's own picture after a Look change took its refresh (measured: without it, the window's capture missed
        // a Look change made while playing in 2 of 5 runs; with it, 0 of 13).
        let refresh = refreshInterval(), isFresh = fresh != nil, generation = snap.generation
        let swapId = isFresh ? presenter.swapPicture : nil
        if swapId != nil { presenter.swapPicture = nil }
        let at = target > presenter.lastTarget + refresh / 2 ? target : presenter.lastTarget + refresh
        // AV5 QA: the drawable as drawn, copied out in this same command buffer before it is presented.
        var readback: (seq: Int, buffer: MTLBuffer, width: Int, height: Int, row: Int)?
        if watchPictures && qa.armed, let device = gpu.device {
            let texture = drawable.texture, row = texture.width * 4
            if let out = qa.buffer(device, length: row * texture.height), let blit = buffer.makeBlitCommandEncoder() {
                blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0), sourceSize: MTLSize(width: texture.width, height: texture.height, depth: 1),
                          to: out, destinationOffset: 0, destinationBytesPerRow: row, destinationBytesPerImage: row * texture.height)
                blit.endEncoding()
                readback = (qa.nextSeq(), out, texture.width, texture.height, row)
            }
        }
        buffer.addCompletedHandler { [weak self] done in
            _ = source
            gpu.flush()
            let finished = done.gpuEndTime > 0 ? done.gpuEndTime : CACurrentMediaTime()
            let due = finished <= at ? at : at + ceil((finished - at) / max(0.001, refresh)) * refresh
            if let self {
                self.stats.lock.lock()
                self.stats.gpuMs = max(self.stats.gpuMs, (done.gpuEndTime - done.gpuStartTime) * 1000)
                if !now && finished > target { self.stats.latePictures += 1 }
                self.stats.lock.unlock()
                if let r = readback { self.qa.done(seq: r.seq, buffer: r.buffer, width: r.width, height: r.height, row: r.row, item: item, due: due, look: generation, fresh: isFresh) }
            }
            self?.recordPresented(picture: picture, item: item, host: due, fresh: isFresh, look: generation, swap: swapId)
        }
        let readSeq = readback?.seq
        drawable.addPresentedHandler { [weak self] shown in
            guard let self else { return }
            self.stats.lock.lock()
            if shown.presentedTime > 0 { self.stats.presentedDrawables += 1 } else { self.stats.droppedDrawables += 1 }
            self.stats.lock.unlock()
            if let readSeq { self.qa.wasPresented(seq: readSeq, host: shown.presentedTime) }
        }
        presenter.lastTarget = max(presenter.lastTarget, at)
        buffer.present(drawable, atTime: at)
        buffer.commit()
        // A Look change drawn at once is drawn once more on the next refresh, in case the window server passes over a lone
        // present into a layer that has been idle (paused). Measured in the invisible QA window: with one draw, a paused
        // change was still not in the window's capture half a second later in 1 of 3 runs; with two, 1 of 8.
        if !now { presenter.drawnLook = snap.generation; presenter.drawnKey = key }
        // AV4: a new picture shown paused (a seek, a frame step, an edit's swap) is drawn again on the next two refreshes:
        // the window server can pass over a lone present into a layer that has been idle (AV2 saw it for a Look change;
        // AV4's parity captures under heavy load showed the picture before a seek in 4 of 6). Playing, the next picture follows anyway.
        if fresh != nil { stats.lock.lock(); let playing = stats.measuring; stats.lock.unlock(); presenter.redraws = playing ? 0 : 2 }
        else if presenter.redraws > 0 { presenter.redraws -= 1 }
        let firstShown = !presenter.shown
        presenter.shown = true
        let loadGeneration = presenter.generation
        if firstShown { DispatchQueue.main.async { [weak self] in if self?.loadGeneration == loadGeneration { emitEvent(["type": "display", "ready": true]) } } }
    }

    /// What the display showed: picture changes of a measured play, the first picture of a pending Look and of a seek.
    private func recordPresented(picture: CVPixelBuffer, item: Double, host: Double, fresh: Bool, look: Int, swap: Int? = nil) {
        let luma = watchPictures && fresh ? sampleLuma(picture) : -1
        var events: [[String: Any]] = []
        stats.lock.lock()
        // AV3: the new version's first picture on screen: how long after the plan reached the player.
        if let swap, let asked = stats.swapAsked.removeValue(forKey: swap) {
            var shown: [String: Any] = ["type": "swapShown", "id": swap, "ms": round1((host - asked.host) * 1000), "epochMs": asked.epochMs + (host - asked.host) * 1000,
                                        "pictureS": round3(item), "luma": round1(luma), "playing": stats.measuring]
            if let start = asked.startHost { shown["afterStartMs"] = round1((host - start) * 1000) }
            stats.swapShown.append(shown)
            if stats.swapShown.count > 200 { stats.swapShown.removeFirst(100) }
            events.append(shown)
        }
        if fresh && stats.measuring && (stats.changes.last.map({ abs($0.item - item) > 1e-6 }) ?? true) { stats.changes.append((host, item)) }
        if luma >= 0 { stats.sampled += 1; if luma < 2 { stats.blackPictures += 1; stats.blackAt.append(round3(item)); if stats.blackAt.count > 40 { stats.blackAt.removeFirst(20) } } }
        if let pending = stats.pendingLook, look >= pending.generation {
            stats.pendingLook = nil
            let seen: [String: Any] = ["type": "lookShown", "generation": look, "playing": stats.measuring, "ms": round1((host - pending.askedHost) * 1000),
                                       "epochMs": pending.epochMs + (host - pending.askedHost) * 1000, "pictureS": round3(item), "luma": round1(luma)]
            stats.lookShown.append(seen)
            if stats.lookShown.count > 400 { stats.lookShown.removeFirst(200) }
            events.append(seen)
        }
        if fresh, let seek = stats.pendingSeek, abs(item - seek.target) < 0.5 / max(1, fps) + 0.002 || item > seek.target {
            stats.pendingSeek = nil
            events.append(["type": "seekShown", "time": seek.target, "shownS": round3(item), "ms": round1((host - seek.askedHost) * 1000), "seekMs": round1((seek.seekedHost - seek.askedHost) * 1000)])
        }
        stats.lock.unlock()
        if !events.isEmpty { DispatchQueue.main.async { for event in events { emitEvent(event) } } }
    }

    /// The display's refresh period, as the display link's own timestamps give it. Never asked of the display link
    /// itself: that takes the link's lock, which its callback holds while it waits on the presenter (a deadlock).
    let refreshPeriod = Box(1.0 / 60)
    func refreshInterval() -> Double { refreshPeriod.value }

    func reportOpening() {
        stats.lock.lock()
        let when = stats.whenHost, start = stats.startItem, rate = stats.rate, fps = stats.fps
        let changes = stats.changes, sound = stats.sound, scheduledLead = stats.soundScheduledLeadMs
        stats.lock.unlock()
        guard when > 0 else { return }
        let frame = 1 / max(1, fps)
        // The pictures of the first second of the edit from the play point, shown within that second (one picture of
        // slack for the display refresh they land on), against the source pictures due there at each piece's own rate.
        let shown = changes.filter { $0.item >= start - 0.0005 && $0.item < start + rate - 0.0005 && $0.host < when + 1 + frame }
        let wall = changes.filter { $0.host >= when - 0.0005 && $0.host < when + 1.0 }
        // The first picture of the play: the one for the play point, on screen from the start time.
        let first = changes.first { $0.item >= start - frame / 2 }
        let firstHost = first.map { max($0.host, when) }
        var event: [String: Any] = ["type": "opening", "frames": shown.count, "expected": picturesDue(from: start, to: start + rate), "wallFrames": wall.count,
                                    "fps": fps, "seconds": 1.0, "startS": round3(start), "lead": lead]
        if let first, let firstHost {
            event["firstPictureS"] = round3(first.item)
            event["firstPictureMs"] = round1((firstHost - when) * 1000)
        }
        if let sound {
            event["soundStartS"] = round3(sound.item)
            event["soundHeardMs"] = round1((sound.host - when) * 1000)
            // When the play point's sound is heard (the first audible sample, less any silence in the edit before it).
            let pointHeard = sound.host - (sound.item - start) / max(0.01, rate)
            if let firstHost { event["soundOffsetMs"] = round1((pointHeard - firstHost) * 1000) }
            event["silentHeadMs"] = round1((sound.item - start) * 1000)
        }
        if let scheduledLead { event["soundScheduledLeadMs"] = scheduledLead }
        lastOpening = event
        emitEvent(event)
    }

    func finishPlay(reason: String) {
        guard measuring else { return }
        measuring = false
        stats.lock.lock(); stats.measuring = false; stats.lock.unlock()
        if let openingTimer, openingTimer.isValid { openingTimer.invalidate(); reportOpening() }
        stats.lock.lock()
        let changes = stats.changes, when = stats.whenHost, fps = stats.fps, rate = stats.rate
        stats.lock.unlock()
        let frameMs = 1000 / max(1, fps * rate), vsyncMs = refreshInterval() * 1000
        var holds: [Double] = []
        var ratios: [Double] = []
        var skipped = 0
        // The picture showing when play starts (the paused one) counts from the start time, not from when it was drawn.
        // A hold is measured against how long that picture is meant to stay up (40 ms in a 25p clip, 16.7 ms in 60p,
        // its own gap in a variable rate one), at the play rate. A source picture never shown counts as skipped.
        for (a, b) in zip(changes, changes.dropFirst()) {
            let hold = (max(b.host, when) - max(a.host, when)) * 1000
            // A picture meant to show for less than one display refresh (the last of a piece) still shows for one.
            let interval = max(pictureDuration(at: a.item) * 1000 / max(0.01, rate), vsyncMs)
            holds.append(hold); ratios.append(hold / interval)
        }
        // Pictures never shown: those due over the play less those shown. Counted in total, not pair by pair, because
        // AVFoundation can report a picture's time a few milliseconds off its file's own time in a long composition.
        if let first = changes.first, let last = changes.last {
            skipped = max(0, picturesDue(from: first.item - 0.006, to: last.item + 0.006) - changes.count)
        }
        var histogram: [String: Int] = ["upTo1": 0, "upTo2": 0, "over2": 0]
        for (hold, ratio) in zip(holds, ratios) {
            let slack = (vsyncMs + 0.5) / (hold / max(0.001, ratio))
            if ratio <= 1 + slack { histogram["upTo1", default: 0] += 1 }
            else if ratio <= 2 + slack { histogram["upTo2", default: 0] += 1 }
            else { histogram["over2", default: 0] += 1 }
        }
        let maxHold = holds.max() ?? 0
        let maxRatio = ratios.max() ?? 0
        let intervals = Array(Set(pictureSegments.compactMap { $0.fileIntervalMs })).sorted()
        let event: [String: Any] = ["type": "holds", "reason": reason, "frames": changes.count,
                                    "seconds": round3((changes.last?.host ?? when) - max(when, changes.first?.host ?? when)),
                                    "fromS": round3(changes.first?.item ?? 0), "toS": round3(changes.last?.item ?? 0),
                                    "maxHoldMs": round1(maxHold), "maxHoldFrames": round3(maxRatio), "frameMs": round1(frameMs), "pictureIntervalsMs": intervals,
                                    "vsyncMs": round3(vsyncMs), "histogram": histogram, "skippedPictures": skipped,
                                    "holdsMs": holds.map(round1)]
        var shown = event
        if let worst = ratios.indices.max(by: { ratios[$0] < ratios[$1] }) {
            shown["longest"] = ["holdMs": round1(holds[worst]), "frames": round3(ratios[worst]), "pictureS": round3(changes[worst].item), "nextS": round3(changes[worst + 1].item), "meantMs": round1(pictureDuration(at: changes[worst].item) * 1000)]
        }
        lastHolds = event
        emitEvent(shown)
    }

    // MARK: capture

    /// One image of precut's whole window as the window server composites it: the picture and the page together.
    func capture(path: String, nominal: Bool) -> [String: Any] {
        guard let window else { return ["ok": false, "error": "not attached"] }
        typealias CreateImage = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
        // CGWindowListCreateImage is deprecated for screen capture; for a process's own window it needs no permission.
        guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { return ["ok": false, "error": "no capture"] }
        let create = unsafeBitCast(symbol, to: CreateImage.self)
        let started = CACurrentMediaTime()
        let options: UInt32 = (1 << 0) | (nominal ? (1 << 4) : (1 << 3)) // ignore framing, nominal or best resolution
        guard let image = create(.null, 1 << 3, UInt32(window.windowNumber), options)?.takeRetainedValue() else { return ["ok": false, "error": "capture failed"] }
        let grabbed = CACurrentMediaTime()
        let url = URL(fileURLWithPath: path), part = URL(fileURLWithPath: path + ".part.png")
        DispatchQueue.global(qos: .utility).async {
            // Written aside and moved into place, so the file never exists half written.
            guard let destination = CGImageDestinationCreateWithURL(part as CFURL, "public.png" as CFString, 1, nil) else { return }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { return }
            try? FileManager.default.removeItem(at: url)
            try? FileManager.default.moveItem(at: part, to: url)
            DispatchQueue.main.async { emitEvent(["type": "captured", "path": path]) }
        }
        return ["ok": true, "width": image.width, "height": image.height, "grabMs": round1((grabbed - started) * 1000), "atHost": grabbed]
    }

    /// QA (PRECUT_QA_BACKGROUND=1): the picture the presenter last showed, full size, drawn again with the Look it
    /// showed (the same renderer), as a PNG. The window's own capture is scaled by the screen; this is the picture.
    func qaFrame(path: String) -> [String: Any] {
        guard ProcessInfo.processInfo.environment["PRECUT_QA_BACKGROUND"] == "1" else { return ["ok": false, "error": "QA only"] }
        presenterLock.lock(); let picture = presenter.lastPicture, item = presenter.lastItem; presenterLock.unlock()
        guard let picture else { return ["ok": false, "error": "no picture yet"] }
        let span = (CVBufferCopyAttachment(picture, appleSpanKey, nil) as? NSNumber)?.intValue
        let snap = AppleLookState.shared.frame(at: item, span: span, wait: 1)
        guard snap.ready, let graded = AppleLookRenderer().render(framed: picture, time: item, frame: snap) else { return ["ok": false, "error": "cannot draw"] }
        let ci = CIImage(cvPixelBuffer: graded)
        let plain = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        guard let image = plain.createCGImage(ci, from: ci.extent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, "public.png" as CFString, 1, nil) else { return ["ok": false, "error": "cannot write"] }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return ["ok": false, "error": "cannot write"] }
        return ["ok": true, "itemS": round3(item), "generation": snap.generation, "width": image.width, "height": image.height]
    }

    /// AV5 QA: arm (or disarm) the readback. `full` keeps the newest presented drawable whole; a rect (fractions of the
    /// frame, w > 0) records every presented drawable's mean brightness there. Arming forgets earlier reads.
    func qaReadback(full: Bool, rect: (Double, Double, Double, Double)?) -> [String: Any] {
        guard watchPictures else { return ["ok": false, "error": "QA only"] }
        qa.lock.lock()
        qa.full = full
        qa.probe = rect.flatMap { $0.2 > 0 && $0.3 > 0 ? (x: $0.0, y: $0.1, w: $0.2, h: $0.3) : nil }
        qa.latest = nil; qa.probes = []; qa.presented = [:]
        let seq = qa.seq
        qa.lock.unlock()
        // Paused, nothing new is presented: draw the picture showing once more, so a read exists.
        if full { presenterLock.lock(); presenter.redraws = max(presenter.redraws, 1); presenterLock.unlock(); presentNow() }
        return ["ok": true, "seq": seq]
    }

    /// AV5 QA: the newest presented drawable as an sRGB PNG at `path` (no path: its numbers only). The numbers say which
    /// picture it was: its sequence number, item time, the refresh it was due on and when the system presented it.
    func qaGrab(path: String) -> [String: Any] {
        guard watchPictures else { return ["ok": false, "error": "QA only"] }
        qa.lock.lock(); let frame = qa.latest; let seq = qa.seq; let shown = frame.flatMap { qa.presented[$0.seq] }; qa.lock.unlock()
        guard let frame else { return ["ok": false, "error": "nothing read yet", "seq": seq] }
        var out: [String: Any] = ["ok": true, "seq": frame.seq, "newestSeq": seq, "itemS": frame.item, "dueHost": frame.due, "look": frame.look, "fresh": frame.fresh,
                                  "width": frame.width, "height": frame.height, "presentedHost": shown ?? -1, "readHost": frame.encodedHost, "nowHost": CACurrentMediaTime()]
        if path.isEmpty { return out }
        guard let provider = CGDataProvider(data: frame.data as CFData),
              let image = CGImage(width: frame.width, height: frame.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: frame.row, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGBitmapInfo(rawValue: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.noneSkipFirst.rawValue), provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent),
              let destination = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path + ".part.png") as CFURL, "public.png" as CFString, 1, nil) else { return ["ok": false, "error": "cannot write"] }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else { return ["ok": false, "error": "cannot write"] }
        try? FileManager.default.removeItem(atPath: path)
        do { try FileManager.default.moveItem(atPath: path + ".part.png", toPath: path) } catch { return ["ok": false, "error": "cannot write"] }
        out["path"] = path
        return out
    }

    /// AV5 QA: the probe's records since `after` (sequence number), and the last measured play's picture clock.
    func qaProbes(after: Int) -> [String: Any] {
        guard watchPictures else { return ["ok": false, "error": "QA only"] }
        qa.lock.lock(); let rows = qa.probes.filter { Int($0[0]) > after }; qa.lock.unlock()
        stats.lock.lock(); let changes = stats.changes; let when = stats.whenHost, start = stats.startItem, rate = stats.rate; stats.lock.unlock()
        let clock = changes.suffix(20000).map { [$0.host, $0.item] }
        // The source pictures due over that play (the set `holds` counts skipped pictures against), so QA can tell a
        // picture never presented from one meant for less than a display refresh.
        let due = changes.isEmpty ? [] : pictureTimes(from: changes.first!.item - 0.006, to: changes.last!.item + 0.006)
        return ["ok": true, "probes": rows, "clock": clock, "due": due, "vsyncMs": refreshInterval() * 1000, "play": ["whenHost": when, "startItem": start, "rate": rate], "nowHost": CACurrentMediaTime()]
    }

    /// QA only: put the (opacity 0) QA window under the desktop picture, where an opaque window can be captured unseen.
    func qaBelowDesktop() -> Int {
        guard ProcessInfo.processInfo.environment["PRECUT_QA_BACKGROUND"] == "1", let window else { return 0 }
        window.level = NSWindow.Level(rawValue: Int(CGWindowLevelForKey(.desktopWindow)) - 1)
        return window.level.rawValue
    }

    func state() -> [String: Any] {
        var out = layout()
        out["loaded"] = player?.currentItem != nil
        out["playing"] = (player?.rate ?? 0) != 0
        out["time"] = player.map { CMTimeGetSeconds($0.currentTime()) } ?? 0
        out["muted"] = muted
        out["soundRunning"] = sound?.running ?? false
        out["soundEq"] = sound?.eqGains ?? [0, 0, 0]
        out["soundAuto"] = sound?.autoLevel ?? true
        out["effectsDuck"] = round3(sound?.lastDuck ?? 1)
        if let sound, ProcessInfo.processInfo.arguments.contains("--precut-apple-sound-tap") {
            sound.tapLock.lock(); out["soundTap"] = sound.tapWindows; sound.tapLock.unlock()
            out["soundBuses"] = sound.queue.sync { [sound.voice, sound.music, sound.effects].map { ["timed": $0.startedTimed, "startOffsetMs": $0.startOffsetMs.map { ($0 * 100).rounded() / 100 } ?? NSNull()] as [String: Any] } }
        }
        out["look"] = AppleLookState.shared.summary()
        out["composer"] = ["composed": PictureCompositor.composed, "starved": PictureCompositor.starved, "lastFailure": PictureCompositor.lastFailure ?? NSNull(), "presenterTicks": presenter.ticks, "lastPictureS": round3(presenter.lastItem)]
        stats.lock.lock()
        out["pictures"] = ["sampled": stats.sampled, "black": stats.blackPictures, "failedDraws": stats.failedDraws, "dropped": stats.droppedDrawables, "presented": stats.presentedDrawables, "drawableWaitMs": round1(stats.drawableWaitMs), "gpuMs": round1(stats.gpuMs), "late": stats.latePictures, "blackAt": stats.blackAt]
        out["lookShown"] = Array(stats.lookShown.suffix(60))
        out["swapShown"] = Array(stats.swapShown.suffix(60))
        stats.lock.unlock()
        if let lastOpening { out["opening"] = lastOpening }
        if let lastHolds { out["holds"] = lastHolds }
        return out
    }
}

// MARK: C entry points for pipeline/apple-addon.c (all on the main thread)

/// JSON can carry no NaN or infinity (a time read with nothing loaded is NaN), and Foundation throws an Objective-C
/// exception on one, which would take the whole app down: such numbers become null.
func jsonSafe(_ value: Any) -> Any {
    if let number = value as? Double, !number.isFinite { return NSNull() }
    if let dict = value as? [String: Any] { return dict.mapValues(jsonSafe) }
    if let list = value as? [Any] { return list.map(jsonSafe) }
    return value
}
private func jsonString(_ value: [String: Any]) -> UnsafeMutablePointer<CChar>? {
    let safe = jsonSafe(value)
    guard JSONSerialization.isValidJSONObject(safe), let data = try? JSONSerialization.data(withJSONObject: safe), let text = String(data: data, encoding: .utf8) else { return strdup("{}") }
    return strdup(text)
}
@_cdecl("apv_attach") public func apv_attach(_ handle: UnsafeMutableRawPointer?) -> Int32 {
    guard let handle else { return -1 }
    let view = Unmanaged<NSView>.fromOpaque(handle).takeUnretainedValue()
    return Int32(ApplePlayerHost.shared.attach(view))
}
@_cdecl("apv_load") public func apv_load(_ path: UnsafePointer<CChar>?, _ at: Double, _ muted: Int32) {
    ApplePlayerHost.shared.muted = muted != 0
    ApplePlayerHost.shared.load(path: path.map { String(cString: $0) } ?? "", at: at)
}
@_cdecl("apv_play") public func apv_play(_ at: Double, _ rate: Double) { ApplePlayerHost.shared.play(at: at, rate: rate) }
@_cdecl("apv_pause") public func apv_pause() { ApplePlayerHost.shared.pause() }
@_cdecl("apv_seek") public func apv_seek(_ at: Double) { ApplePlayerHost.shared.seek(at) }
@_cdecl("apv_set_rect") public func apv_set_rect(_ x: Double, _ y: Double, _ w: Double, _ h: Double, _ frames: Int32) { ApplePlayerHost.shared.setRect(x: x, y: y, w: w, h: h, frames: Int(frames)) }
@_cdecl("apv_set_visible") public func apv_set_visible(_ visible: Int32) { ApplePlayerHost.shared.setVisible(visible != 0) }
@_cdecl("apv_set_muted") public func apv_set_muted(_ muted: Int32) { ApplePlayerHost.shared.muted = muted != 0 }
/// AV2: swap only the Look's numbers. No seek, no item change, no sound restart.
@_cdecl("apv_set_look") public func apv_set_look(_ json: UnsafePointer<CChar>?) {
    guard let json else { return }
    ApplePlayerHost.shared.setLook(String(cString: json))
}
@_cdecl("apv_warm") public func apv_warm(_ json: UnsafePointer<CChar>?) {
    guard let json, let data = String(cString: json).data(using: .utf8), let shader = try? JSONDecoder().decode(ShaderPlan.self, from: data) else { return }
    AppleLookState.shared.warm(shader)
}
@_cdecl("apv_dispose") public func apv_dispose() { ApplePlayerHost.shared.dispose() }
@_cdecl("apv_capture") public func apv_capture(_ path: UnsafePointer<CChar>?, _ nominal: Int32) -> UnsafeMutablePointer<CChar>? {
    jsonString(ApplePlayerHost.shared.capture(path: path.map { String(cString: $0) } ?? "", nominal: nominal != 0))
}
@_cdecl("apv_qa_below_desktop") public func apv_qa_below_desktop() -> Int32 { Int32(truncatingIfNeeded: ApplePlayerHost.shared.qaBelowDesktop()) }
@_cdecl("apv_state") public func apv_state() -> UnsafeMutablePointer<CChar>? { jsonString(ApplePlayerHost.shared.state()) }
@_cdecl("apv_qa_readback") public func apv_qa_readback(_ full: Int32, _ x: Double, _ y: Double, _ w: Double, _ h: Double) -> UnsafeMutablePointer<CChar>? {
    jsonString(ApplePlayerHost.shared.qaReadback(full: full != 0, rect: (x, y, w, h)))
}
@_cdecl("apv_qa_grab") public func apv_qa_grab(_ path: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    jsonString(ApplePlayerHost.shared.qaGrab(path: path.map { String(cString: $0) } ?? ""))
}
@_cdecl("apv_qa_probes") public func apv_qa_probes(_ after: Double) -> UnsafeMutablePointer<CChar>? {
    jsonString(ApplePlayerHost.shared.qaProbes(after: Int(after)))
}
@_cdecl("apv_qa_frame") public func apv_qa_frame(_ path: UnsafePointer<CChar>?) -> UnsafeMutablePointer<CChar>? {
    jsonString(ApplePlayerHost.shared.qaFrame(path: path.map { String(cString: $0) } ?? ""))
}
