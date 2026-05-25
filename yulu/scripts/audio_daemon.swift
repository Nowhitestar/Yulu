// Yulu audio_daemon: AVAudioEngine mic + ScreenCaptureKit sys, source-separated stereo WAV.
// 替代 BlackHole + SoX 的方案。
//
// 编译:
//   swiftc -o audio_daemon audio_daemon.swift \
//     -framework Cocoa -framework ScreenCaptureKit \
//     -framework AVFoundation -framework CoreMedia -framework CoreAudio

import Cocoa
import ScreenCaptureKit
import AVFoundation
import CoreMedia

let HOME = FileManager.default.homeDirectoryForCurrentUser
let CONFIG_DIR = HOME.appendingPathComponent(".config/yulu")
let SOCKET_PATH = CONFIG_DIR.appendingPathComponent("audio_daemon.sock")
let STATE_PATH = CONFIG_DIR.appendingPathComponent(".state.json")
let PID_PATH = CONFIG_DIR.appendingPathComponent(".audio_daemon.pid")
let LOG_PATH = CONFIG_DIR.appendingPathComponent("audio_daemon.log")
let QUEUE_PATH = CONFIG_DIR.appendingPathComponent("agent-queue.json")
let SILENCE_THRESHOLD: Float = 0.01
let DEFAULT_SILENCE_SEC: TimeInterval = 300
let SAMPLE_RATE: UInt32 = 48000

var SYS_READY = false
/// When true, SCStream / ScreenCaptureKit is intentionally not started
/// (voicemail / dictation use case). The WAV's R channel stays at 0.
var SYS_DISABLED = false
var SYS_ERROR = ""
var MIC_READY = false
var MIC_ERROR = ""
var SYS_FORMAT_LOGGED = false

func defaultRecordingDir() -> URL {
    // Yulu.app lives at <repo>/yulu/scripts/Yulu.app.
    // Store recordings at <repo>/meeting-recordings by default.
    let app = Bundle.main.bundleURL
    let repo = app
        .deletingLastPathComponent() // scripts
        .deletingLastPathComponent() // nested yulu
        .deletingLastPathComponent() // repo root
    return repo.appendingPathComponent("meeting-recordings")
}

func loadRecordingDir() -> URL {
    let configPath = CONFIG_DIR.appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let audio = json["audio"] as? [String: Any],
          let raw = audio["output_dir"] as? String,
          !raw.isEmpty else {
        return defaultRecordingDir()
    }
    let path = raw.hasPrefix("~/") ? HOME.appendingPathComponent(String(raw.dropFirst(2))).path : raw
    return URL(fileURLWithPath: path)
}

let RECORDING_DIR = loadRecordingDir()

var logFile: FileHandle?
func log(_ msg: String) {
    let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "[\(df.string(from: Date()))] \(msg)"
    print(line); fflush(stdout)
    logFile?.write(Data((line + "\n").utf8))
}

func notifyAgent(_ eventType: String, _ fields: [String: Any] = [:]) {
    var entry = fields
    entry["id"] = UUID().uuidString
    entry["type"] = eventType
    entry["ts"] = ISO8601DateFormatter().string(from: Date())

    try? FileManager.default.createDirectory(at: CONFIG_DIR, withIntermediateDirectories: true)

    var queue: [[String: Any]] = []
    if let data = try? Data(contentsOf: QUEUE_PATH),
       let existing = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
        queue = existing
    }
    queue.append(entry)
    if let data = try? JSONSerialization.data(withJSONObject: queue, options: [.prettyPrinted]) {
        try? data.write(to: QUEUE_PATH, options: [.atomic])
    }
}

// ─── WAV 写入器 ───────────────────────────────────────

class WavWriter {
    let url: URL
    private var handle: FileHandle?
    private var audioSize: UInt32 = 0
    private var lastHeaderPatch = Date.distantPast
    private let lock = NSLock()

    init?(url: URL) {
        self.url = url
        // 82 bytes = RIFF(12) + fmt chunk(24) + LIST-INFO-ICMT chunk(38) + data header(8)
        FileManager.default.createFile(atPath: url.path, contents: Data(repeating: 0, count: 82))
        guard let h = try? FileHandle(forUpdating: url) else { return nil }
        self.handle = h
        patchHeader(sync: true)
    }

    func append(_ data: Data) {
        lock.lock(); defer { lock.unlock() }
        guard let h = handle, !data.isEmpty else { return }
        do {
            try h.seekToEnd()
            try h.write(contentsOf: data)
            audioSize &+= UInt32(data.count)
            // Crash-resilience: keep the WAV header close to current size so a
            // force-kill still leaves a mostly playable file, not a 0-byte ghost.
            if Date().timeIntervalSince(lastHeaderPatch) >= 5 {
                patchHeaderLocked(sync: true)
            }
        } catch {
            log("WAV append failed: \(error)")
        }
    }

    func finalize() {
        lock.lock(); defer { lock.unlock() }
        patchHeaderLocked(sync: true)
        try? handle?.close()
        handle = nil
    }

    private func patchHeader(sync: Bool) {
        lock.lock(); defer { lock.unlock() }
        patchHeaderLocked(sync: sync)
    }

    private func patchHeaderLocked(sync: Bool) {
        let HDR_BYTES: UInt32 = 82
        let fileSize = audioSize + HDR_BYTES - 8  // RIFF size = total - 8

        var h = Data()
        // RIFF header
        h.append(contentsOf: [0x52,0x49,0x46,0x46] as [UInt8])   // "RIFF"
        var v32 = fileSize.littleEndian
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        h.append(contentsOf: [0x57,0x41,0x56,0x45] as [UInt8])   // "WAVE"

        // fmt chunk
        h.append(contentsOf: [0x66,0x6D,0x74,0x20] as [UInt8])   // "fmt "
        v32 = UInt32(16).littleEndian
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        var v16 = UInt16(1).littleEndian                          // PCM
        withUnsafeBytes(of: &v16) { h.append(Data($0)) }
        v16 = UInt16(2).littleEndian                              // channels=2
        withUnsafeBytes(of: &v16) { h.append(Data($0)) }
        v32 = UInt32(48000).littleEndian                          // sample rate
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        v32 = UInt32(48000 * 2 * 2).littleEndian                  // byte rate
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        v16 = UInt16(4).littleEndian                              // block align
        withUnsafeBytes(of: &v16) { h.append(Data($0)) }
        v16 = UInt16(16).littleEndian                             // bits/sample
        withUnsafeBytes(of: &v16) { h.append(Data($0)) }

        // LIST chunk with INFO/ICMT="Yulu DualTrack v1\0"
        h.append(contentsOf: [0x4C,0x49,0x53,0x54] as [UInt8])   // "LIST"
        v32 = UInt32(30).littleEndian                             // LIST body size
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        h.append(contentsOf: [0x49,0x4E,0x46,0x4F] as [UInt8])   // "INFO"
        h.append(contentsOf: [0x49,0x43,0x4D,0x54] as [UInt8])   // "ICMT"
        v32 = UInt32(18).littleEndian                             // ICMT payload size
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }
        // "Yulu DualTrack v1\0" = 18 bytes (even, no pad needed)
        h.append("Yulu DualTrack v1".data(using: .ascii)!)
        h.append(contentsOf: [0x00] as [UInt8])                   // null terminator

        // data chunk header
        h.append(contentsOf: [0x64,0x61,0x74,0x61] as [UInt8])   // "data"
        v32 = audioSize.littleEndian
        withUnsafeBytes(of: &v32) { h.append(Data($0)) }

        precondition(h.count == 82, "WAV header must be exactly 82 bytes (got \(h.count))")

        do {
            try handle?.seek(toOffset: 0)
            try handle?.write(contentsOf: h)
            try handle?.seekToEnd()
            if sync { handle?.synchronizeFile() }
            lastHeaderPatch = Date()
        } catch {
            log("WAV header patch failed: \(error)")
        }
    }
}

func normalizeToDBFS(_ samples: [Int16], targetDB: Float = -20) -> [Int16] {
    guard !samples.isEmpty else { return samples }
    var sum: Float = 0; let m = Float(Int(Int16.max) * Int(Int16.max))
    for s in samples { sum += Float(s) * Float(s) / m }
    let rms = sqrt(sum / Float(samples.count))
    guard rms > 0.0001 else { return samples }
    let gain = pow(10.0, targetDB / 20.0) / rms
    let clamped = min(max(gain, 0.1), 10.0)
    return samples.map { Int16(max(-1.0, min(1.0, Float($0) / Float(Int16.max) * clamped)) * Float(Int16.max)) }
}

// ─── 状态管理 ──────────────────────────────────────────

func writeState(recording: Bool, title: String = "", path: String = "") {
    let df = ISO8601DateFormatter()
    let d: [String: Any] = [
        "version": 2,
        "recording": recording,
        "status": recording ? "recording" : "idle",
        "title": recording ? title : "",
        "file_path": recording ? path : "",
        "audio_path": recording ? path : "",
        "backend": "daemon",
        "started_at": recording ? df.string(from: Date()) : "",
        "updated_at": df.string(from: Date()),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: d, options: .prettyPrinted) {
        try? data.write(to: STATE_PATH, options: [.atomic])
    }
}

// ─── 音频数据管理器 + 源分离立体声 (L=mic, R=sys) ───

class AudioRecorder {
    var writer: WavWriter?
    var isRecording = false
    var startTime: Date?
    var lastMicAudioTime: Date?
    var lastSysAudioTime: Date?
    var silenceTask: DispatchWorkItem?
    var silenceSeconds = DEFAULT_SILENCE_SEC
    var outputDir: URL = RECORDING_DIR
    var onStopRequest: (() -> Void)?

    // Streaming buffers
    var sysBuf: [Int16] = []
    var micBuf: [Int16] = []
    let bufLock = NSLock()

    func start(title: String) -> String? {
        let df = DateFormatter(); df.dateFormat = "yyyyMMdd_HHmmss"
        let fn = "\(title.components(separatedBy: .alphanumerics.inverted).joined())_\(df.string(from: Date())).wav"
        let url = outputDir.appendingPathComponent(fn)
        try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
        guard let w = WavWriter(url: url) else { return nil }
        writer = w; isRecording = true; startTime = Date()
        lastMicAudioTime = Date(); lastSysAudioTime = Date()
        sysBuf = []; micBuf = []
        writeState(recording: true, title: title, path: url.path)
        log("🎙 \(fn)")
        startSilenceMonitor()
        return url.path
    }

    @discardableResult
    func stop() -> (path: String?, duration: Int) {
        isRecording = false
        silenceTask?.cancel()
        let dur = startTime.map { Int(Date().timeIntervalSince($0)) } ?? 0
        // Write remaining audio
        flushBuffers()
        let p = writer?.url.path
        writer?.finalize(); writer = nil
        writeState(recording: false)
        log("⏹ \(dur)s")
        return (p, dur)
    }

    func onSysAudio(_ samples: [Int16]) {
        guard isRecording else { return }
        bufLock.lock()
        sysBuf.append(contentsOf: samples)
        bufLock.unlock()
        let rms = calcRMS(samples)
        if rms > SILENCE_THRESHOLD { lastSysAudioTime = Date() }
        mixAndWrite()
    }

    func onMicAudio(_ samples: [Float]) {
        guard isRecording else { return }
        let ints = samples.map { Int16(max(-1.0, min(1.0, $0)) * Float(Int16.max)) }
        bufLock.lock()
        micBuf.append(contentsOf: ints)
        bufLock.unlock()
        let rms = calcRMS(ints)
        if rms > SILENCE_THRESHOLD { lastMicAudioTime = Date() }
        mixAndWrite()
    }

    private func calcRMS(_ s: [Int16]) -> Float {
        guard !s.isEmpty else { return 0 }
        var sum: Float = 0; let m = Float(Int(Int16.max) * Int(Int16.max))
        for v in s { sum += Float(v) * Float(v) / m }
        return sqrt(sum / Float(s.count))
    }

    /// Produce an interleaved stereo PCM stream where L=mic mono and
    /// R=(sysL + sysR)/2 downmixed to mono. Source-separated; no ducking.
    /// Inputs:
    ///   - sysStereo: interleaved Int16 stereo (length must be even)
    ///   - micMono:   Int16 mono samples
    /// Output length is `sysStereo.count` (one stereo Int16 per frame).
    private func channelInterleave(sysStereo: [Int16], micMono: [Int16]) -> [Int16] {
        let frames = sysStereo.count / 2
        var out = [Int16](repeating: 0, count: frames * 2)
        let micFrames = micMono.count

        for i in 0..<frames {
            // L = mic mono (zero-padded if mic short)
            out[2 * i] = i < micFrames ? micMono[i] : 0
            // R = (sysL + sysR) / 2 with overflow-safe Int32 widening
            let sysL = Int32(sysStereo[2 * i])
            let sysR = Int32(sysStereo[2 * i + 1])
            out[2 * i + 1] = Int16((sysL + sysR) / 2)
        }
        return out
    }

    /// 流式 source-separated: 从 sysBuf/micBuf 取等量数据,
    /// 写出 L=mic / R=sys downmix(L+R/2) 的立体声 PCM.
    private func mixAndWrite() {
        guard let w = writer else { return }
        bufLock.lock()

        // Drive output frame count by whichever side has more buffered;
        // zero-pad the shorter side. This preserves recording continuity
        // when one source is silent (no sys = mic-only voicemail; no mic
        // = sys-only, currently rare but a future capture mode).
        let sysFrames = sysBuf.count / 2
        let micFrames = micBuf.count
        let outFrames = max(sysFrames, micFrames)
        guard outFrames >= 512 else { bufLock.unlock(); return }  // wait for ~10 ms

        // Take outFrames mono mic samples (zero-pad if short).
        let micChunk: [Int16]
        if micBuf.count >= outFrames {
            micChunk = Array(micBuf.prefix(outFrames))
            micBuf.removeFirst(outFrames)
        } else {
            micChunk = micBuf + [Int16](repeating: 0, count: outFrames - micBuf.count)
            micBuf.removeAll()
        }

        // Take outFrames stereo sys samples (zero-pad if short).
        let sysChunk: [Int16]
        if sysBuf.count >= outFrames * 2 {
            sysChunk = Array(sysBuf.prefix(outFrames * 2))
            sysBuf.removeFirst(outFrames * 2)
        } else {
            sysChunk = sysBuf + [Int16](repeating: 0, count: outFrames * 2 - sysBuf.count)
            sysBuf.removeAll()
        }
        bufLock.unlock()

        let out = channelInterleave(sysStereo: sysChunk, micMono: micChunk)
        w.append(Data(bytes: out, count: out.count * 2))

        // Re-arm the silence monitor on every audio event. Phase-3 design
        // was one-shot at +silenceSeconds; under voicemail's 3-second threshold
        // any speaker feedback during the window made the check pass once and
        // never run again. With this re-arm, silence-stop means "no audio for
        // the last N seconds" — which is what users expect.
        startSilenceMonitor()
    }

    private func flushBuffers() {
        guard let w = writer else { return }
        bufLock.lock()
        let sysFrames = sysBuf.count / 2
        let micFrames = micBuf.count
        let outFrames = max(sysFrames, micFrames)
        if outFrames == 0 { bufLock.unlock(); return }

        let micChunk: [Int16] = micBuf + [Int16](repeating: 0, count: max(0, outFrames - micFrames))
        let sysChunk: [Int16] = sysBuf + [Int16](repeating: 0, count: max(0, outFrames * 2 - sysBuf.count))
        micBuf.removeAll()
        sysBuf.removeAll()
        bufLock.unlock()

        let out = channelInterleave(sysStereo: Array(sysChunk.prefix(outFrames * 2)),
                                     micMono:   Array(micChunk.prefix(outFrames)))
        w.append(Data(bytes: out, count: out.count * 2))
    }

    private func startSilenceMonitor() {
        silenceTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            guard let self = self, self.isRecording else { return }
            let now = Date()
            let micQuiet = (self.lastMicAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= self.silenceSeconds
            let sysQuiet = (self.lastSysAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= self.silenceSeconds
            if micQuiet && sysQuiet {
                log("🔇 silence \(Int(self.silenceSeconds))s (both channels) — auto stop")
                self.onStopRequest?()
            }
        }
        silenceTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + silenceSeconds, execute: task)
    }
}

class MicCapture {
    let recorder: AudioRecorder
    var engine: AVAudioEngine?

    init(recorder: AudioRecorder) { self.recorder = recorder }

    /// Called once at daemon startup: just enough to verify TCC permission, then stop.
    /// Avoids displaying the macOS microphone-in-use indicator while the daemon is idle.
    func probePermission() {
        let engine = AVAudioEngine()
        _ = engine.inputNode  // touching this triggers the TCC prompt
        do {
            try engine.start()
            engine.stop()
            MIC_READY = true; MIC_ERROR = ""; log("🎤 Mic probe OK (idle until recording starts)")
        } catch {
            MIC_READY = false; MIC_ERROR = "\(error)"; log("Mic probe failed: \(error)")
        }
    }

    func start() {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let fmt = input.outputFormat(forBus: 0)

        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in
            guard let self = self, self.recorder.isRecording else { return }
            guard let chData = buf.floatChannelData else { return }
            let len = Int(buf.frameLength)
            let samples = Array(UnsafeBufferPointer(start: chData[0], count: len))
            self.recorder.onMicAudio(samples)
        }

        do { try engine.start(); self.engine = engine; MIC_READY = true; MIC_ERROR = ""; log("🎤 Mic capture started") }
        catch { MIC_READY = false; MIC_ERROR = "\(error)"; log("Mic start failed: \(error)") }
    }

    func stop() { engine?.stop(); engine = nil; log("🎤 Mic idle") }
}

// ─── SCStream 输出处理器 ──────────────────────────────

@available(macOS 12.3, *)
class SysAudioOutput: NSObject, SCStreamOutput {
    unowned let recorder: AudioRecorder
    init(_ r: AudioRecorder) { recorder = r }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, recorder.isRecording else { return }
        let asbd = buf.formatDescription.flatMap { CMAudioFormatDescriptionGetStreamBasicDescription($0)?.pointee }
        let flags = asbd?.mFormatFlags ?? 0
        let channels = Int(asbd?.mChannelsPerFrame ?? 2)
        let isFloat = (flags & kAudioFormatFlagIsFloat) != 0
        let isInt = (flags & kAudioFormatFlagIsSignedInteger) != 0
        let nonInterleaved = (flags & kAudioFormatFlagIsNonInterleaved) != 0
        if !SYS_FORMAT_LOGGED, let a = asbd {
            SYS_FORMAT_LOGGED = true
            log("SC audio ASBD: sr=\(a.mSampleRate) ch=\(a.mChannelsPerFrame) bits=\(a.mBitsPerChannel) bytesFrame=\(a.mBytesPerFrame) bytesPacket=\(a.mBytesPerPacket) framesPacket=\(a.mFramesPerPacket) float=\(isFloat) int=\(isInt) nonInterleaved=\(nonInterleaved) flags=0x\(String(flags, radix:16))")
        }
        guard let db = buf.dataBuffer else { return }
        var ptr: UnsafeMutablePointer<Int8>?; var len: Int = 0
        guard CMBlockBufferGetDataPointer(db, atOffset: 0, lengthAtOffsetOut: &len, totalLengthOut: nil, dataPointerOut: &ptr) == noErr,
              let p = ptr, len > 0 else { return }
        let cnt = len / MemoryLayout<Float>.size
        guard cnt > 0 else { return }

        let raw = UnsafeMutableRawPointer(p)
        let floats = [Float](UnsafeBufferPointer(start: raw.assumingMemoryBound(to: Float.self), count: cnt))
        let stereoFloats: [Float]
        if isFloat && nonInterleaved && channels >= 2 {
            // ScreenCaptureKit reports planar Float32. In CMBlockBuffer this is
            // laid out as all left samples followed by all right samples.
            let frames = cnt / channels
            var interleaved = [Float](); interleaved.reserveCapacity(frames * 2)
            for i in 0..<frames {
                interleaved.append(floats[i])
                interleaved.append(floats[frames + i])
            }
            stereoFloats = interleaved
        } else if isFloat && channels == 1 {
            var stereo = [Float](); stereo.reserveCapacity(cnt * 2)
            for v in floats { stereo.append(v); stereo.append(v) }
            stereoFloats = stereo
        } else {
            stereoFloats = floats
        }
        guard !stereoFloats.isEmpty else { return }
        let int16s = stereoFloats.map { Int16(max(-1.0, min(1.0, $0)) * Float(Int16.max)) }
        recorder.onSysAudio(int16s)
    }
}

// ─── 屏幕捕获管理器 ───────────────────────────────────

@available(macOS 12.3, *)
class AudioCapture {
    let recorder: AudioRecorder
    let output: SysAudioOutput
    var stream: SCStream?

    init(recorder: AudioRecorder) {
        self.recorder = recorder
        self.output = SysAudioOutput(recorder)
    }

    /// Called once at daemon startup: open an SCStream just long enough to verify the
    /// TCC permission, then stop it. This means the menu-bar "screen recording in
    /// progress" indicator does NOT light up while the daemon is idle — only when an
    /// actual recording is in flight.
    func probePermission() {
        Task {
            do {
                let content = try await SCShareableContent.current
                guard let d = content.displays.first else {
                    SYS_READY = false; SYS_ERROR = "no display"
                    log("Sys probe failed: no display"); return
                }
                let filter = SCContentFilter(display: d, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                let s = SCStream(filter: filter, configuration: config, delegate: nil)
                try await s.startCapture()
                try? await s.stopCapture()  // immediately tear down — we just wanted the TCC handshake
                SYS_READY = true; SYS_ERROR = ""
                log("🔊 Sys capture probe OK (idle until recording starts)")
            } catch {
                SYS_READY = false; SYS_ERROR = (error as NSError).localizedDescription
                log("Sys capture probe failed: \(SYS_ERROR)")
            }
        }
    }

    /// Start capturing system audio. Blocks until the SCStream is actually
    /// running (or fails), so that a subsequent stopCapture() call can rely
    /// on `stream` being set. Without this, start/stop racing each other
    /// produced "Sys capture started" messages AFTER "Sys capture idle" —
    /// and worse, left the macOS recording indicator on after stop.
    func startCapture() {
        if SYS_DISABLED {
            log("🔇 SYS_DISABLED — mic-only recording mode")
            SYS_READY = false
            return
        }
        guard stream == nil else { return }  // already capturing — idempotent
        let sem = DispatchSemaphore(value: 0)
        Task {
            defer { sem.signal() }
            do {
                let content = try await SCShareableContent.current
                guard let d = content.displays.first else { log("No display"); return }
                let filter = SCContentFilter(display: d, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true
                let s = SCStream(filter: filter, configuration: config, delegate: nil)
                try await s.startCapture()
                try s.addStreamOutput(output, type: .audio, sampleHandlerQueue: .global())
                self.stream = s
                SYS_READY = true; SYS_ERROR = ""
                log("🔊 Sys capture started (display \(d.displayID))")
            } catch {
                SYS_READY = false; SYS_ERROR = (error as NSError).localizedDescription
                log("Sys capture failed: \(SYS_ERROR)")
            }
        }
        _ = sem.wait(timeout: .now() + 5)  // 5s upper bound for SCStream init
    }

    /// Stop capturing. Blocks until the SCStream has actually stopped, so
    /// the macOS recording indicator clears synchronously with the user's
    /// "stop" command.
    func stopCapture() {
        let s = stream
        stream = nil
        let sem = DispatchSemaphore(value: 0)
        Task {
            defer { sem.signal() }
            try? await s?.stopCapture()
        }
        _ = sem.wait(timeout: .now() + 2)
        log("🔇 Sys capture idle")
    }
}

// ─── Socket 服务器 ────────────────────────────────────

class SocketServer {
    let recorder: AudioRecorder
    var sock: Int32 = -1
    /// Hooks the daemon uses to start/stop ScreenCaptureKit + microphone capture only
    /// while a recording is in flight, so the macOS menu-bar recording indicator
    /// reflects reality. AppDelegate wires these to AudioCapture / MicCapture.
    var onRecordingStart: (() -> Void)?
    var onRecordingStop: (() -> Void)?

    init(_ r: AudioRecorder) { recorder = r }

    func stop() {
        if sock >= 0 { close(sock); sock = -1 }
    }

    func start() {
        try? FileManager.default.removeItem(at: SOCKET_PATH)
        sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else { log("Socket: create failed"); return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = SOCKET_PATH.path.withCString { strncpy(&addr.sun_path.0, $0, min(SOCKET_PATH.path.utf8.count, 103)) }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { log("Socket: bind \(ok)"); close(sock); sock = -1; return }
        Darwin.listen(sock, 5); chmod(SOCKET_PATH.path, 0o600)
        log("Socket ready")
        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else { return }
            while self.sock >= 0 {
                let c = Darwin.accept(self.sock, nil, nil)
                if c >= 0 {
                    self.handle(c)
                    close(c)
                } else if errno == EINTR {
                    continue
                } else {
                    log("Socket: accept failed errno=\(errno)")
                    usleep(200_000)
                }
            }
        }
    }

    private func handle(_ c: Int32) {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true { let n = read(c, &buf, 4096); if n <= 0 { break }; data.append(buf, count: n) }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = json["action"] as? String else { send(c, ["error":"invalid"]); return }
        var resp: [String: Any]
        switch action {
        case "windows":
            resp = self.scanWindows()
        case "start":
            // Reset SYS_DISABLED per-request so each "start" reflects the caller's intent
            // cleanly (a sys-disabled recording followed by a normal one must NOT inherit
            // the previous flag).
            SYS_DISABLED = (json["sys_disabled"] as? Bool) ?? false
            // Per-request silence threshold: voicemail uses ~3s, meetings use the default.
            // Omitting the field MUST reset to DEFAULT_SILENCE_SEC so a previous short
            // threshold does not leak into the next recording.
            if let s = json["silence_seconds"] as? Int, s > 0 {
                recorder.silenceSeconds = Double(s)
            } else if let s = json["silence_seconds"] as? Double, s > 0 {
                recorder.silenceSeconds = s
            } else {
                recorder.silenceSeconds = DEFAULT_SILENCE_SEC
            }
            // Per-request output directory: voicemails land in ~/yulu/voicemails,
            // meetings use the default RECORDING_DIR. Omitting the field resets
            // to RECORDING_DIR so a previous voicemail does not leak into the
            // next meeting recording.
            if let dir = json["output_dir"] as? String, !dir.isEmpty {
                recorder.outputDir = URL(fileURLWithPath: dir)
            } else {
                recorder.outputDir = RECORDING_DIR
            }
            if !SYS_READY && !SYS_DISABLED {
                resp = ["error":"sys_capture_not_ready", "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR]
            } else if !MIC_READY {
                resp = ["error":"mic_capture_not_ready", "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR]
            } else if let p = recorder.start(title: json["title"] as? String ?? "meeting") {
                resp = ["status":"recording", "file":p]
                send(c, resp)
                // Starting ScreenCaptureKit + AVAudioEngine can take several seconds.
                // Do it after replying so short-lived clients (record_audio.py uses a
                // 5s socket timeout) do not close the socket first and kill us with
                // SIGPIPE. The recorder is already marked active; audio starts flowing
                // as soon as these hooks finish.
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    self?.onRecordingStart?()
                }
                return
            }
            else { resp = ["error":"start_failed"] }
        case "stop":
            let wasRecording = recorder.isRecording
            let (p, d) = recorder.stop()
            // Only tear down capture if we actually started it. A spurious "stop"
            // (e.g. client retry after a start_failed) would otherwise log a fake
            // "Sys capture idle" / "Mic idle" while neither was running.
            if wasRecording { onRecordingStop?() }
            resp = ["status":"stopped", "file": p ?? "", "duration": d]
        case "status":
            resp = ["recording": recorder.isRecording, "file": recorder.writer?.url.path ?? "", "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR]
        case "quit": resp = ["status":"bye"]; send(c, resp)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }; return
        default: resp = ["error":"unknown: \(action)"]
        }
        send(c, resp)
    }

    private func send(_ c: Int32, _ d: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: d) else { return }
        data.withUnsafeBytes { if let b = $0.baseAddress { _ = write(c, b, data.count) } }
    }

    func scanWindows() -> [String: Any] {
        let workspace = NSWorkspace.shared
        var results: [[String: String]] = []
        let apps = workspace.runningApplications
        for app in apps where app.activationPolicy == .regular {
            let appElem = AXUIElementCreateApplication(app.processIdentifier)
            var winList: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appElem, kAXWindowsAttribute as CFString, &winList) == .success,
                  let wins = winList as? [AXUIElement] else { continue }
            for w in wins {
                var title: CFTypeRef?
                AXUIElementCopyAttributeValue(w, kAXTitleAttribute as CFString, &title)
                if let t = title as? String, !t.isEmpty {
                    results.append(["app": app.localizedName ?? "", "title": t])
                }
            }
        }
        return ["windows": results]
    }
}

// ─── App Delegate ──────────────────────────────────────

class AppDelegate: NSObject, NSApplicationDelegate {
    var recorder: AudioRecorder?
    var micCapture: MicCapture?
    var audioCapture: AudioCapture?
    var socketServer: SocketServer?

    func applicationDidFinishLaunching(_ n: Notification) {
        try? FileManager.default.createDirectory(at: CONFIG_DIR, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: LOG_PATH.path, contents: nil)
        logFile = try? FileHandle(forWritingTo: LOG_PATH)
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: PID_PATH, atomically: true, encoding: .utf8)
        log("🎧 Audio Daemon (pid=\(ProcessInfo.processInfo.processIdentifier))")

        let rec = AudioRecorder(); recorder = rec
        rec.onStopRequest = { [weak self] in
            guard let self = self else { return }
            let wasRecording = self.recorder?.isRecording ?? false
            _ = self.recorder?.stop()
            if wasRecording {
                self.audioCapture?.stopCapture()
                self.micCapture?.stop()
            }
        }

        // Probe TCC permissions on launch (each probe opens its underlying capture
        // briefly, then tears it down) so SYS_READY / MIC_READY are accurate without
        // leaving the macOS menu-bar "recording" indicator on while the daemon is idle.
        if #available(macOS 12.3, *) {
            let ac = AudioCapture(recorder: rec); audioCapture = ac
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) { ac.probePermission() }
        }
        let mic = MicCapture(recorder: rec); micCapture = mic
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { mic.probePermission() }

        let ss = SocketServer(rec); socketServer = ss
        // Wire the socket "start"/"stop" actions to the actual capture lifecycle.
        // The daemon is idle (no SCStream, no mic engine) until a recording begins.
        ss.onRecordingStart = { [weak self] in
            self?.audioCapture?.startCapture()
            self?.micCapture?.start()
        }
        ss.onRecordingStop = { [weak self] in
            self?.audioCapture?.stopCapture()
            self?.micCapture?.stop()
        }
        ss.start()
        log("Ready")
    }

    func applicationWillTerminate(_ n: Notification) {
        recorder?.stop(); socketServer?.stop(); audioCapture?.stopCapture(); micCapture?.stop()
        try? FileManager.default.removeItem(at: PID_PATH)
        try? FileManager.default.removeItem(at: SOCKET_PATH)
        try? logFile?.close()
    }
}

// ─── 入口 ──────────────────────────────────────────────

let app = NSApplication.shared
Darwin.signal(SIGPIPE, SIG_IGN)
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
