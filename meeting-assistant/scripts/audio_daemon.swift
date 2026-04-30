// audio_daemon.swift — ScreenCaptureKit 音频捕获守护进程
// 无需 BlackHole，macOS 原生录制系统音频 + 麦克风。
//
// 编译:
//   swiftc -o audio_daemon audio_daemon.swift \
//     -framework Cocoa -framework ScreenCaptureKit \
//     -framework AVFoundation -framework CoreMedia -framework CoreAudio
//
// 运行:
//   首次运行需授权 Screen Recording 权限
//   作为 LaunchAgent (LSUIElement) 常驻

import Cocoa
import ScreenCaptureKit
import AVFoundation

// ─── 配置常量 ──────────────────────────────────────

let HOME = FileManager.default.homeDirectoryForCurrentUser
let CONFIG_DIR = HOME.appendingPathComponent(".config/meeting-assistant")
let SOCKET_PATH = CONFIG_DIR.appendingPathComponent("audio_daemon.sock")
let STATE_PATH = CONFIG_DIR.appendingPathComponent(".state.json")
let PID_PATH = CONFIG_DIR.appendingPathComponent(".audio_daemon.pid")
let RECORDING_DIR = HOME.appendingPathComponent("Downloads/meeting-recordings")

let SAMPLE_RATE = 48000.0
var CHANNELS: UInt32 = 1
let LOG_PATH = CONFIG_DIR.appendingPathComponent("audio_daemon.log")
var BITS_PER_SAMPLE: UInt16 = 16
let SILENCE_THRESHOLD: Float = 0.01
let FADE_SAMPLES = Int(0.5 * SAMPLE_RATE)  // 500ms 淡化
let DEFAULT_SILENCE_SEC: TimeInterval = 300  // 5min

// ─── 日志 ───────────────────────────────────────────

var logFile: FileHandle?
func log(_ msg: String) {
    let df = DateFormatter()
    df.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let ts = df.string(from: Date())
    let line = "[\(ts)] \(msg)"
    print(line)
    fflush(stdout)
    if let fh = logFile {
        fh.write((line + "\n").data(using: .utf8)!)
    }
}

// ─── WAV 写入器 ─────────────────────────────────────

class WavWriter {
    let url: URL
    let fh: FileHandle
    var totalSamples: UInt32 = 0

    init?(url: URL) {
        self.url = url
        FileManager.default.createFile(atPath: url.path, contents: Data(count: 44))
        guard let f = FileHandle(forWritingAtPath: url.path) else { return nil }
        fh = f
    }

    func append(_ samples: [Int16]) {
        totalSamples += UInt32(samples.count)
        samples.withUnsafeBytes { fh.write(Data($0)) }
    }

    func finalize() {
        // Read the actual file size to compute data size
        let fileEnd = fh.seekToEndOfFile()
        let dataSize = fileEnd - 44
        
        fh.seek(toFileOffset: 0)
        var riffSize = UInt32(fileEnd - 8)
        var audioFormat: UInt16 = 1  // PCM
        var numChannels: UInt16 = 2  // ScreenCaptureKit stereo
        var sampleRate: UInt32 = 48000
        var byteRate: UInt32 = 48000 * 2 * 2  // rate * channels * bytesPerSample
        var blockAlign: UInt16 = 4           // channels * bytesPerSample
        var bitsPerSample: UInt16 = 16
        var subChunk1Size: UInt32 = 16
        var dataSize32 = UInt32(dataSize)

        var header = Data()
        header.append("RIFF".data(using: .ascii)!)
        Swift.withUnsafeBytes(of: &riffSize) { header.append(Data($0)) }
        header.append("WAVE".data(using: .ascii)!)
        header.append("fmt ".data(using: .ascii)!)
        Swift.withUnsafeBytes(of: &subChunk1Size) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &audioFormat) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &numChannels) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &sampleRate) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &byteRate) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &blockAlign) { header.append(Data($0)) }
        Swift.withUnsafeBytes(of: &bitsPerSample) { header.append(Data($0)) }
        header.append("data".data(using: .ascii)!)
        Swift.withUnsafeBytes(of: &dataSize32) { header.append(Data($0)) }

        fh.write(header)
        try? fh.close()
    }
}

// ─── 音量归一化 ───────────────────────────────────

func normalizeToDBFS(_ samples: [Int16], targetDB: Float = -20) -> [Int16] {
    let floats = samples.map { Float($0) / Float(Int16.max) }
    let rms = sqrt(floats.map { $0 * $0 }.reduce(0, +) / Float(floats.count))
    guard rms > 0.0001 else { return samples }
    let gain = pow(10.0, targetDB / 20.0) / rms
    let clamped = min(max(gain, 0.1), 10.0)
    return floats.map { Int16(max(-1.0, min(1.0, $0 * clamped)) * Float(Int16.max)) }
}

// ─── 半双工混音 ───────────────────────────────────

func halfDuplexMix(sysA: [Int16], micA: [Int16]) -> [Int16] {
    let n = min(sysA.count, micA.count)
    var out = [Int16](repeating: 0, count: n)

    let sysSq = sysA.prefix(n).map { Float($0) * Float($0) / Float(Int(Int16.max) * Int(Int16.max)) }
        let sysRMS = sqrt(sysSq.reduce(0, +) / Float(n))
    let micSq = micA.prefix(n).map { Float($0) * Float($0) / Float(Int(Int16.max) * Int(Int16.max)) }
        let micRMS = sqrt(micSq.reduce(0, +) / Float(n))

    if sysRMS > SILENCE_THRESHOLD {
        out = Array(sysA.prefix(n))
    } else if micRMS > SILENCE_THRESHOLD {
        out = Array(micA.prefix(n))
    }
    // 都不满阈值则为静音（保持 out 全零）
    return out
}

// ─── 状态管理 ─────────────────────────────────────

func writeState(recording: Bool, title: String = "", path: String = "") {
    let df = ISO8601DateFormatter()
    let dict: [String: Any] = [
        "recording": recording,
        "title": title,
        "file_path": path,
        "updated_at": df.string(from: Date()),
    ]
    if let data = try? JSONSerialization.data(withJSONObject: dict, options: .prettyPrinted) {
        try? data.write(to: STATE_PATH)
    }
}

// ─── 音频数据管理器 ───────────────────────────────

class AudioRecorder {
    var writer: WavWriter?
    var isRecording = false
    var startTime: Date?
    var lastAudioTime: Date?
    var silenceTask: DispatchWorkItem?
    var silenceSeconds: TimeInterval = DEFAULT_SILENCE_SEC
    var onStopRequest: (() -> Void)?

    // 系统音频和麦克风数据的环形缓冲区（用于同步）
    var sysBuffer: [Int16] = []
    var micBuffer: [Int16] = []
    let mixQueue = DispatchQueue(label: "mix")
    let writeQueue = DispatchQueue(label: "write")

    func start(title: String) -> String? {
        let df = DateFormatter()
        df.dateFormat = "yyyyMMdd_HHmmss"
        let dateStr = df.string(from: Date())
        let safeTitle = title.components(separatedBy: CharacterSet.alphanumerics.inverted).joined()
        let filename = "\(safeTitle)_\(dateStr).wav"
        let url = RECORDING_DIR.appendingPathComponent(filename)

        try? FileManager.default.createDirectory(at: RECORDING_DIR, withIntermediateDirectories: true)
        guard let w = WavWriter(url: url) else { return nil }

        writer = w
        isRecording = true
        startTime = Date()
        lastAudioTime = Date()
        sysBuffer = []
        micBuffer = []

        writeState(recording: true, title: title, path: url.path)
        log("🎙 Recording: \(filename)")

        // 静默检测
        startSilenceMonitor()

        return url.path
    }

    @discardableResult
    func stop() -> (path: String?, duration: Int) {
        isRecording = false
        silenceTask?.cancel()
        let dur = startTime.map { Int(Date().timeIntervalSince($0)) } ?? 0
        let path = writer?.url.path

        try? FileManager.default.removeItem(at: SOCKET_PATH)
        writer?.finalize()
        writer = nil
        writeState(recording: false)

        log("⏹ Stopped: \(dur)s")
        return (path, dur)
    }

    private func startSilenceMonitor() {
        silenceTask?.cancel()
        let task = DispatchWorkItem { [weak self] in
            guard let self = self, self.isRecording else { return }
            if let last = self.lastAudioTime, Date().timeIntervalSince(last) >= self.silenceSeconds {
                log("🔇 Silence \(Int(self.silenceSeconds))s — auto stop")
                self.onStopRequest?()
            }
        }
        silenceTask = task
        DispatchQueue.main.asyncAfter(deadline: .now() + silenceSeconds, execute: task)
    }

    func onAudio(_ samples: [Int16], source: String) {
        guard isRecording, let w = writer else { return }

        var sumSq: Float = 0
            let maxF = Float(Int16.max)
            for s in samples { sumSq += Float(s) * Float(s) / (maxF * maxF) }
            let rms = sqrt(sumSq / Float(samples.count))
        if rms > SILENCE_THRESHOLD {
            lastAudioTime = Date()
        }

        w.append(normalizeToDBFS(samples))
    }
}

// ─── Socket 服务器 ────────────────────────────────

class SocketServer {
    let recorder: AudioRecorder
    var sock: Int32 = -1

    init(recorder: AudioRecorder) { self.recorder = recorder }

    func start() {
        try? FileManager.default.removeItem(at: SOCKET_PATH)

        sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else { log("Socket: create failed"); return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = SOCKET_PATH.path
        _ = path.withCString { strncpy(&addr.sun_path.0, $0, min(path.utf8.count, 103)) }

        let addrSize = MemoryLayout<sockaddr_un>.size
        let bindRes = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(addrSize))
            }
        }
        guard bindRes == 0 else { log("Socket: bind failed (\(bindRes))"); close(sock); sock = -1; return }

        Darwin.listen(sock, 5)
        chmod(SOCKET_PATH.path, 0o666)
        log("Socket ready: \(SOCKET_PATH.path)")

        DispatchQueue.global(qos: .background).async { [weak self] in
            while true {
                let client = Darwin.accept(self?.sock ?? -1, nil, nil)
                if client >= 0 {
                    self?.handle(client: client)
                    close(client)
                }
            }
        }
    }

    func stop() {
        if sock >= 0 { close(sock); sock = -1 }
    }

    private func handle(client: Int32) {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = read(client, &buf, 4096)
            if n <= 0 { break }
            data.append(buf, count: n)
        }

        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = json["action"] as? String else {
            send(client, ["error": "invalid"])
            return
        }

        var response: [String: Any]
        switch action {
        case "start":
            let title = json["title"] as? String ?? "会议"
            if let path = recorder.start(title: title) {
                response = ["status": "recording", "file": path]
            } else {
                response = ["error": "start_failed"]
            }
        case "stop":
            let (path, dur) = recorder.stop()
            response = ["status": "stopped", "file": path ?? "", "duration": dur]
        case "status":
            response = ["recording": recorder.isRecording]
            if recorder.isRecording {
                response["file"] = recorder.writer?.url.path ?? ""
            }
        case "quit":
            response = ["status": "bye"]
            send(client, response)
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { NSApp.terminate(nil) }
            return
        default:
            response = ["error": "unknown: \(action)"]
        }
        send(client, response)
    }

    private func send(_ client: Int32, _ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict) else { return }
        data.withUnsafeBytes { ptr in
            if let base = ptr.baseAddress {
                _ = write(client, base, data.count)
            }
        }
    }
}

// ─── ScreenCaptureKit 音频捕获 ───────────────────

@available(macOS 12.3, *)
@available(macOS 12.3, *)
class StreamOutputHandler: NSObject, SCStreamOutput {
    let recorder: AudioRecorder
    init(recorder: AudioRecorder) { self.recorder = recorder }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        if !recorder.isRecording { return }

        // macOS 26: audio data is in CMBlockBuffer (not AudioBufferList)
        guard let dataBuffer = sampleBuffer.dataBuffer else { return }
        var dataPtr: UnsafeMutablePointer<Int8>?
        var length: Int = 0
        let status = CMBlockBufferGetDataPointer(dataBuffer, atOffset: 0, lengthAtOffsetOut: &length, totalLengthOut: nil, dataPointerOut: &dataPtr)
        guard status == noErr, let ptr = dataPtr, length > 0 else { return }

        let sampleCount = length / MemoryLayout<Int16>.size
        let rawPtr = UnsafeMutableRawPointer(ptr)
        let samples = [Int16](UnsafeBufferPointer(start: rawPtr.assumingMemoryBound(to: Int16.self), count: sampleCount))
        guard !samples.isEmpty else { return }

        recorder.onAudio(samples, source: "sys")
    }
}

@available(macOS 12.3, *)
class AudioCapture {
    let recorder: AudioRecorder
    let streamOutput: StreamOutputHandler
    var stream: SCStream?

    init(recorder: AudioRecorder) {
        self.recorder = recorder
        self.streamOutput = StreamOutputHandler(recorder: recorder)
    }

    func startCapture() {
        Task {
            do {
                let content = try await SCShareableContent.current
                guard let display = content.displays.first else {
                    log("No display available (required for audio capture)")
                    return
                }

                let filter = SCContentFilter(display: display, excludingWindows: [])
                let config = SCStreamConfiguration()
                config.capturesAudio = true

                let scStream = SCStream(filter: filter, configuration: config, delegate: nil)
                // macOS 26: start BEFORE adding output
                try await scStream.startCapture()
                try scStream.addStreamOutput(streamOutput, type: .audio, sampleHandlerQueue: .global())
                self.stream = scStream
                log("SCAudio capture started (display: \(display.displayID))")
            } catch {
                let nsErr = error as NSError
                log("SCAudio start failed: \(nsErr.domain) code=\(nsErr.code) \(nsErr.localizedDescription)")
            }
        }
    }

    func stopCapture() {
        Task { try? await stream?.stopCapture() }
        stream = nil
    }
}
class AppDelegate: NSObject, NSApplicationDelegate {
    var recorder: AudioRecorder?
    var socketServer: SocketServer?
    var audioCapture: AudioCapture?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // 日志文件
        try? FileManager.default.createDirectory(at: CONFIG_DIR, withIntermediateDirectories: true)
        FileManager.default.createFile(atPath: LOG_PATH.path, contents: nil)
        logFile = try? FileHandle(forWritingTo: LOG_PATH)

        // PID
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: PID_PATH, atomically: true, encoding: .utf8)

        log("🎧 Audio Daemon started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        let rec = AudioRecorder()
        recorder = rec

        if #available(macOS 12.3, *) {
            let ac = AudioCapture(recorder: rec)
            audioCapture = ac
            // Delay capture start to let the app fully initialize
            DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                ac.startCapture()
            }
        } else {
            log("ScreenCaptureKit requires macOS 12.3+")
        }

        // 静默自动停止的回调
        rec.onStopRequest = { [weak self] in
            self?.handleSilenceStop()
        }

        let ss = SocketServer(recorder: rec)
        socketServer = ss
        ss.start()

        log("Ready — listening on \(SOCKET_PATH.path)")
    }

    func handleSilenceStop() {
        recorder?.stop()
        // 通知 scheduler 停止
        log("Silence stop triggered")
    }

    func applicationWillTerminate(_ notification: Notification) {
        recorder?.stop()
        socketServer?.stop()
        audioCapture?.stopCapture()
        try? FileManager.default.removeItem(at: PID_PATH)
        try? FileManager.default.removeItem(at: SOCKET_PATH)
        log("Daemon stopped")
        try? logFile?.close()
    }
}

// ─── 入口 ─────────────────────────────────────────

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // LSUIElement — no dock icon
app.run()
