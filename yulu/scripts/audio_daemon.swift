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
import CoreAudio
import AudioToolbox

let HOME = FileManager.default.homeDirectoryForCurrentUser
let SERVICE_OWNER = ProcessInfo.processInfo.environment["YULU_SERVICE_OWNER"] ?? "unmanaged"
let PRODUCT_VERSION = Bundle.main.object(forInfoDictionaryKey: "YuluReleaseVersion") as? String ?? ""
let BUNDLE_VERSION = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? ""
let CAPTURE_IPC_VERSION = 1

func realDirectoryURL(_ path: String) -> URL? {
    var buffer = [CChar](repeating: 0, count: Int(PATH_MAX))
    let resolved = buffer.withUnsafeMutableBufferPointer { output in
        path.withCString { input in
            Darwin.realpath(input, output.baseAddress)
        }
    }
    guard resolved != nil else { return nil }
    return URL(fileURLWithPath: String(cString: buffer), isDirectory: true)
}

func canonicalDirectory(_ raw: String) -> URL? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains("\0") else { return nil }
    let expanded = value.hasPrefix("~/")
        ? HOME.appendingPathComponent(String(value.dropFirst(2)), isDirectory: true).path
        : value
    guard expanded.hasPrefix("/") else { return nil }
    let manager = FileManager.default
    var existing = URL(fileURLWithPath: expanded, isDirectory: true).standardizedFileURL
    var missing: [String] = []
    while true {
        var isDirectory: ObjCBool = false
        if manager.fileExists(atPath: existing.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue,
                  var resolved = realDirectoryURL(existing.path) else { return nil }
            for component in missing {
                resolved.appendPathComponent(component, isDirectory: true)
            }
            return resolved
        }
        if (try? manager.destinationOfSymbolicLink(atPath: existing.path)) != nil {
            return nil
        }
        let parent = existing.deletingLastPathComponent()
        guard parent.path != existing.path else { return nil }
        missing.insert(existing.lastPathComponent, at: 0)
        existing = parent
    }
}

func normalizedPathComponents(_ url: URL) -> [String] {
    url.standardizedFileURL.pathComponents
        .filter { $0 != "/" }
        .map { $0.precomposedStringWithCanonicalMapping.lowercased(with: Locale(identifier: "en_US_POSIX")) }
}

func isSameOrNested(_ candidate: URL, under root: URL) -> Bool {
    let path = normalizedPathComponents(candidate)
    let base = normalizedPathComponents(root)
    return path.count >= base.count && Array(path.prefix(base.count)) == base
}

func pathsOverlap(_ left: URL, _ right: URL) -> Bool {
    isSameOrNested(left, under: right) || isSameOrNested(right, under: left)
}

func environmentDirectory(_ name: String, fallback: URL) -> URL {
    guard let raw = ProcessInfo.processInfo.environment[name],
          raw.hasPrefix("/"),
          !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return fallback
    }
    return URL(fileURLWithPath: raw, isDirectory: true).standardizedFileURL
}

let DURABLE_DATA_DIR = environmentDirectory(
    "YULU_APPLICATION_SUPPORT_DIR",
    fallback: HOME.appendingPathComponent("Library/Application Support/Yulu", isDirectory: true)
)
let IPC_DIR = environmentDirectory(
    "YULU_IPC_DIR",
    fallback: HOME.appendingPathComponent("Library/Caches/Yulu", isDirectory: true)
)
let LOGS_DIR = environmentDirectory(
    "YULU_LOG_DIR",
    fallback: HOME.appendingPathComponent("Library/Logs/Yulu", isDirectory: true)
)
let LEGACY_READ_ONLY_DATA_DIR = environmentDirectory(
    "YULU_LEGACY_READ_ONLY_DATA_DIR",
    fallback: HOME.appendingPathComponent(".config/yulu", isDirectory: true)
)
let CONFIG_DIR = DURABLE_DATA_DIR
let CONFIG_READ_PATHS = [
    DURABLE_DATA_DIR.appendingPathComponent("config.json"),
    LEGACY_READ_ONLY_DATA_DIR.appendingPathComponent("config.json"),
]
let SOCKET_PATH = IPC_DIR.appendingPathComponent("audio_daemon.sock")
let SOCKET_LOCK_PATH = IPC_DIR.appendingPathComponent(".audio_daemon.lock")
let STATE_PATH = DURABLE_DATA_DIR.appendingPathComponent(".state.json")
let PID_PATH = IPC_DIR.appendingPathComponent(".audio_daemon.pid")
let LOG_PATH = LOGS_DIR.appendingPathComponent("audio_daemon.log")
let DEFAULT_SILENCE_THRESHOLD: Float = 0.01
let DEFAULT_SILENCE_SEC: TimeInterval = 300
let SAMPLE_RATE: UInt32 = 48000
let DEFAULT_MIC_GAIN: Float = 2.4

var SYS_READY = false
/// When true, SCStream / ScreenCaptureKit is intentionally not started
/// (voicemail / dictation use case). The WAV's R channel stays at 0.
var SYS_DISABLED = false
var SYS_ERROR = ""
var MIC_READY = false
var MIC_ERROR = ""
var SYS_FORMAT_LOGGED = false

func defaultRecordingDir() -> URL {
    let candidate = HOME.appendingPathComponent("Movies/Yulu", isDirectory: true)
    guard let safe = safeMediaDirectory(candidate.path) else {
        fatalError("no safe Yulu Media Library path")
    }
    return safe
}

func runtimeScriptDir() -> URL {
    if let override = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"],
       !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true)
    }
    let bundle = Bundle.main.bundleURL
    if bundle.lastPathComponent == "YuluCapture.app" {
        let productApp = bundle
            .deletingLastPathComponent() // Helpers
            .deletingLastPathComponent() // Contents
            .deletingLastPathComponent() // Yulu.app
        return productApp.appendingPathComponent("Contents/Resources/runtime/yulu/scripts", isDirectory: true)
    }
    return bundle.deletingLastPathComponent()
}

func bundledPythonExecutable() -> URL? {
    let bundle = Bundle.main.bundleURL
    if bundle.lastPathComponent == "YuluCapture.app" {
        let productApp = bundle
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let bundled = productApp.appendingPathComponent(
            "Contents/Resources/runtime/python/bin/python3"
        )
        if FileManager.default.isExecutableFile(atPath: bundled.path) {
            return bundled
        }
    }
    if let override = ProcessInfo.processInfo.environment["YULU_PYTHON"],
       override.hasPrefix("/"),
       FileManager.default.isExecutableFile(atPath: override) {
        return URL(fileURLWithPath: override)
    }
    return nil
}

func configuredRecordingDirectory(_ raw: String) -> URL? {
    safeMediaDirectory(raw)
}

func safeMediaDirectory(_ raw: String) -> URL? {
    guard let candidate = canonicalDirectory(raw) else { return nil }
    let operationalRoots = [DURABLE_DATA_DIR, IPC_DIR, LOGS_DIR, LEGACY_READ_ONLY_DATA_DIR]
    for root in operationalRoots {
        guard let canonicalRoot = canonicalDirectory(root.path) else { return nil }
        if pathsOverlap(candidate, canonicalRoot) { return nil }
    }
    return candidate
}

func loadRecordingDir() -> URL {
    if let raw = ProcessInfo.processInfo.environment["YULU_MEDIA_LIBRARY_DIR"],
       let configured = safeMediaDirectory(raw) {
        return configured
    }
    for configPath in CONFIG_READ_PATHS {
        guard let data = try? Data(contentsOf: configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let audio = json["audio"] as? [String: Any],
              let raw = audio["output_dir"] as? String,
              let configured = configuredRecordingDirectory(raw) else {
            continue
        }
        return configured
    }
    return defaultRecordingDir()
}

let RECORDING_DIR = loadRecordingDir()

func safeRecordingSubdirectory(_ raw: String) -> URL? {
    guard let candidate = canonicalDirectory(raw),
          let recordingRoot = canonicalDirectory(RECORDING_DIR.path),
          isSameOrNested(candidate, under: recordingRoot) else {
        return nil
    }
    return candidate
}

var logFile: FileHandle?
func log(_ msg: String) {
    let df = DateFormatter(); df.dateFormat = "yyyy-MM-dd HH:mm:ss"
    let line = "[\(df.string(from: Date()))] \(msg)"
    print(line); fflush(stdout)
    logFile?.write(Data((line + "\n").utf8))
}

func launchMeetingSilencePrompt() -> Bool {
    let scriptDir = runtimeScriptDir()
    let meetingDaemon = scriptDir.appendingPathComponent("meeting_daemon.py")
    guard FileManager.default.fileExists(atPath: meetingDaemon.path),
          let python = bundledPythonExecutable() else {
        log("Silence prompt adapter missing: \(meetingDaemon.path)")
        return false
    }
    let task = Process()
    task.executableURL = python
    task.arguments = ["-B", meetingDaemon.path, "auto_stop"]
    var environment = ProcessInfo.processInfo.environment
    environment["PYTHONPATH"] = scriptDir.path
    environment["PYTHONDONTWRITEBYTECODE"] = "1"
    task.environment = environment
    task.currentDirectoryURL = scriptDir
    do {
        try task.run()
        log("🔇 Silence threshold reached — asking before stopping meeting recording")
        return true
    } catch {
        log("Silence prompt launch failed: \(error)")
        return false
    }
}

// ─── WAV 写入器 ───────────────────────────────────────

final class AnchoredRecordingDirectory {
    let rootURL: URL
    let targetURL: URL
    private let rootFD: Int32
    private let targetFD: Int32
    private let rootMetadata: stat
    private let targetMetadata: stat

    init?(root: URL, target: URL) {
        let approvedRoot = root
        let approvedTarget = target
        guard isSameOrNested(approvedTarget, under: approvedRoot),
              let openedRoot = Self.openOrCreateAbsoluteDirectory(approvedRoot) else {
            return nil
        }
        var openedRootMetadata = stat()
        guard Darwin.fstat(openedRoot, &openedRootMetadata) == 0 else {
            Darwin.close(openedRoot)
            return nil
        }
        let rootComponents = approvedRoot.pathComponents
        let targetComponents = approvedTarget.pathComponents
        let relativeComponents = Array(targetComponents.dropFirst(rootComponents.count))
        guard let openedTarget = Self.openOrCreateRelativeDirectory(
            parentFD: openedRoot,
            components: relativeComponents
        ) else {
            Darwin.close(openedRoot)
            return nil
        }
        var openedTargetMetadata = stat()
        guard Darwin.fstat(openedTarget, &openedTargetMetadata) == 0,
              Self.pathStillNamesDirectory(approvedRoot, metadata: openedRootMetadata),
              Self.pathStillNamesDirectory(approvedTarget, metadata: openedTargetMetadata) else {
            Darwin.close(openedTarget)
            Darwin.close(openedRoot)
            return nil
        }
        rootURL = approvedRoot
        targetURL = approvedTarget
        rootFD = openedRoot
        targetFD = openedTarget
        rootMetadata = openedRootMetadata
        targetMetadata = openedTargetMetadata
    }

    deinit {
        Darwin.close(targetFD)
        Darwin.close(rootFD)
    }

    func createFile(named filename: String) -> (url: URL, handle: FileHandle)? {
        guard !filename.isEmpty,
              filename != ".",
              filename != "..",
              !filename.contains("/"),
              stillAnchored() else {
            return nil
        }
        let fd = filename.withCString {
            Darwin.openat(
                targetFD,
                $0,
                O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW,
                mode_t(0o600)
            )
        }
        guard fd >= 0 else { return nil }
        guard stillAnchored() else {
            Darwin.close(fd)
            filename.withCString { _ = Darwin.unlinkat(targetFD, $0, 0) }
            return nil
        }
        return (
            targetURL.appendingPathComponent(filename, isDirectory: false),
            FileHandle(fileDescriptor: fd, closeOnDealloc: true)
        )
    }

    func removeFile(named filename: String) {
        filename.withCString { _ = Darwin.unlinkat(targetFD, $0, 0) }
    }

    private func stillAnchored() -> Bool {
        Self.pathStillNamesDirectory(rootURL, metadata: rootMetadata)
            && Self.pathStillNamesDirectory(targetURL, metadata: targetMetadata)
    }

    private static func openOrCreateAbsoluteDirectory(_ url: URL) -> Int32? {
        var directoryFD = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        guard directoryFD >= 0 else { return nil }
        for component in url.pathComponents where component != "/" {
            guard let nextFD = openOrCreateDirectory(parentFD: directoryFD, name: component) else {
                Darwin.close(directoryFD)
                return nil
            }
            Darwin.close(directoryFD)
            directoryFD = nextFD
        }
        return directoryFD
    }

    private static func openOrCreateRelativeDirectory(
        parentFD: Int32,
        components: [String]
    ) -> Int32? {
        var directoryFD = Darwin.dup(parentFD)
        guard directoryFD >= 0 else { return nil }
        for component in components {
            guard component != ".", component != "..", !component.contains("/"),
                  let nextFD = openOrCreateDirectory(parentFD: directoryFD, name: component) else {
                Darwin.close(directoryFD)
                return nil
            }
            Darwin.close(directoryFD)
            directoryFD = nextFD
        }
        return directoryFD
    }

    private static func openOrCreateDirectory(parentFD: Int32, name: String) -> Int32? {
        let flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW
        var opened = name.withCString { Darwin.openat(parentFD, $0, flags) }
        if opened < 0 && errno == ENOENT {
            let created = name.withCString { Darwin.mkdirat(parentFD, $0, mode_t(0o700)) }
            guard created == 0 || errno == EEXIST else { return nil }
            opened = name.withCString { Darwin.openat(parentFD, $0, flags) }
        }
        return opened >= 0 ? opened : nil
    }

    private static func pathStillNamesDirectory(_ url: URL, metadata: stat) -> Bool {
        var current = stat()
        let result = url.path.withCString { Darwin.lstat($0, &current) }
        return result == 0
            && (current.st_mode & S_IFMT) == S_IFDIR
            && current.st_dev == metadata.st_dev
            && current.st_ino == metadata.st_ino
    }
}

class WavWriter {
    let url: URL
    private let directory: AnchoredRecordingDirectory
    private var handle: FileHandle?
    private var audioSize: UInt32 = 0
    private var lastHeaderPatch = Date.distantPast
    private let lock = NSLock()

    init?(directory: AnchoredRecordingDirectory, filename: String) {
        guard let created = directory.createFile(named: filename) else { return nil }
        self.url = created.url
        self.directory = directory
        // 82 bytes = RIFF(12) + fmt chunk(24) + LIST-INFO-ICMT chunk(38) + data header(8)
        let h = created.handle
        do {
            try h.write(contentsOf: Data(repeating: 0, count: 82))
        } catch {
            try? h.close()
            directory.removeFile(named: filename)
            return nil
        }
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
    var d: [String: Any] = [
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
    if recording, let prior = readStateDict(), (prior["recording"] as? Bool) == true {
        var segments = (prior["segments"] as? [String]) ?? []
        if let oldPath = (prior["audio_path"] as? String) ?? (prior["file_path"] as? String),
           !oldPath.isEmpty && !segments.contains(oldPath) {
            segments.append(oldPath)
        }
        if !path.isEmpty && !segments.contains(path) {
            segments.append(path)
        }
        d["segments"] = segments
        d["resume_count"] = prior["resume_count"] ?? 0
        d["meeting_id"] = prior["meeting_id"] ?? ""
    }
    if let data = try? JSONSerialization.data(withJSONObject: d, options: .prettyPrinted) {
        try? data.write(to: STATE_PATH, options: [.atomic])
    }
}

func readStateDict() -> [String: Any]? {
    guard let data = try? Data(contentsOf: STATE_PATH),
          let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return nil
    }
    return obj
}

func interruptedRecordingTitle() -> String? {
    guard let state = readStateDict(),
          (state["recording"] as? Bool) == true,
          (state["backend"] as? String ?? "daemon") == "daemon" else {
        return nil
    }
    let title = (state["title"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    return title.isEmpty ? "meeting" : title
}

enum MeetingMicState: String {
    case unmuted
    case muted
    case unknown
}

struct MeetingMuteClassifier {
    private static func normalized(_ value: String) -> String {
        value.lowercased()
            .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func actionMatches(_ label: String, _ action: String) -> Bool {
        label == action || label.hasPrefix(action + " ") || label.hasPrefix(action + "(")
    }

    static func classifyControlLabel(_ value: String) -> MeetingMicState? {
        let label = normalized(value)
        let ignored = [
            "mute all", "unmute all", "ask to unmute", "mute participant",
            "全体静音", "将所有人静音", "解除所有人静音", "请求解除静音",
        ]
        guard !label.isEmpty, !ignored.contains(where: label.contains) else { return nil }

        // Button labels describe the action, not the current state: an "Unmute"
        // button means the meeting microphone is currently muted.
        let mutedActions = [
            "unmute my audio", "unmute audio", "unmute", "turn on microphone",
            "start microphone", "解除静音", "取消静音", "开启麦克风", "打开麦克风",
            "麦克风已关闭",
        ]
        if mutedActions.contains(where: { actionMatches(label, $0) }) { return .muted }

        let unmutedActions = [
            "mute my audio", "mute audio", "mute", "turn off microphone",
            "stop microphone", "静音", "关闭麦克风", "麦克风已开启",
        ]
        if unmutedActions.contains(where: { actionMatches(label, $0) }) { return .unmuted }
        return nil
    }

    static func isSupportedApp(appName: String, bundleID: String?) -> Bool {
        let app = normalized("\(appName) \(bundleID ?? "")")
        return [
            "zoom.us", "zoom workplace", "us.zoom.xos",
            "腾讯会议", "tencent meeting", "tencentmeeting", "voov meeting", "wemeet", "com.tencent.meeting",
            "google chrome", "com.google.chrome", " arc ", "company.thebrowser.browser",
            "safari", "microsoft edge", "com.microsoft.edgemac",
        ].contains(where: app.contains)
    }

    static func isSupportedMeetingWindow(appName: String, bundleID: String?, title: String) -> Bool {
        let app = normalized("\(appName) \(bundleID ?? "")")
        if ["zoom.us", "zoom workplace", "us.zoom.xos"].contains(where: app.contains) {
            return true
        }
        if ["腾讯会议", "tencent meeting", "tencentmeeting", "voov meeting", "wemeet", "com.tencent.meeting"].contains(where: app.contains) {
            return true
        }
        let browser = [
            "google chrome", "com.google.chrome", " arc ", "company.thebrowser.browser",
            "safari", "microsoft edge", "com.microsoft.edgemac",
        ].contains(where: app.contains)
        let window = normalized(title)
        return browser && (window.contains("google meet") || window.contains("meet.google.com") || window.hasPrefix("meet -"))
    }
}

func micSamplesForRecording(_ samples: [Float], gain: Float, meetingState: MeetingMicState) -> [Int16] {
    if meetingState == .muted {
        return [Int16](repeating: 0, count: samples.count)
    }
    return samples.map { Int16(max(-1.0, min(1.0, $0 * gain)) * Float(Int16.max)) }
}

// ─── 音频数据管理器 + 源分离立体声 (L=mic, R=sys) ───

class AudioRecorder {
    private let recorderQueue = DispatchQueue(label: "com.yulu.audioRecorder")
    private let recorderQueueKey = DispatchSpecificKey<Bool>()

    private var writer: WavWriter?
    private var isRecordingState = false
    private var startTime: Date?
    private var lastMicAudioTime: Date?
    private var lastSysAudioTime: Date?
    private var silenceTimer: DispatchSourceTimer?
    private var silenceSecondsState = DEFAULT_SILENCE_SEC
    private var silenceThresholdState = DEFAULT_SILENCE_THRESHOLD
    private var outputDirState: URL = RECORDING_DIR
    var onStopRequest: (() -> Void)?
    private var sysGapMicFallbackLogged = false
    private var micGainState: Float = DEFAULT_MIC_GAIN
    private var micLevelState: Float = 0
    private var meetingMicStateState: MeetingMicState = .unknown
    private var autoStopRequested = false

    // Streaming buffers
    private var sysBuf: [Int16] = []
    private var micBuf: [Int16] = []

    init() {
        recorderQueue.setSpecific(key: recorderQueueKey, value: true)
    }

    private func onRecorderQueue() -> Bool {
        DispatchQueue.getSpecific(key: recorderQueueKey) == true
    }

    private func syncState<T>(_ body: () -> T) -> T {
        if onRecorderQueue() {
            return body()
        }
        return recorderQueue.sync(execute: body)
    }

    var isRecording: Bool {
        syncState { isRecordingState }
    }

    var currentFilePath: String {
        syncState { writer?.url.path ?? "" }
    }

    var micGain: Float {
        syncState { micGainState }
    }

    var micLevel: Float {
        syncState { micLevelState }
    }

    var meetingMicState: MeetingMicState {
        syncState { meetingMicStateState }
    }

    func updateMeetingMicState(_ state: MeetingMicState) {
        recorderQueue.async { [weak self] in
            guard let self = self, self.meetingMicStateState != state else { return }
            self.meetingMicStateState = state
            guard self.isRecordingState else { return }
            switch state {
            case .muted:
                log("🎤 Meeting mic muted — microphone track suppressed")
            case .unmuted:
                log("🎤 Meeting mic unmuted — microphone track recording")
            case .unknown:
                log("🎤 Meeting mic state unknown — microphone track recording")
            }
        }
    }

    func configure(silenceSeconds: TimeInterval, silenceThreshold: Float, outputDir: URL) {
        syncState {
            silenceSecondsState = silenceSeconds
            silenceThresholdState = silenceThreshold
            outputDirState = outputDir
        }
    }

    func start(title: String) -> String? {
        return syncState {
            if isRecordingState {
                return writer?.url.path
            }

            let df = DateFormatter(); df.dateFormat = "yyyyMMdd_HHmmss"
            let fn = "\(title.components(separatedBy: .alphanumerics.inverted).joined())_\(df.string(from: Date())).wav"
            guard let directory = AnchoredRecordingDirectory(
                root: RECORDING_DIR,
                target: outputDirState
            ), let w = WavWriter(directory: directory, filename: fn) else {
                log("Recording directory changed or is unsafe: \(outputDirState.path)")
                return nil
            }
            let url = w.url
            writer = w
            isRecordingState = true
            startTime = Date()
            lastMicAudioTime = Date()
            lastSysAudioTime = Date()
            sysBuf = []
            micBuf = []
            micLevelState = 0
            sysGapMicFallbackLogged = false
            meetingMicStateState = .unknown
            autoStopRequested = false
            writeState(recording: true, title: title, path: url.path)
            log("🎙 \(fn)")
            startSilenceMonitorOnQueue()
            return url.path
        }
    }

    @discardableResult
    func stop() -> (path: String?, duration: Int) {
        return syncState {
            isRecordingState = false
            stopSilenceMonitorOnQueue()
            let dur = startTime.map { Int(Date().timeIntervalSince($0)) } ?? 0
            flushBuffersOnQueue()
            let p = writer?.url.path
            writer?.finalize()
            writer = nil
            startTime = nil
            lastMicAudioTime = nil
            lastSysAudioTime = nil
            sysBuf = []
            micBuf = []
            micLevelState = 0
            meetingMicStateState = .unknown
            writeState(recording: false)
            log("⏹ \(dur)s")
            return (p, dur)
        }
    }

    func onSysAudio(_ samples: [Int16]) {
        recorderQueue.async { [weak self] in
            guard let self = self, self.isRecordingState else { return }
            self.sysBuf.append(contentsOf: samples)
            self.sysGapMicFallbackLogged = false
            if self.calcRMS(samples) > self.silenceThresholdState {
                self.lastSysAudioTime = Date()
            }
            self.mixAndWriteOnQueue()
        }
    }

    func onMicAudio(_ samples: [Float]) {
        recorderQueue.async { [weak self] in
            guard let self = self, self.isRecordingState else { return }
            let gain = self.micGainState
            let ints = micSamplesForRecording(samples, gain: gain, meetingState: self.meetingMicStateState)
            self.micBuf.append(contentsOf: ints)
            let rms = self.calcRMS(ints)
            self.micLevelState = self.meetingMicStateState == .muted ? 0 : max(rms, self.micLevelState * 0.72)
            if self.meetingMicStateState != .muted && rms > self.silenceThresholdState {
                self.lastMicAudioTime = Date()
            }
            self.mixAndWriteOnQueue()
        }
    }

    func noteCaptureRouteChange(now: Date = Date()) {
        syncState {
            guard isRecordingState else { return }
            lastMicAudioTime = now
            lastSysAudioTime = now
        }
    }

    func silenceExpired(now: Date = Date()) -> Bool {
        return syncState {
            silenceExpiredOnQueue(now: now)
        }
    }

    func _selfTestSetSilenceState(recording: Bool, micLast: Date?, sysLast: Date?, silenceSeconds: TimeInterval = DEFAULT_SILENCE_SEC) {
        syncState {
            isRecordingState = recording
            lastMicAudioTime = micLast
            lastSysAudioTime = sysLast
            silenceSecondsState = silenceSeconds
        }
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
    private func mixAndWriteOnQueue() {
        guard let w = writer else { return }

        let sysFrames = sysBuf.count / 2
        let micFrames = micBuf.count
        let micOnly = SYS_DISABLED
        // If the process tap is stuck delivering all-zero buffers, sysBuf never
        // receives frames. Keep preserving the mic track instead of letting it
        // pile up in memory until a force-kill leaves only an 82-byte WAV header.
        let forceMicOnly = !micOnly && sysFrames == 0 && micFrames >= Int(SAMPLE_RATE)
        // In normal meeting recordings the mic and system callbacks arrive on
        // independent queues. Driving output by the longer buffer turns
        // each early callback into a zero-padded chunk, stretching the timeline
        // into audible sys-only/mic-only stutter. Only true mic-only recordings
        // and sys-gap fallback recordings may be driven by mic frames; ordinary
        // dual-source recordings write common frames and leave the short side
        // buffered for the next callback.
        let outFrames = (micOnly || forceMicOnly) ? micFrames : min(sysFrames, micFrames)
        guard outFrames >= 512 else { return }  // wait for ~10 ms

        let micChunk = Array(micBuf.prefix(outFrames))
        micBuf.removeFirst(outFrames)

        let sysChunk: [Int16]
        if micOnly || forceMicOnly {
            sysChunk = [Int16](repeating: 0, count: outFrames * 2)
        } else {
            sysChunk = Array(sysBuf.prefix(outFrames * 2))
            sysBuf.removeFirst(outFrames * 2)
        }
        let shouldLogFallback = forceMicOnly && !sysGapMicFallbackLogged
        if forceMicOnly { sysGapMicFallbackLogged = true }

        if shouldLogFallback {
            log("⚠️ Sys audio unavailable; preserving mic-only audio until system audio resumes")
        }
        let out = channelInterleave(sysStereo: sysChunk, micMono: micChunk)
        w.append(Data(bytes: out, count: out.count * 2))
    }

    private func flushBuffersOnQueue() {
        guard let w = writer else { return }
        let sysFrames = sysBuf.count / 2
        let micFrames = micBuf.count
        let outFrames = max(sysFrames, micFrames)
        if outFrames == 0 { return }

        let micChunk: [Int16] = micBuf + [Int16](repeating: 0, count: max(0, outFrames - micFrames))
        let sysChunk: [Int16] = sysBuf + [Int16](repeating: 0, count: max(0, outFrames * 2 - sysBuf.count))
        micBuf.removeAll()
        sysBuf.removeAll()

        let out = channelInterleave(sysStereo: Array(sysChunk.prefix(outFrames * 2)),
                                     micMono:   Array(micChunk.prefix(outFrames)))
        w.append(Data(bytes: out, count: out.count * 2))
    }

    private func silenceExpiredOnQueue(now: Date = Date()) -> Bool {
        guard isRecordingState else { return false }
        let seconds = silenceSecondsState
        let micQuiet = (lastMicAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= seconds
        let sysQuiet = (lastSysAudioTime.map { now.timeIntervalSince($0) } ?? .infinity) >= seconds
        return micQuiet && sysQuiet
    }

    private func startSilenceMonitorOnQueue() {
        guard silenceTimer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: recorderQueue)
        timer.schedule(deadline: .now() + 1, repeating: 1)
        timer.setEventHandler { [weak self] in
            guard let self = self, self.silenceExpiredOnQueue() else { return }
            guard !self.autoStopRequested else { return }
            self.autoStopRequested = true
            let action = SYS_DISABLED ? "auto stop" : "confirm before stop"
            log("🔇 silence \(Int(self.silenceSecondsState))s (both channels) — \(action)")
            DispatchQueue.main.async { [weak self] in
                self?.onStopRequest?()
            }
        }
        silenceTimer = timer
        timer.resume()
    }

    private func stopSilenceMonitorOnQueue() {
        silenceTimer?.setEventHandler {}
        silenceTimer?.cancel()
        silenceTimer = nil
        autoStopRequested = false
    }
}

final class MeetingMuteMonitor {
    private let recorder: AudioRecorder
    private let queue = DispatchQueue(label: "com.yulu.meeting-mute-monitor", qos: .utility)
    private var timer: DispatchSourceTimer?

    init(recorder: AudioRecorder) {
        self.recorder = recorder
    }

    func start() {
        queue.async { [weak self] in
            guard let self = self, self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now(), repeating: 1)
            timer.setEventHandler { [weak self] in
                guard let self = self else { return }
                self.recorder.updateMeetingMicState(self.scan())
            }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() {
        queue.async { [weak self] in
            guard let self = self else { return }
            self.timer?.setEventHandler {}
            self.timer?.cancel()
            self.timer = nil
            self.recorder.updateMeetingMicState(.unknown)
        }
    }

    private func scan() -> MeetingMicState {
        guard AXIsProcessTrusted() else { return .unknown }
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard MeetingMuteClassifier.isSupportedApp(
                appName: app.localizedName ?? "",
                bundleID: app.bundleIdentifier
            ) else { continue }
            let appElement = AXUIElementCreateApplication(app.processIdentifier)
            AXUIElementSetMessagingTimeout(appElement, 0.2)
            var windowsRef: CFTypeRef?
            guard AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef) == .success,
                  let windows = windowsRef as? [AXUIElement] else { continue }
            for window in windows {
                let title = stringAttribute(window, kAXTitleAttribute as CFString) ?? ""
                guard MeetingMuteClassifier.isSupportedMeetingWindow(
                    appName: app.localizedName ?? "",
                    bundleID: app.bundleIdentifier,
                    title: title
                ) else { continue }
                if let state = muteState(in: window) { return state }
            }
        }
        return .unknown
    }

    private func muteState(in root: AXUIElement) -> MeetingMicState? {
        var stack: [(AXUIElement, Int)] = [(root, 0)]
        var visited = 0
        while let (element, depth) = stack.popLast(), visited < 600 {
            visited += 1
            let role = stringAttribute(element, kAXRoleAttribute as CFString) ?? ""
            if ["AXButton", "AXCheckBox", "AXMenuItem", "AXRadioButton", "AXPopUpButton"].contains(role) {
                for attribute in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute] {
                    if let label = stringAttribute(element, attribute as CFString),
                       let state = MeetingMuteClassifier.classifyControlLabel(label) {
                        return state
                    }
                }
            }
            guard depth < 12 else { continue }
            var childrenRef: CFTypeRef?
            if AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &childrenRef) == .success,
               let children = childrenRef as? [AXUIElement] {
                for child in children.reversed() { stack.append((child, depth + 1)) }
            }
        }
        return nil
    }

    private func stringAttribute(_ element: AXUIElement, _ attribute: CFString) -> String? {
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, attribute, &value) == .success else { return nil }
        return value as? String
    }
}

class MicCapture {
    let recorder: AudioRecorder
    private let lifecycleQueue = DispatchQueue(label: "com.yulu.mic-capture.lifecycle")
    private var engine: AVAudioEngine?
    private var configurationObserver: NSObjectProtocol?
    private var generation: UInt64 = 0
    var selectedDeviceUID: String?

    init(recorder: AudioRecorder) { self.recorder = recorder }

    private static func stringProperty(_ device: AudioObjectID, selector: AudioObjectPropertySelector) -> String? {
        var address = AudioObjectPropertyAddress(
            mSelector: selector,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size = UInt32(MemoryLayout<CFString?>.size)
        let pointer = UnsafeMutablePointer<CFString?>.allocate(capacity: 1)
        pointer.initialize(to: nil)
        defer {
            pointer.deinitialize(count: 1)
            pointer.deallocate()
        }
        guard AudioObjectGetPropertyData(device, &address, 0, nil, &size, pointer) == noErr,
              let value = pointer.pointee else { return nil }
        return value as String
    }

    private static func hasStreams(_ device: AudioObjectID, scope: AudioObjectPropertyScope) -> Bool {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: scope,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        return AudioObjectGetPropertyDataSize(device, &address, 0, nil, &size) == noErr && size > 0
    }

    static func availableDevices() -> [String: Any] {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
            return ["error": "coreaudio_device_size_failed"]
        }
        var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
            return ["error": "coreaudio_device_list_failed"]
        }
        var input: [[String: String]] = []
        var output: [[String: String]] = []
        for device in devices {
            guard let uid = stringProperty(device, selector: kAudioDevicePropertyDeviceUID) else { continue }
            let item = ["uid": uid, "name": stringProperty(device, selector: kAudioObjectPropertyName) ?? uid]
            if hasStreams(device, scope: kAudioDevicePropertyScopeInput) { input.append(item) }
            if hasStreams(device, scope: kAudioDevicePropertyScopeOutput) { output.append(item) }
        }
        return ["input": input, "output": output]
    }

    private func audioDeviceID(forUID uid: String) -> AudioDeviceID? {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var size: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
            return nil
        }
        let count = Int(size) / MemoryLayout<AudioDeviceID>.size
        var devices = [AudioDeviceID](repeating: 0, count: count)
        guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
            return nil
        }
        for device in devices where Self.stringProperty(device, selector: kAudioDevicePropertyDeviceUID) == uid {
            return device
        }
        return nil
    }

    private func configureInputDevice(_ input: AVAudioInputNode) -> String? {
        guard let uid = selectedDeviceUID?.trimmingCharacters(in: .whitespacesAndNewlines),
              !uid.isEmpty else { return nil }
        guard let deviceID = audioDeviceID(forUID: uid) else {
            return "mic_device_not_found: \(uid)"
        }
        guard let audioUnit = input.audioUnit else {
            return "mic_input_audio_unit_unavailable"
        }
        var selectedID = deviceID
        let status = AudioUnitSetProperty(
            audioUnit,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &selectedID,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status == noErr {
            log("🎤 Mic input device selected: \(uid)")
            return nil
        } else {
            return "mic_device_selection_failed: \(status)"
        }
    }

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
        lifecycleQueue.sync { startOnQueue() }
    }

    private func startOnQueue() {
        guard engine == nil else { return }
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if let error = configureInputDevice(input) {
            MIC_READY = false
            MIC_ERROR = error
            log("🎤 Mic input device configuration failed: \(error)")
            return
        }
        let fmt = input.outputFormat(forBus: 0)

        input.installTap(onBus: 0, bufferSize: 4096, format: fmt) { [weak self] buf, _ in
            guard let self = self else { return }
            guard let chData = buf.floatChannelData else { return }
            let len = Int(buf.frameLength)
            let channels = max(1, Int(buf.format.channelCount))
            let samples: [Float]
            if channels == 1 {
                samples = Array(UnsafeBufferPointer(start: chData[0], count: len))
            } else {
                var mixed = [Float](repeating: 0, count: len)
                for channel in 0..<channels {
                    let channelSamples = UnsafeBufferPointer(start: chData[channel], count: len)
                    for i in 0..<len {
                        mixed[i] += channelSamples[i]
                    }
                }
                let divisor = Float(channels)
                samples = mixed.map { $0 / divisor }
            }
            self.recorder.onMicAudio(samples)
        }

        do {
            try engine.start()
            self.engine = engine
            generation &+= 1
            let currentGeneration = generation
            configurationObserver = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: engine,
                queue: nil
            ) { [weak self, weak engine] _ in
                guard let self = self, let engine = engine else { return }
                self.lifecycleQueue.async {
                    guard self.engine === engine,
                          self.generation == currentGeneration else { return }
                    self.restartAfterConfigurationChange()
                }
            }
            MIC_READY = true; MIC_ERROR = ""
            log("🎤 Mic capture started (channels=\(fmt.channelCount), gain=\(recorder.micGain)x)")
        }
        catch { MIC_READY = false; MIC_ERROR = "\(error)"; log("Mic start failed: \(error)") }
    }

    private func restartAfterConfigurationChange() {
        log("🎤 Mic audio route changed — restarting capture")
        recorder.noteCaptureRouteChange()
        stopOnQueue(logIdle: false)
        Thread.sleep(forTimeInterval: 0.1)
        startOnQueue()
    }

    func stop() {
        lifecycleQueue.sync { stopOnQueue(logIdle: true) }
    }

    private func stopOnQueue(logIdle: Bool) {
        generation &+= 1
        if let observer = configurationObserver {
            NotificationCenter.default.removeObserver(observer)
            configurationObserver = nil
        }
        if let engine = engine {
            engine.inputNode.removeTap(onBus: 0)
            engine.stop()
            self.engine = nil
        }
        if logIdle { log("🎤 Mic idle") }
    }
}

// ─── SCStream 输出处理器 ──────────────────────────────

@available(macOS 12.3, *)
class SysAudioOutput: NSObject, SCStreamOutput {
    unowned let recorder: AudioRecorder
    init(_ r: AudioRecorder) { recorder = r }

    func stream(_ s: SCStream, didOutputSampleBuffer buf: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
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

// ─── 捕获后端协议 (CaptureBackend) ────────────────────
//
// PLAT-01 / D-02: the single platform seam for system-audio capture. It hides
// BOTH the ScreenCaptureKit vocabulary (SCStreamConfiguration / SCContentFilter)
// and the macOS-14.4 Core Audio process-tap vocabulary (CATapDescription) behind
// "emit PCM frames + list sources." The frame sink stays exactly as today —
// each conformer converts its native buffer to interleaved Int16 and pushes it
// through `recorder.onSysAudio([Int16])`.
//
// D-09 (interface neutrality): NO SCStreamConfiguration / SCContentFilter /
// CATapDescription / TCC token may appear in this protocol or in CaptureSource.
// The arms own those internally. The 13–14.3 arm is ScreenCaptureKitBackend
// (below); the 14.4+ ProcessTapBackend arm lands in 02-04 behind `if #available`.

/// A capturable audio source (display / app / system). Neutral by design:
/// SCK derives these from SCShareableContent displays; the tap arm will derive
/// them from the process-object list. Hides both representations.
struct CaptureSource {
    let id: String
    let name: String
    let kind: String   // "display" | "app" | "system"
}

protocol CaptureBackend: AnyObject {
    /// True once the backend has verified its capture permission (TCC handshake done).
    var isReady: Bool { get }
    /// Last capture error surfaced by the backend ("" when healthy).
    var lastError: String { get }

    /// Probe permission without leaving the OS recording indicator on (idle daemon).
    func probePermission()

    /// Begin emitting system-audio PCM to the sink. Blocks until actually capturing.
    func startCapture()
    /// Stop capturing; blocks until the OS-level capture indicator clears.
    func stopCapture()

    /// Capturable sources. SCK: SCShareableContent displays; taps: process list.
    func sources() -> [CaptureSource]
}

// ─── 屏幕捕获管理器 (ScreenCaptureKit arm, macOS 13–14.3) ─────
//
// D-03: this is the EXISTING capture code, refactored in place to conform to
// CaptureBackend — NOT rewritten. The planar-Float32 → interleaved-Int16
// conversion (SysAudioOutput, above) and the start/stop/probe bodies are kept
// verbatim; only the type name, conformance, and isReady/lastError/sources()
// bridge are added.

@available(macOS 12.3, *)
final class ScreenCaptureKitBackend: CaptureBackend {
    let recorder: AudioRecorder
    let output: SysAudioOutput
    var stream: SCStream?

    init(recorder: AudioRecorder) {
        self.recorder = recorder
        self.output = SysAudioOutput(recorder)
    }

    /// CaptureBackend.isReady — bridge the existing process-level SYS_READY global.
    var isReady: Bool { SYS_READY }
    /// CaptureBackend.lastError — bridge the existing process-level SYS_ERROR global.
    var lastError: String { SYS_ERROR }

    /// CaptureBackend.sources() — minimal source list from SCShareableContent
    /// displays. Returns [] if the shareable content cannot be fetched in time;
    /// callers treat an empty list as "no enumerable sources right now."
    func sources() -> [CaptureSource] {
        var result: [CaptureSource] = []
        let sem = DispatchSemaphore(value: 0)
        Task {
            defer { sem.signal() }
            if let content = try? await SCShareableContent.current {
                for d in content.displays {
                    result.append(CaptureSource(
                        id: String(d.displayID),
                        name: "Display \(d.displayID)",
                        kind: "display"
                    ))
                }
            }
        }
        _ = sem.wait(timeout: .now() + 2)
        return result
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

// ─── 进程 Tap 捕获 (Core Audio process-tap arm, macOS 14.4+) ─────
//
// PLAT-02 / D-01 / D-03: the 14.4+ system-audio arm. On 14.4+ the AppDelegate
// selects this behind `if #available(macOS 14.4, *)`; 13–14.3 stays on
// ScreenCaptureKitBackend (the `else`). The macOS FLOOR is NOT raised — this
// arm is gated at 14.4 ONLY because the underlying Core Audio process-tap +
// aggregate-device APIs are unreliable below it (symbols exist at 14.2, but the
// AudioCap project pins stable behavior to 14.4). Do NOT lower the gate.
//
// Why a tap instead of ScreenCaptureKit: the tap requests the narrower
// "System Audio Recording Only" TCC scope, so 14.4+ users escape the weekly
// "Screen & System Audio Recording" re-permission nag (success criterion 3).
//
// Capture sequence (VERIFIED API names, 02-RESEARCH.md:342-405):
//   CATapDescription(stereoGlobalTapButExcludeProcesses: [])  → whole-system tap
//   → AudioHardwareCreateProcessTap → read the tap UID
//   → AudioHardwareCreateAggregateDevice (TapList = [{SubTapUID: <uid>}])
//   → AudioDeviceCreateIOProcIDWithBlock → AudioDeviceStart
// The IO callback delivers Float32 frames; they are converted to interleaved
// Int16 using the SAME clamp/interleave as SysAudioOutput (no re-derivation)
// and pushed through recorder.onSysAudio([Int16]) — the identical frame sink
// the SCK arm uses.
//
// Pitfall 3 (VERIFIED Apple bug, 02-RESEARCH.md:322-326): the tap can keep
// firing the IO callback with correct frameCounts yet deliver all-zero samples
// (silent recording while audio is audible), triggered by sample-rate
// renegotiation, Bluetooth sleep/wake, or long uptime. This backend detects a
// window of frameCount>0-yet-all-zero buffers and recovers by tearing the whole
// tap+aggregate stack down and rebuilding it (it does NOT merely log). The
// existing silence-monitor (startSilenceMonitor) only auto-stops when BOTH
// channels are quiet, so a sys-only zero-out does not false-stop the recording.

private struct ZeroBufferRecoveryPolicy {
    let threshold: Int
    let maxAttempts: Int
    private(set) var consecutiveZeroCallbacks = 0
    private(set) var attempts = 0
    private(set) var episode: UInt64 = 0
    private var armed = true

    init(threshold: Int, maxAttempts: Int) {
        self.threshold = threshold
        self.maxAttempts = maxAttempts
    }

    mutating func resetForRecording() {
        consecutiveZeroCallbacks = 0
        attempts = 0
        episode &+= 1
        armed = true
    }

    mutating func commitRecoveryAttempt() {
        attempts += 1
        consecutiveZeroCallbacks = 0
    }

    mutating func rearmAfterRecovery() {
        consecutiveZeroCallbacks = 0
        episode &+= 1
        armed = true
    }

    mutating func observe(allZero: Bool, running: Bool, rebuilding: Bool) -> Bool {
        guard running else {
            consecutiveZeroCallbacks = 0
            return false
        }
        guard allZero else {
            if consecutiveZeroCallbacks > 0 || !armed { episode &+= 1 }
            consecutiveZeroCallbacks = 0
            armed = true
            return false
        }
        if consecutiveZeroCallbacks == 0 { episode &+= 1 }
        consecutiveZeroCallbacks += 1
        guard armed, !rebuilding, attempts < maxAttempts,
              consecutiveZeroCallbacks >= threshold else { return false }
        armed = false
        return true
    }
}

@available(macOS 14.4, *)
final class ProcessTapBackend: CaptureBackend {
    let recorder: AudioRecorder

    private var tapID: AudioObjectID = 0
    private var aggID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?

    private let lock = NSLock()
    private let lifecycleLock = NSLock()
    private var running = false
    private var _lastError = ""

    // ── Pitfall 3 zero-buffer detection state ──
    // Real silence and a stuck tap both arrive as all-zero buffers. Recover once
    // per continuous zero-buffer episode, re-arm only after real audio returns,
    // and cap the total attempts so a quiet recording cannot rebuild forever.
    private var zeroRecoveryPolicy = ZeroBufferRecoveryPolicy(
        threshold: 200,
        maxAttempts: 3
    )
    private var rebuilding = false
    private var captureGeneration: UInt64 = 0

    init(recorder: AudioRecorder) {
        self.recorder = recorder
    }

    /// CaptureBackend.isReady — bridge to the process-level SYS_READY global so
    /// the socket "status"/"start" gating treats the tap exactly like the SCK arm.
    var isReady: Bool { SYS_READY }
    /// CaptureBackend.lastError — bridge the process-level SYS_ERROR global.
    var lastError: String { SYS_ERROR }

    /// CaptureBackend.sources() — the tap captures the whole system, so it
    /// exposes a single neutral "system" source rather than a per-display list.
    func sources() -> [CaptureSource] {
        return [CaptureSource(id: "system", name: "System Audio", kind: "system")]
    }

    /// Probe permission without leaving a recording indicator on. Building and
    /// immediately tearing down the tap forces the one-time
    /// "System Audio Recording Only" TCC handshake (NSAudioCaptureUsageDescription
    /// prompt) so SYS_READY is accurate while the daemon is idle.
    func probePermission() {
        lifecycleLock.lock()
        let ok = buildTap(probe: true)
        teardown()
        lifecycleLock.unlock()
        if ok {
            SYS_READY = true; SYS_ERROR = ""
            log("🔊 Sys tap probe OK (idle until recording starts)")
        } else {
            SYS_READY = false; SYS_ERROR = _lastError
            log("Sys tap probe failed: \(_lastError)")
        }
    }

    /// Start capturing system audio via the process tap. Blocks until the
    /// aggregate device's IO proc is started (or fails), matching the SCK arm's
    /// synchronous start/stop contract.
    func startCapture() {
        if SYS_DISABLED {
            log("🔇 SYS_DISABLED — mic-only recording mode")
            SYS_READY = false
            return
        }
        lock.lock()
        let already = running
        lock.unlock()
        guard !already else { return }   // idempotent — already capturing

        // Defensive: a prior probe / failed build / stale recording may have left
        // a half-open tap+aggregate (non-zero ids while running == false). Tear it
        // down before rebuilding so a re-arm never stacks a second tap or inherits
        // a poisoned one. teardown() is idempotent on zeroed ids, so this is a
        // no-op in the common clean-start case.
        lifecycleLock.lock()
        teardown()

        if buildTap(probe: false) {
            lifecycleLock.unlock()
            lock.lock()
            running = true
            rebuilding = false
            captureGeneration &+= 1
            zeroRecoveryPolicy.resetForRecording()
            lock.unlock()
            SYS_READY = true; SYS_ERROR = ""
            log("🔊 Sys tap capture started")
        } else {
            lifecycleLock.unlock()
            SYS_READY = false; SYS_ERROR = _lastError
            log("Sys tap capture failed: \(_lastError)")
        }
    }

    /// Stop capturing; tears the whole tap+aggregate stack down. Blocks until the
    /// OS-level device is stopped so the recording indicator clears synchronously.
    func stopCapture() {
        lock.lock(); running = false; lock.unlock()
        lifecycleLock.lock()
        teardown()
        lifecycleLock.unlock()
        log("🔇 Sys tap idle")
    }

    // ── Tap construction (02-RESEARCH.md:342-405) ──
    //
    // Builds the global tap, the private aggregate device wrapping it, and the IO
    // proc. Returns true once AudioDeviceStart succeeds. On any failure it records
    // `_lastError`, tears down whatever was partially created, and returns false.
    private func buildTap(probe: Bool) -> Bool {
        // 1. Describe a whole-system tap (empty exclude list = all processes).
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.isPrivate = true            // don't expose the tap device system-wide
        desc.muteBehavior = .unmuted     // passthrough: the user still hears the meeting
        desc.name = "Yulu-SysTap"

        // 2. Create the tap → an AudioObjectID.
        var tap: AudioObjectID = 0
        let tapErr = AudioHardwareCreateProcessTap(desc, &tap)
        guard tapErr == noErr, tap != 0 else {
            _lastError = "AudioHardwareCreateProcessTap failed (OSStatus \(tapErr))"
            return false
        }
        tapID = tap

        // 3. Read the tap's UID string (needed as the aggregate's SubTap UID).
        guard let tapUID = readTapUID(tap) else {
            _lastError = "tap UID read failed"
            teardown()
            return false
        }

        // 4. Build a PRIVATE aggregate device that contains the tap.
        //    IsPrivate keeps it out of the user-visible device list (T-02-14).
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey as String:         "Yulu-SysTap",
            kAudioAggregateDeviceUIDKey as String:          UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey as String:    true,
            kAudioAggregateDeviceIsStackedKey as String:    false,
            kAudioAggregateDeviceTapAutoStartKey as String: true,
            kAudioAggregateDeviceTapListKey as String: [
                [ kAudioSubTapUIDKey as String: tapUID ],
            ],
        ]
        var agg: AudioObjectID = 0
        let aggErr = AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &agg)
        guard aggErr == noErr, agg != 0 else {
            _lastError = "AudioHardwareCreateAggregateDevice failed (OSStatus \(aggErr))"
            teardown()
            return false
        }
        aggID = agg

        // A bare permission probe only needs the tap+aggregate to have been
        // accepted by the HAL (that is what forces the TCC handshake). Skip the
        // IO proc so the probe never streams a single frame.
        if probe { return true }

        // 5. Install an IO proc that converts Float32 → interleaved Int16 and feeds
        //    the existing sink. The block runs on a realtime CoreAudio thread.
        var proc: AudioDeviceIOProcID?
        let procErr = AudioDeviceCreateIOProcIDWithBlock(&proc, agg, nil) {
            [weak self] (_, inInputData, _, _, _) in
            guard let self = self else { return }
            self.handleIO(inInputData)
        }
        guard procErr == noErr, let p = proc else {
            _lastError = "AudioDeviceCreateIOProcIDWithBlock failed (OSStatus \(procErr))"
            teardown()
            return false
        }
        ioProcID = p

        let startErr = AudioDeviceStart(agg, p)
        guard startErr == noErr else {
            _lastError = "AudioDeviceStart failed (OSStatus \(startErr))"
            teardown()
            return false
        }
        return true
    }

    /// Read kAudioTapPropertyUID off the tap object → its CFString UID.
    private func readTapUID(_ tap: AudioObjectID) -> String? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioTapPropertyUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var uidCF: CFString = "" as CFString
        var size = UInt32(MemoryLayout<CFString>.size)
        let err = withUnsafeMutablePointer(to: &uidCF) { ptr -> OSStatus in
            AudioObjectGetPropertyData(tap, &addr, 0, nil, &size, ptr)
        }
        guard err == noErr else { return nil }
        return uidCF as String
    }

    // ── IO callback: Float32 AudioBufferList → interleaved Int16 → sink ──
    private func handleIO(_ inInputData: UnsafePointer<AudioBufferList>) {
        let abl = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: inInputData))
        guard abl.count > 0 else { return }

        // Gather Float32 samples across the buffer list. A tap aggregate may
        // deliver either one interleaved buffer (mChannelsPerFrame > 1) or
        // several mono buffers (non-interleaved). Normalize to interleaved
        // stereo Float32 first, then reuse the SysAudioOutput clamp verbatim.
        var stereoFloats: [Float] = []

        if abl.count == 1 {
            let buf = abl[0]
            let channels = Int(buf.mNumberChannels)
            let cnt = Int(buf.mDataByteSize) / MemoryLayout<Float>.size
            guard cnt > 0, let data = buf.mData else { return }
            let floats = [Float](UnsafeBufferPointer(
                start: data.assumingMemoryBound(to: Float.self), count: cnt))
            if channels >= 2 {
                // already interleaved L/R/L/R…
                stereoFloats = floats
            } else {
                // mono → duplicate into stereo
                stereoFloats.reserveCapacity(cnt * 2)
                for v in floats { stereoFloats.append(v); stereoFloats.append(v) }
            }
        } else {
            // Non-interleaved: buffer 0 = L, buffer 1 = R (extra channels ignored).
            let lBuf = abl[0]
            let rBuf = abl[1]
            let lCnt = Int(lBuf.mDataByteSize) / MemoryLayout<Float>.size
            let rCnt = Int(rBuf.mDataByteSize) / MemoryLayout<Float>.size
            let frames = min(lCnt, rCnt)
            guard frames > 0, let lData = lBuf.mData, let rData = rBuf.mData else { return }
            let lFloats = [Float](UnsafeBufferPointer(
                start: lData.assumingMemoryBound(to: Float.self), count: lCnt))
            let rFloats = [Float](UnsafeBufferPointer(
                start: rData.assumingMemoryBound(to: Float.self), count: rCnt))
            stereoFloats.reserveCapacity(frames * 2)
            for i in 0..<frames {
                stereoFloats.append(lFloats[i])
                stereoFloats.append(rFloats[i])
            }
        }

        guard !stereoFloats.isEmpty else { return }

        // Pitfall 3: detect frameCount>0-yet-all-zero. `allSatisfy { $0 == 0 }`
        // over a non-empty buffer means the tap claimed frames but delivered
        // silence — count the run and recover if it persists.
        let allZero = stereoFloats.allSatisfy { $0 == 0.0 }
        if allZero {
            lock.lock()
            let isRunning = running
            let tripped = zeroRecoveryPolicy.observe(
                allZero: true,
                running: isRunning,
                rebuilding: rebuilding
            )
            let currentZeroRun = zeroRecoveryPolicy.consecutiveZeroCallbacks
            let generation = captureGeneration
            let zeroEpisode = zeroRecoveryPolicy.episode
            if tripped {
                rebuilding = true
            }
            lock.unlock()
            if tripped {
                log("⚠️ Sys tap delivered \(currentZeroRun) all-zero buffers — teardown+rebuild (Pitfall 3)")
                // Rebuild off the realtime IO thread.
                DispatchQueue.global(qos: .userInitiated).async { [weak self] in
                    self?.recoverFromZeroBuffers(
                        generation: generation,
                        zeroEpisode: zeroEpisode
                    )
                }
            }
            return   // don't push silence into the WAV
        }

        // Real audio resets and re-arms the current zero-buffer episode.
        lock.lock()
        _ = zeroRecoveryPolicy.observe(
            allZero: false,
            running: running,
            rebuilding: rebuilding
        )
        lock.unlock()
        let int16s = stereoFloats.map { Int16(max(-1.0, min(1.0, $0)) * Float(Int16.max)) }
        recorder.onSysAudio(int16s)
    }

    /// Pitfall 3 recovery: full teardown then rebuild of the tap+aggregate stack.
    private func recoverFromZeroBuffers(generation: UInt64, zeroEpisode: UInt64) {
        lifecycleLock.lock()
        defer { lifecycleLock.unlock() }
        lock.lock()
        let sameGeneration = captureGeneration == generation
        let shouldRestart = running && sameGeneration
            && zeroRecoveryPolicy.episode == zeroEpisode
        if shouldRestart {
            zeroRecoveryPolicy.commitRecoveryAttempt()
        } else if sameGeneration {
            rebuilding = false
        }
        lock.unlock()
        guard shouldRestart else { return }

        // A delayed recovery from a previous recording must never tear down the
        // current recording's tap.
        teardown()
        var rebuilt = false
        for delay in [0.0, 0.1, 0.3] {
            if delay > 0 { Thread.sleep(forTimeInterval: delay) }
            lock.lock()
            let stillCurrent = running && captureGeneration == generation
            lock.unlock()
            guard stillCurrent else { break }
            if buildTap(probe: false) {
                rebuilt = true
                break
            }
        }
        if rebuilt {
            SYS_READY = true; SYS_ERROR = ""
            log("🔊 Sys tap rebuilt after zero-buffer recovery")
        } else {
            SYS_READY = false; SYS_ERROR = _lastError
            log("Sys tap rebuild failed: \(_lastError)")
        }
        lock.lock()
        if captureGeneration == generation {
            rebuilding = false
            if rebuilt {
                zeroRecoveryPolicy.rearmAfterRecovery()
            } else {
                running = false
            }
        }
        lock.unlock()
    }

    /// Destroy the IO proc, aggregate device, and tap in the exact order from
    /// 02-RESEARCH.md:399-403. Safe to call repeatedly (idempotent on zeroed ids)
    /// and from both stopCapture() and the Pitfall-3 rebuild path.
    private func teardown() {
        if let proc = ioProcID {
            if aggID != 0 {
                AudioDeviceStop(aggID, proc)
                AudioDeviceDestroyIOProcID(aggID, proc)
            }
            ioProcID = nil
        }
        if aggID != 0 {
            AudioHardwareDestroyAggregateDevice(aggID)
            aggID = 0
        }
        if tapID != 0 {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = 0
        }
    }
}

// ─── Socket 服务器 ────────────────────────────────────

func unixSocketIsReachable(at path: URL) -> Bool {
    guard FileManager.default.fileExists(atPath: path.path) else { return false }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }

    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    _ = path.path.withCString { strncpy(&addr.sun_path.0, $0, min(path.path.utf8.count, 103)) }
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) == 0
        }
    }
}

func acquireExclusiveFileLock(at path: URL) -> Int32? {
    let fd = Darwin.open(path.path, O_CREAT | O_RDWR, 0o600)
    guard fd >= 0 else { return nil }
    guard flock(fd, LOCK_EX | LOCK_NB) == 0 else {
        close(fd)
        return nil
    }
    return fd
}

enum RecordingStartGateState: String {
    case available
    case busy
    case unsafe
}

final class RecordingStartGateLease {
    let state: RecordingStartGateState
    private var fd: Int32

    init(state: RecordingStartGateState, fd: Int32 = -1) {
        self.state = state
        self.fd = fd
    }

    func release() {
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
    }

    deinit { release() }
}

private enum ExistingDirectoryResult {
    case opened(Int32)
    case missing
    case unsafe
}

private func openExistingAnchoredDirectory(_ directory: URL) -> ExistingDirectoryResult {
    let components = directory.pathComponents
    guard directory.path.hasPrefix("/"),
          !components.contains("."),
          !components.contains("..") else {
        return .unsafe
    }
    var directoryFD = Darwin.open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
    guard directoryFD >= 0 else { return .unsafe }
    for component in components where component != "/" {
        let nextFD = component.withCString {
            Darwin.openat(directoryFD, $0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW)
        }
        if nextFD < 0 {
            let failure = errno
            Darwin.close(directoryFD)
            return failure == ENOENT ? .missing : .unsafe
        }
        Darwin.close(directoryFD)
        directoryFD = nextFD
    }
    return .opened(directoryFD)
}

func acquireRecordingStartGate(cacheRoot: URL = IPC_DIR) -> RecordingStartGateLease {
    let lockDirectory = cacheRoot.appendingPathComponent(
        "application-migration",
        isDirectory: true
    )
    let directoryFD: Int32
    switch openExistingAnchoredDirectory(lockDirectory) {
    case .missing:
        return RecordingStartGateLease(state: .available)
    case .unsafe:
        return RecordingStartGateLease(state: .unsafe)
    case .opened(let opened):
        directoryFD = opened
    }
    defer { Darwin.close(directoryFD) }

    var directoryMetadata = stat()
    guard Darwin.fstat(directoryFD, &directoryMetadata) == 0,
          (directoryMetadata.st_mode & S_IFMT) == S_IFDIR,
          directoryMetadata.st_uid == geteuid(),
          (directoryMetadata.st_mode & mode_t(0o777)) == mode_t(0o700) else {
        return RecordingStartGateLease(state: .unsafe)
    }

    let lockFD = "attempt.lock".withCString {
        Darwin.openat(directoryFD, $0, O_RDWR | O_NOFOLLOW)
    }
    if lockFD < 0 {
        return RecordingStartGateLease(state: errno == ENOENT ? .available : .unsafe)
    }
    var lockMetadata = stat()
    guard Darwin.fstat(lockFD, &lockMetadata) == 0,
          (lockMetadata.st_mode & S_IFMT) == S_IFREG,
          lockMetadata.st_uid == geteuid(),
          (lockMetadata.st_mode & mode_t(0o777)) == mode_t(0o600),
          lockMetadata.st_nlink == 1 else {
        Darwin.close(lockFD)
        return RecordingStartGateLease(state: .unsafe)
    }
    if flock(lockFD, LOCK_EX | LOCK_NB) != 0 {
        let failure = errno
        Darwin.close(lockFD)
        return RecordingStartGateLease(
            state: failure == EWOULDBLOCK || failure == EAGAIN ? .busy : .unsafe
        )
    }
    return RecordingStartGateLease(state: .available, fd: lockFD)
}

class SocketServer {
    let recorder: AudioRecorder
    var sock: Int32 = -1
    private(set) var ownsSocketPath = false
    private var singletonLockFD: Int32 = -1
    /// Hooks the daemon uses to start/stop ScreenCaptureKit + microphone capture only
    /// while a recording is in flight, so the macOS menu-bar recording indicator
    /// reflects reality. AppDelegate wires these to the CaptureBackend / MicCapture.
    var onRecordingStart: (() -> Void)?
    var onRecordingStop: (() -> Void)?
    /// Synchronously (re-)arm ONLY the system-audio backend, refreshing SYS_READY /
    /// SYS_ERROR before the "start" readiness gate is evaluated. Needed because a
    /// prior sys-disabled (voicemail / mic-only) recording leaves SYS_READY == false;
    /// without re-arming, the gate would read that stale flag and bail with
    /// sys_capture_not_ready even though the tap could be brought up cleanly.
    /// AppDelegate wires this to CaptureBackend.startCapture(). Mic + the (now
    /// idempotent) sys start still run in onRecordingStart after the reply.
    var rearmSysCapture: (() -> Void)?
    var configureMicDevice: ((String?) -> Void)?
    var listAudioDevices: (() -> [String: Any])?

    // Read requests off the accept thread, then route control actions through a
    // serial queue so recorder mutations stay one-at-a-time. Window scans are
    // intentionally isolated below because macOS Accessibility calls can block
    // for long periods and must not starve status/stop requests during a
    // recording.
    private let requestQueue = DispatchQueue(label: "yulu.audio-daemon.ipc.read", attributes: .concurrent)
    private let ipcQueue = DispatchQueue(label: "yulu.audio-daemon.ipc.control")
    private let windowScanQueue = DispatchQueue(label: "yulu.audio-daemon.window-scan")
    private let windowScanLock = NSLock()
    private var windowScanInFlight = false

    // Cap individual request payloads so a runaway/malicious client cannot
    // grow the read buffer without bound. Real requests are <200 bytes.
    private let maxRequestBytes = 64 * 1024

    init(_ r: AudioRecorder) { recorder = r }

    func stop() {
        if sock >= 0 { close(sock); sock = -1 }
        if ownsSocketPath {
            try? FileManager.default.removeItem(at: SOCKET_PATH)
            ownsSocketPath = false
        }
        if singletonLockFD >= 0 {
            close(singletonLockFD)
            singletonLockFD = -1
        }
    }

    func start() -> Bool {
        guard let lockFD = acquireExclusiveFileLock(at: SOCKET_LOCK_PATH) else {
            log("Socket: another audio daemon holds the process lock")
            return false
        }
        singletonLockFD = lockFD
        if unixSocketIsReachable(at: SOCKET_PATH) {
            log("Socket: another audio daemon is already active")
            stop()
            return false
        }
        try? FileManager.default.removeItem(at: SOCKET_PATH)
        sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else { log("Socket: create failed"); stop(); return false }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = SOCKET_PATH.path.withCString { strncpy(&addr.sun_path.0, $0, min(SOCKET_PATH.path.utf8.count, 103)) }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard ok == 0 else { log("Socket: bind failed errno=\(errno)"); stop(); return false }
        ownsSocketPath = true
        // status_agent polls at 1Hz, voicemail.cli polls during recording, and
        // shell scripts ping ad-hoc — a backlog of 5 is trivial to overrun if
        // any handler stalls. 64 absorbs realistic bursts without queueing.
        guard Darwin.listen(sock, 64) == 0 else {
            log("Socket: listen failed errno=\(errno)")
            stop()
            return false
        }
        chmod(SOCKET_PATH.path, 0o600)
        log("Socket ready")
        DispatchQueue.global(qos: .background).async { [weak self] in
            guard let self = self else { return }
            while self.sock >= 0 {
                let c = Darwin.accept(self.sock, nil, nil)
                if c >= 0 {
                    self.prepareClient(c)
                    self.requestQueue.async { [weak self] in
                        guard let self = self else { close(c); return }
                        self.dispatchClient(c)
                    }
                } else if errno == EINTR {
                    continue
                } else {
                    log("Socket: accept failed errno=\(errno)")
                    usleep(200_000)
                }
            }
        }
        return true
    }

    /// Per-accepted-fd hardening:
    ///   * SO_RCVTIMEO / SO_SNDTIMEO bound each read/write so a half-dead
    ///     client cannot tie up the IPC queue indefinitely.
    ///   * SO_NOSIGPIPE keeps `write` to a peer that already disconnected
    ///     from raising SIGPIPE and killing the daemon — the documented
    ///     hazard around the `start` action's late hook callback.
    private func prepareClient(_ c: Int32) {
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        _ = setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(c, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var on: Int32 = 1
        _ = setsockopt(c, SOL_SOCKET, SO_NOSIGPIPE, &on, socklen_t(MemoryLayout<Int32>.size))
    }

    private func dispatchClient(_ c: Int32) {
        guard let request = readRequest(c) else {
            close(c)
            return
        }
        if request.action == "windows" {
            handleWindows(c)
            return
        }
        ipcQueue.async { [weak self] in
            defer { close(c) }
            self?.handleParsed(c, action: request.action, json: request.json)
        }
    }

    private func readRequest(_ c: Int32) -> (action: String, json: [String: Any])? {
        // Framing: every in-tree client (Python record_audio /
        // meeting_daemon / voicemail.recorder, Swift status_agent's
        // DaemonClient since #20) writes the request then `shutdown(SHUT_WR)`
        // — read-until-EOF works for everyone. SO_RCVTIMEO (set in
        // prepareClient) bounds the wait at 5s for a misbehaving client.
        //
        // A newline-framing alternative was attempted in an earlier
        // revision of this commit but proved unreliable in practice
        // (`buf.prefix(n).contains(0x0A)` didn't break the loop against
        // the live socket — likely a `&buf` → C `read()` storage-sync
        // issue worth a dedicated debugging pass) and is no longer
        // needed now that the Swift client matches the Python framing.
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while data.count < maxRequestBytes {
            let n = read(c, &buf, buf.count)
            if n <= 0 { break }
            data.append(buf, count: n)
        }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = json["action"] as? String else { send(c, ["error":"invalid"]); return nil }
        return (action: action, json: json)
    }

    private func handleWindows(_ c: Int32) {
        windowScanLock.lock()
        if windowScanInFlight {
            windowScanLock.unlock()
            send(c, ["windows": [], "busy": true, "warning": "window_scan_busy"])
            close(c)
            return
        }
        windowScanInFlight = true
        windowScanLock.unlock()

        windowScanQueue.async { [weak self] in
            guard let self = self else { close(c); return }
            defer {
                self.finishWindowScan()
                close(c)
            }
            self.send(c, self.scanWindows())
        }
    }

    private func finishWindowScan() {
        windowScanLock.lock()
        windowScanInFlight = false
        windowScanLock.unlock()
    }

    private func handleParsed(_ c: Int32, action: String, json: [String: Any]) {
        var resp: [String: Any]
        switch action {
        case "start":
            let startGate = acquireRecordingStartGate()
            guard startGate.state == .available else {
                resp = [
                    "error": startGate.state == .busy
                        ? "application_transaction_in_progress"
                        : "application_transaction_lock_unsafe"
                ]
                send(c, resp)
                return
            }
            defer { startGate.release() }
            // Reset SYS_DISABLED per-request so each "start" reflects the caller's intent
            // cleanly (a sys-disabled recording followed by a normal one must NOT inherit
            // the previous flag).
            SYS_DISABLED = (json["sys_disabled"] as? Bool) ?? false
            // Per-request silence threshold: voicemail uses ~3s, meetings use the default.
            // Omitting the field MUST reset to DEFAULT_SILENCE_SEC so a previous short
            // threshold does not leak into the next recording.
            let silenceSeconds: TimeInterval
            if let s = json["silence_seconds"] as? Int, s > 0 {
                silenceSeconds = Double(s)
            } else if let s = json["silence_seconds"] as? Double, s > 0 {
                silenceSeconds = s
            } else {
                silenceSeconds = DEFAULT_SILENCE_SEC
            }
            let silenceThreshold: Float
            if let t = json["silence_threshold"] as? NSNumber {
                let value = t.floatValue
                silenceThreshold = (value >= 0 && value <= 1) ? value : DEFAULT_SILENCE_THRESHOLD
            } else {
                silenceThreshold = DEFAULT_SILENCE_THRESHOLD
            }
            if let uid = json["mic_device"] as? String {
                let trimmed = uid.trimmingCharacters(in: .whitespacesAndNewlines)
                configureMicDevice?(trimmed.isEmpty ? nil : trimmed)
            } else {
                configureMicDevice?(nil)
            }
            // Per-request output directory: voicemails land in ~/yulu/voicemails,
            // meetings use the default RECORDING_DIR. Omitting the field resets
            // to RECORDING_DIR so a previous voicemail does not leak into the
            // next meeting recording.
            let outputDir: URL
            if let dir = json["output_dir"] as? String, !dir.isEmpty {
                guard let safeOutputDir = safeRecordingSubdirectory(dir) else {
                    resp = ["error":"unsafe_output_dir"]
                    send(c, resp)
                    return
                }
                outputDir = safeOutputDir
            } else {
                outputDir = RECORDING_DIR
            }
            recorder.configure(silenceSeconds: silenceSeconds, silenceThreshold: silenceThreshold, outputDir: outputDir)
            // Start the OS capture sources before creating the WAV/replying. The
            // previous deferred-start design returned "recording" while ProcessTap
            // and AVAudioEngine were still starting, so the first seconds after
            // a user pressed record could be missing from the file.
            onRecordingStart?()
            if !SYS_READY && !SYS_DISABLED {
                onRecordingStop?()
                resp = ["error":"sys_capture_not_ready", "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR]
            } else if !MIC_READY {
                onRecordingStop?()
                resp = ["error":"mic_capture_not_ready", "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR]
            } else if let p = recorder.start(title: json["title"] as? String ?? "meeting") {
                resp = ["status":"recording", "file":p]
            }
            else {
                onRecordingStop?()
                resp = ["error":"start_failed"]
            }
        case "stop":
            let wasRecording = recorder.isRecording
            let (p, d) = recorder.stop()
            // Only tear down capture if we actually started it. A spurious "stop"
            // (e.g. client retry after a start_failed) would otherwise log a fake
            // "Sys capture idle" / "Mic idle" while neither was running.
            if wasRecording { onRecordingStop?() }
            resp = ["status":"stopped", "file": p ?? "", "duration": d]
        case "status":
            resp = ["recording": recorder.isRecording, "file": recorder.currentFilePath, "micLevel": recorder.micLevel, "sysReady": SYS_READY, "sysError": SYS_ERROR, "micReady": MIC_READY, "micError": MIC_ERROR, "meetingMicState": recorder.meetingMicState.rawValue, "serviceOwner": SERVICE_OWNER, "pid": ProcessInfo.processInfo.processIdentifier, "productVersion": PRODUCT_VERSION, "bundleVersion": BUNDLE_VERSION, "captureIPCVersion": CAPTURE_IPC_VERSION]
        case "audio_devices":
            resp = listAudioDevices?() ?? ["error": "coreaudio_device_provider_unavailable"]
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
    var audioCapture: CaptureBackend?   // D-02 seam: SCK arm now, tap arm (02-04) drops in here
    var meetingMuteMonitor: MeetingMuteMonitor?
    var socketServer: SocketServer?

    func applicationDidFinishLaunching(_ n: Notification) {
        for directory in [DURABLE_DATA_DIR, IPC_DIR, LOGS_DIR, RECORDING_DIR] {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        }
        if !FileManager.default.fileExists(atPath: LOG_PATH.path) {
            FileManager.default.createFile(atPath: LOG_PATH.path, contents: nil)
        }
        logFile = try? FileHandle(forWritingTo: LOG_PATH)
        _ = try? logFile?.seekToEnd()
        log("🎧 Audio Daemon (pid=\(ProcessInfo.processInfo.processIdentifier))")

        let rec = AudioRecorder(); recorder = rec
        let muteMonitor = MeetingMuteMonitor(recorder: rec); meetingMuteMonitor = muteMonitor
        rec.onStopRequest = { [weak self] in
            guard let self = self else { return }
            if !SYS_DISABLED && launchMeetingSilencePrompt() {
                return
            }
            let wasRecording = self.recorder?.isRecording ?? false
            _ = self.recorder?.stop()
            if wasRecording {
                self.meetingMuteMonitor?.stop()
                self.audioCapture?.stopCapture()
                self.micCapture?.stop()
            }
        }

        // Probe TCC permissions on launch (each probe opens its underlying capture
        // briefly, then tears it down) so SYS_READY / MIC_READY are accurate without
        // leaving the macOS menu-bar "recording" indicator on while the daemon is idle.
        if #available(macOS 12.3, *) {
            // ── Capture-backend arm selection (PLAT-02 / D-01 / D-03) ──────
            // On macOS 14.4+ use the Core Audio process tap (ProcessTapBackend):
            // it requests the narrower "System Audio Recording Only" TCC scope,
            // so 14.4+ users escape the recurring ScreenCaptureKit re-permission
            // nag (success criterion 3). On 13–14.3 fall back to the
            // ScreenCaptureKit arm. The macOS FLOOR stays 13+ — 14.4 gates ONLY
            // the new tap arm, it does NOT raise the minimum OS (D-01). Do NOT
            // lower this gate to 14.2: the tap symbols exist at 14.2 but the
            // runtime is only reliable at 14.4 (02-RESEARCH.md:459-462).
            let ac: CaptureBackend
            if #available(macOS 14.4, *) {
                ac = ProcessTapBackend(recorder: rec)
            } else {
                ac = ScreenCaptureKitBackend(recorder: rec)
            }
            audioCapture = ac
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
            if !SYS_DISABLED { self?.meetingMuteMonitor?.start() }
        }
        // Pre-gate sys re-arm (self-heal): refresh SYS_READY/SYS_ERROR with a real
        // arm attempt before the "start" readiness gate, so a stale false left by a
        // prior voicemail can't suppress a meeting recording. Idempotent with the
        // sys start in onRecordingStart above.
        ss.rearmSysCapture = { [weak self] in
            self?.audioCapture?.startCapture()
        }
        ss.configureMicDevice = { [weak self] uid in
            self?.micCapture?.selectedDeviceUID = uid
        }
        ss.listAudioDevices = { MicCapture.availableDevices() }
        ss.onRecordingStop = { [weak self] in
            self?.meetingMuteMonitor?.stop()
            self?.audioCapture?.stopCapture()
            self?.micCapture?.stop()
        }
        guard ss.start() else {
            log("Another audio daemon owns the socket; exiting")
            NSApp.terminate(nil)
            return
        }
        try? "\(ProcessInfo.processInfo.processIdentifier)".write(to: PID_PATH, atomically: true, encoding: .utf8)
        if let title = interruptedRecordingTitle() {
            let startGate = acquireRecordingStartGate()
            if startGate.state == .available, let p = rec.start(title: title) {
                log("⚠️ Resuming interrupted recording: \(p)")
                ss.onRecordingStart?()
            } else if startGate.state != .available {
                log("Interrupted recording resume deferred by application transaction")
            }
            startGate.release()
        }
        log("Ready")
    }

    func applicationWillTerminate(_ n: Notification) {
        let ownedSocket = socketServer?.ownsSocketPath ?? false
        recorder?.stop(); socketServer?.stop(); meetingMuteMonitor?.stop(); audioCapture?.stopCapture(); micCapture?.stop()
        if ownedSocket { try? FileManager.default.removeItem(at: PID_PATH) }
        try? logFile?.close()
    }
}

// ─── 入口 ──────────────────────────────────────────────

if CommandLine.arguments.count == 3,
   CommandLine.arguments[1] == "--inspect-recording-start-gate" {
    let gate = acquireRecordingStartGate(
        cacheRoot: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
    )
    let state = gate.state.rawValue
    gate.release()
    let encoded = try! JSONSerialization.data(
        withJSONObject: ["state": state],
        options: [.sortedKeys]
    )
    FileHandle.standardOutput.write(encoded + Data("\n".utf8))
    exit(0)
}

if CommandLine.arguments.contains("--path-contract-self-test") {
    let manager = FileManager.default
    let testParent = manager.fileExists(atPath: "/private/tmp")
        ? URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        : manager.temporaryDirectory.resolvingSymlinksInPath()
    let testRoot = testParent
        .appendingPathComponent("yulu-audio-path-contract-\(UUID().uuidString)", isDirectory: true)
    let approved = testRoot.appendingPathComponent("approved", isDirectory: true)
    let movedApproved = testRoot.appendingPathComponent("moved-approved", isDirectory: true)
    let external = testRoot.appendingPathComponent("external", isDirectory: true)
    try! manager.createDirectory(at: approved, withIntermediateDirectories: true)
    try! manager.createDirectory(at: external, withIntermediateDirectories: true)
    let cachedApprovedPath = canonicalDirectory(approved.path)!
    guard let initialAnchor = AnchoredRecordingDirectory(
        root: cachedApprovedPath,
        target: cachedApprovedPath
    ), let initialWriter = WavWriter(directory: initialAnchor, filename: "initial.wav") else {
        fputs("path-contract self-test could not anchor approved root: \(cachedApprovedPath.path)\n", stderr)
        try? manager.removeItem(at: testRoot)
        exit(1)
    }
    initialWriter.finalize()
    try! manager.moveItem(at: approved, to: movedApproved)
    try! manager.createSymbolicLink(at: approved, withDestinationURL: external)

    if let redirected = AnchoredRecordingDirectory(
        root: cachedApprovedPath,
        target: cachedApprovedPath
    ) {
        _ = WavWriter(directory: redirected, filename: "redirected.wav")
    }
    if manager.fileExists(atPath: external.appendingPathComponent("redirected.wav").path) {
        fputs("root swap unexpectedly created external audio\n", stderr)
        try? manager.removeItem(at: testRoot)
        exit(1)
    }
    try? manager.removeItem(at: testRoot)
    print("path-contract-self-test passed")
    exit(0)
}

if CommandLine.arguments.contains("--self-test") {
    let socketTestRoot = FileManager.default.fileExists(atPath: "/private/tmp")
        ? URL(fileURLWithPath: "/private/tmp", isDirectory: true)
        : FileManager.default.temporaryDirectory
    let socketTestDirectory = socketTestRoot
        .appendingPathComponent("yulu-audio-daemon-\(UUID().uuidString)")
    try! FileManager.default.createDirectory(at: socketTestDirectory, withIntermediateDirectories: true)
    let socketTestPath = socketTestDirectory.appendingPathComponent("daemon.sock")
    let socketTestFD = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    assert(socketTestFD >= 0)
    var socketTestAddress = sockaddr_un()
    socketTestAddress.sun_family = sa_family_t(AF_UNIX)
    _ = socketTestPath.path.withCString {
        strncpy(&socketTestAddress.sun_path.0, $0, min(socketTestPath.path.utf8.count, 103))
    }
    let socketTestBind = withUnsafePointer(to: &socketTestAddress) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.bind(socketTestFD, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    assert(socketTestBind == 0)
    assert(Darwin.listen(socketTestFD, 1) == 0)
    assert(unixSocketIsReachable(at: socketTestPath))
    assert(FileManager.default.fileExists(atPath: socketTestPath.path))
    close(socketTestFD)

    let lockTestPath = socketTestDirectory.appendingPathComponent("daemon.lock")
    let firstLockFD = acquireExclusiveFileLock(at: lockTestPath)
    assert(firstLockFD != nil)
    assert(acquireExclusiveFileLock(at: lockTestPath) == nil)
    close(firstLockFD!)
    let secondLockFD = acquireExclusiveFileLock(at: lockTestPath)
    assert(secondLockFD != nil)
    close(secondLockFD!)
    try? FileManager.default.removeItem(at: socketTestDirectory)

    assert(MeetingMuteClassifier.classifyControlLabel("Unmute My Audio") == .muted)
    assert(MeetingMuteClassifier.classifyControlLabel("开启麦克风 (⌘D)") == .muted)
    assert(MeetingMuteClassifier.classifyControlLabel("Mute") == .unmuted)
    assert(MeetingMuteClassifier.classifyControlLabel("关闭麦克风 (⌘D)") == .unmuted)
    assert(MeetingMuteClassifier.classifyControlLabel("Ask to Unmute") == nil)
    assert(MeetingMuteClassifier.isSupportedMeetingWindow(
        appName: "Google Chrome",
        bundleID: "com.google.Chrome",
        title: "Meet - abc-defg-hij"
    ))
    assert(!MeetingMuteClassifier.isSupportedMeetingWindow(
        appName: "Google Chrome",
        bundleID: "com.google.Chrome",
        title: "Gmail"
    ))
    assert(micSamplesForRecording([0.5], gain: 1, meetingState: .muted) == [0])
    assert(micSamplesForRecording([0.5], gain: 1, meetingState: .unknown)[0] > 0)

    var recovery = ZeroBufferRecoveryPolicy(threshold: 3, maxAttempts: 2)
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(recovery.observe(allZero: true, running: true, rebuilding: false))
    recovery.commitRecoveryAttempt()
    let firstEpisode = recovery.episode
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: false, running: true, rebuilding: false))
    assert(recovery.episode != firstEpisode)
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(recovery.observe(allZero: true, running: true, rebuilding: false))
    recovery.commitRecoveryAttempt()
    assert(!recovery.observe(allZero: false, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    recovery.resetForRecording()
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(!recovery.observe(allZero: true, running: true, rebuilding: false))
    assert(recovery.observe(allZero: true, running: true, rebuilding: false))

    let recorder = AudioRecorder()
    recorder._selfTestSetSilenceState(
        recording: true,
        micLast: Date(timeIntervalSinceNow: -2),
        sysLast: Date(timeIntervalSinceNow: -2),
        silenceSeconds: 1
    )
    assert(recorder.silenceExpired())
    recorder._selfTestSetSilenceState(
        recording: true,
        micLast: Date(),
        sysLast: Date(timeIntervalSinceNow: -2),
        silenceSeconds: 1
    )
    assert(!recorder.silenceExpired())
    print("audio_daemon self-test ok")
    exit(0)
}

let app = NSApplication.shared
Darwin.signal(SIGPIPE, SIG_IGN)
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
