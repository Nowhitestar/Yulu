// Yulu Status Agent — menu-bar item + recording indicator.
//
// Built as a Cocoa app with LSUIElement=true so it lives only in the menu
// bar (no Dock icon, no main window). The "Start Recording" menu item shells
// out to `yulu record start` (mic + system audio); this binary is a button
// plus a live recording-state indicator polled off the audio daemon.

import Cocoa
import Carbon
import ApplicationServices
import WebKit

private var embeddedEnvironment: [String: String]?
private var nativeEnvironment: [String: String] {
    embeddedEnvironment ?? ProcessInfo.processInfo.environment
}
let HOME_DIR = nativeEnvironment["HOME"] ?? FileManager.default.homeDirectoryForCurrentUser.path

/// The visible Application owns native interaction after service migration.
/// The same implementation remains usable by the legacy standalone entry point.
public final class NativeRecordingControls {
    private let controller: StatusAgentApp
    private let reminders: NativeReminderServices
    private var prepared = false
    private var active = false

    public init(environment: [String: String], openRoute: @escaping (String) -> Void) {
        embeddedEnvironment = environment
        controller = StatusAgentApp()
        reminders = NativeReminderServices(environment: environment)
        controller.openRoute = openRoute
        YuluNotificationPresenter.shared.configure(openRoute: openRoute)
        YuluNotificationPresenter.shared.setLanguage { readAppLanguage() == .en }
    }

    /// Reserve and validate IPC for update health without enabling native input.
    public func prepare() throws {
        if !prepared {
            _ = nativeWork.quiesce()
            try controller.prepareNativeControls()
            prepared = true
        }
        guard isReady else {
            throw NSError(domain: "YuluNativeRecording", code: Int(EADDRINUSE), userInfo: [
                NSLocalizedDescriptionKey: "Native recording controls do not own a ready endpoint."
            ])
        }
    }

    public var isReady: Bool { prepared && controller.ipcServer?.ownsEndpoint == true }

    public func activate() throws {
        try prepare()
        guard !active else { nativeWork.resume(); reminders.resume(); return }
        nativeWork.resume()
        try controller.startNativeControls()
        active = true
        reminders.resume()
    }

    /// Same fail-closed recording observation consumed by Application Update.
    public func quiesce(captureRecording: Bool?) -> Bool? {
        guard captureRecording == false else { return captureRecording }
        let remindersStopped = reminders.quiesce()
        return !nativeWork.quiesce() || !remindersStopped
    }

    public func stop() {
        guard prepared else { return }
        controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
        _ = reminders.quiesce()
        active = false
        prepared = false
    }
}

/// Own the reminder supervisor alongside native controls, after migration only.
/// It uses bundled Python and drains its process groups before an update.
private final class NativeReminderServices {
    private let environment: [String: String]
    private let queue = DispatchQueue(label: "com.yulu.reminder-lifecycle")
    private var process: Process?
    private var timer: DispatchSourceTimer?
    private var accepting = false

    init(environment: [String: String]) { self.environment = environment }

    func resume() {
        guard environment["YULU_MANAGE_REMINDERS"] == "1" else { return }
        queue.sync {
            accepting = true
            launchIfNeeded()
            guard timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now() + 5, repeating: 5)
            timer.setEventHandler { [weak self] in self?.launchIfNeeded() }
            self.timer = timer
            timer.resume()
        }
    }

    func quiesce() -> Bool {
        queue.sync {
            accepting = false
            timer?.cancel()
            timer = nil
            guard let process, process.isRunning else { self.process = nil; return true }
            process.terminate()
            return false
        }
    }

    private func launchIfNeeded() {
        guard accepting, process?.isRunning != true,
              let python = environment["YULU_PYTHON"],
              let scripts = environment["YULU_SCRIPT_DIR"] else { return }
        let child = Process()
        child.executableURL = URL(fileURLWithPath: python)
        child.arguments = ["\(scripts)/reminder_services.py"]
        child.currentDirectoryURL = URL(fileURLWithPath: scripts)
        child.environment = environment
        child.standardInput = FileHandle.nullDevice
        do {
            try child.run()
            process = child
        } catch {
            log("Meeting reminder supervisor could not start: \(error.localizedDescription)")
        }
    }
}

private final class NativeWork {
    final class Admission {
        private let onCompletion: () -> Void

        init(onCompletion: @escaping () -> Void) { self.onCompletion = onCompletion }
        deinit { onCompletion() }
    }

    private let lock = NSLock()
    private var processes: [Process] = []
    private var admittedCommands = 0
    private var accepting = true

    var isAccepting: Bool {
        lock.lock()
        defer { lock.unlock() }
        return accepting
    }

    func resume() {
        lock.lock()
        defer { lock.unlock() }
        accepting = true
    }

    func quiesce() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        processes.removeAll { !$0.isRunning }
        guard processes.isEmpty, admittedCommands == 0 else { return false }
        accepting = false
        return true
    }

    func admit() -> Admission? {
        lock.lock()
        defer { lock.unlock() }
        guard accepting else { return nil }
        admittedCommands += 1
        return Admission { [self] in
            lock.lock()
            admittedCommands -= 1
            lock.unlock()
        }
    }

    func run(_ process: Process) throws {
        guard let admission = admit() else {
            throw NSError(domain: "YuluNativeRecording", code: Int(EBUSY), userInfo: [
                NSLocalizedDescriptionKey: "Native recording controls are quiescing for an update."
            ])
        }
        // Process creation may block. Keep it admitted for quiescence without
        // holding the lock that the main-thread hotkey handler reads.
        defer { withExtendedLifetime(admission) {} }
        try process.run()
        lock.lock()
        defer { lock.unlock() }
        processes.removeAll { !$0.isRunning }
        processes.append(process)
    }

    /// Called off the main thread before canceling Capture. Drain only owned
    /// voice helpers so a late startup cannot race the following cancellation.
    func terminateVoiceProcesses(_ pids: Set<Int32>) -> Bool {
        lock.lock()
        let owned = processes.filter { $0.isRunning && pids.contains($0.processIdentifier) }
        lock.unlock()
        owned.forEach { if $0.isRunning { $0.terminate() } }
        let deadline = Date().addingTimeInterval(2)
        while owned.contains(where: { $0.isRunning }) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.01)
        }
        return !owned.contains(where: { $0.isRunning })
    }
}

private let nativeWork = NativeWork()

func canonicalDirectory(_ raw: String) -> URL? {
    let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !value.isEmpty, !value.contains("\0") else { return nil }
    let path = value.hasPrefix("~/")
        ? (value as NSString).expandingTildeInPath
        : value
    guard path.hasPrefix("/") else { return nil }
    let manager = FileManager.default
    var existing = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
    var missing: [String] = []
    while true {
        var isDirectory: ObjCBool = false
        if manager.fileExists(atPath: existing.path, isDirectory: &isDirectory) {
            guard isDirectory.boolValue else { return nil }
            var resolved = existing.resolvingSymlinksInPath().standardizedFileURL
            for component in missing {
                resolved.appendPathComponent(component, isDirectory: true)
            }
            return resolved.standardizedFileURL
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

func environmentDirectory(_ name: String, fallback: String) -> String {
    guard let raw = nativeEnvironment[name],
          raw.hasPrefix("/"),
          !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return fallback
    }
    return (raw as NSString).standardizingPath
}

let DURABLE_DATA_DIR = environmentDirectory(
    "YULU_APPLICATION_SUPPORT_DIR",
    fallback: "\(HOME_DIR)/Library/Application Support/Yulu"
)
let IPC_DIR = environmentDirectory(
    "YULU_IPC_DIR",
    fallback: "\(HOME_DIR)/Library/Caches/Yulu"
)
let LOGS_DIR = environmentDirectory(
    "YULU_LOG_DIR",
    fallback: "\(HOME_DIR)/Library/Logs/Yulu"
)
let LEGACY_READ_ONLY_DATA_DIR = environmentDirectory(
    "YULU_LEGACY_READ_ONLY_DATA_DIR",
    fallback: "\(HOME_DIR)/.config/yulu"
)
let CONFIG_DIR = DURABLE_DATA_DIR
let CONFIG_READ_PATHS = [
    "\(DURABLE_DATA_DIR)/config.json",
    "\(LEGACY_READ_ONLY_DATA_DIR)/config.json",
]
let PID_FILE = "\(IPC_DIR)/status_agent.pid"
let LOG_FILE = "\(LOGS_DIR)/status_agent.log"
let IPC_SOCKET_PATH = "\(IPC_DIR)/status_agent.sock"
let DICTATION_MEDIA_DIR = "\(loadRecordingDir())/Dictation"

func firstReadableData(_ relativePath: String) -> Data? {
    for root in [DURABLE_DATA_DIR, LEGACY_READ_ONLY_DATA_DIR] {
        if let data = FileManager.default.contents(atPath: "\(root)/\(relativePath)") {
            return data
        }
    }
    return nil
}

func configData() -> Data? {
    for path in CONFIG_READ_PATHS {
        if let data = FileManager.default.contents(atPath: path) { return data }
    }
    return nil
}

enum AppLanguage: String {
    case zh, en
}

var activeAppLanguage: AppLanguage = .zh

func readAppLanguage() -> AppLanguage {
    guard let data = configData(),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ui = json["ui"] as? [String: Any],
          let raw = ui["language"] as? String,
          let language = AppLanguage(rawValue: raw) else { return .zh }
    return language
}

func L(_ zh: String, _ en: String) -> String {
    activeAppLanguage == .zh ? zh : en
}

func appLocale() -> Locale {
    Locale(identifier: activeAppLanguage == .zh ? "zh_CN" : "en_US")
}

func targetLanguageDisplayName(_ value: String) -> String {
    switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
    case "english", "en": return L("英语", "English")
    case "japanese", "ja", "日本語": return L("日语", "Japanese")
    case "korean", "ko", "한국어": return L("韩语", "Korean")
    case "french", "fr", "français": return L("法语", "French")
    case "spanish", "es", "español": return L("西班牙语", "Spanish")
    case "german", "de", "deutsch": return L("德语", "German")
    case "traditional chinese", "zh-hant", "繁體中文": return L("繁体中文", "Traditional Chinese")
    default: return value.isEmpty ? L("英语", "English") : value
    }
}

func statusAgentScriptDir() -> String {
    nativeEnvironment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
}

func yuluPythonProcess(scriptDir: String) -> Process {
    let task = Process()
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    let python = embeddedEnvironment != nil
        ? (nativeEnvironment["YULU_PYTHON"] ?? "/missing-bundled-python")
        : (candidates.first(where: FileManager.default.isExecutableFile(atPath:)) ?? "/usr/bin/python3")
    task.executableURL = URL(fileURLWithPath: python)
    task.currentDirectoryURL = URL(fileURLWithPath: scriptDir)
    var env = nativeEnvironment
    let existing = env["PYTHONPATH"] ?? ""
    env["PYTHONPATH"] = embeddedEnvironment != nil || existing.isEmpty ? scriptDir : "\(scriptDir):\(existing)"
    if embeddedEnvironment != nil { env["PYTHONDONTWRITEBYTECODE"] = "1" }
    task.environment = env
    return task
}

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    // FileManager.createFile(atPath:contents:) TRUNCATES if the file
    // exists — earlier code called it on every log() and lost all prior
    // lines except the most recent. Guard with fileExists so we only
    // create when missing, then append.
    if !FileManager.default.fileExists(atPath: LOG_FILE) {
        FileManager.default.createFile(atPath: LOG_FILE, contents: nil)
    }
    if let fh = FileHandle(forWritingAtPath: LOG_FILE) {
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: Data(line.utf8))
    }
}

func writePidFile() {
    let pid = ProcessInfo.processInfo.processIdentifier
    try? "\(pid)".write(toFile: PID_FILE, atomically: true, encoding: .utf8)
}

func feedbackSoundsEnabled() -> Bool {
    guard let data = configData(),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let block = json["status_agent"] as? [String: Any] else { return true }
    return block["feedback_sounds"] as? Bool ?? true
}

func normalizedMicLevel(_ rms: Double) -> CGFloat {
    guard rms > 0 else { return 0 }
    let decibels = 20 * log10(rms)
    return CGFloat(min(1, max(0, (decibels + 55) / 40)))
}

func parseDictationOutput(_ data: Data) -> [String: Any]? {
    guard !data.isEmpty else { return nil }
    return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}

enum VoiceFeedbackSound {
    case start, success, failure
}

final class VoiceFeedbackPlayer {
    private var activeSound: NSSound?

    func play(_ kind: VoiceFeedbackSound) {
        guard feedbackSoundsEnabled(), let sound = NSSound(data: Self.wavData(for: kind)) else { return }
        activeSound?.stop()
        activeSound = sound
        sound.volume = 0.22
        sound.play()
    }

    private static func wavData(for kind: VoiceFeedbackSound) -> Data {
        let frequencies: [Double]
        let toneDuration: Double
        let gapDuration: Double
        switch kind {
        case .start:
            frequencies = [660, 880]; toneDuration = 0.035; gapDuration = 0
        case .success:
            frequencies = [880, 1175]; toneDuration = 0.035; gapDuration = 0
        case .failure:
            frequencies = [260, 220]; toneDuration = 0.055; gapDuration = 0.025
        }
        let sampleRate = 44_100
        let toneFrames = Int(Double(sampleRate) * toneDuration)
        let gapFrames = Int(Double(sampleRate) * gapDuration)
        let fadeFrames = max(1, Int(Double(sampleRate) * 0.006))
        var samples: [Int16] = []
        for (index, frequency) in frequencies.enumerated() {
            for frame in 0..<toneFrames {
                let fadeIn = min(1, Double(frame) / Double(fadeFrames))
                let fadeOut = min(1, Double(toneFrames - frame - 1) / Double(fadeFrames))
                let envelope = min(fadeIn, fadeOut)
                let value = sin(2 * Double.pi * frequency * Double(frame) / Double(sampleRate))
                samples.append(Int16(value * envelope * 0.16 * Double(Int16.max)))
            }
            if index < frequencies.count - 1 && gapFrames > 0 {
                samples.append(contentsOf: repeatElement(0, count: gapFrames))
            }
        }

        var pcm = Data(capacity: samples.count * 2)
        for sample in samples {
            var value = sample.littleEndian
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }
        var wav = Data()
        wav.append("RIFF".data(using: .ascii)!)
        wav.appendLittleEndian(UInt32(36 + pcm.count))
        wav.append("WAVEfmt ".data(using: .ascii)!)
        wav.appendLittleEndian(UInt32(16))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt16(1))
        wav.appendLittleEndian(UInt32(sampleRate))
        wav.appendLittleEndian(UInt32(sampleRate * 2))
        wav.appendLittleEndian(UInt16(2))
        wav.appendLittleEndian(UInt16(16))
        wav.append("data".data(using: .ascii)!)
        wav.appendLittleEndian(UInt32(pcm.count))
        wav.append(pcm)
        return wav
    }
}

private extension Data {
    mutating func appendLittleEndian<T: FixedWidthInteger>(_ value: T) {
        var encoded = value.littleEndian
        Swift.withUnsafeBytes(of: &encoded) { append(contentsOf: $0) }
    }
}

class MenuBuilder {
    static func build(target: AnyObject) -> NSMenu {
        let menu = NSMenu()

        let currentLabel = NSMenuItem(title: L("当前会议", "Current Meeting"), action: nil, keyEquivalent: "")
        currentLabel.identifier = NSUserInterfaceItemIdentifier("current_meeting_label")
        currentLabel.isEnabled = false
        currentLabel.isHidden = true
        menu.addItem(currentLabel)

        let currentRecord = NSMenuItem(
            title: L("录制此会议", "Record This Meeting"),
            action: #selector(StatusAgentApp.onCurrentMeetingRecord(_:)),
            keyEquivalent: ""
        )
        currentRecord.target = target
        currentRecord.identifier = NSUserInterfaceItemIdentifier("current_meeting_record")
        currentRecord.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: nil)
        currentRecord.isHidden = true
        menu.addItem(currentRecord)

        let currentJoin = NSMenuItem(
            title: L("录制并加入", "Record and Join"),
            action: #selector(StatusAgentApp.onCurrentMeetingRecordJoin(_:)),
            keyEquivalent: ""
        )
        currentJoin.target = target
        currentJoin.identifier = NSUserInterfaceItemIdentifier("current_meeting_join")
        currentJoin.image = NSImage(systemSymbolName: "arrow.up.right.circle", accessibilityDescription: nil)
        currentJoin.isHidden = true
        menu.addItem(currentJoin)

        let currentSep = NSMenuItem.separator()
        currentSep.identifier = NSUserInterfaceItemIdentifier("current_meeting_separator")
        currentSep.isHidden = true
        menu.addItem(currentSep)

        // The Start/Stop title is updated dynamically by StatusAgentApp;
        // here we just provide an action wire-up.
        let toggleItem = NSMenuItem(
            title: L("开始录制", "Start Recording"),
            action: #selector(StatusAgentApp.onMenuToggle),
            keyEquivalent: ""
        )
        toggleItem.target = target
        toggleItem.identifier = NSUserInterfaceItemIdentifier("toggle")
        toggleItem.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: nil)
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())

        let dictateItem = NSMenuItem(
            title: L("开始听写", "Start Dictation"),
            action: #selector(StatusAgentApp.onDictateToggle),
            keyEquivalent: ""
        )
        dictateItem.target = target
        dictateItem.identifier = NSUserInterfaceItemIdentifier("dictate_once")
        dictateItem.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: nil)
        menu.addItem(dictateItem)

        let translateItem = NSMenuItem(
            title: L("翻译为英语", "Translate to English"),
            action: #selector(StatusAgentApp.onDictateTranslateFromMenu),
            keyEquivalent: ""
        )
        translateItem.target = target
        translateItem.identifier = NSUserInterfaceItemIdentifier("dictate_translate")
        translateItem.image = NSImage(systemSymbolName: "character.bubble", accessibilityDescription: nil)
        menu.addItem(translateItem)

        let voiceChatItem = NSMenuItem(
            title: L("语音询问 Agent", "Ask Agent by Voice"),
            action: #selector(StatusAgentApp.onVoiceChat),
            keyEquivalent: ""
        )
        voiceChatItem.target = target
        voiceChatItem.identifier = NSUserInterfaceItemIdentifier("voice_chat")
        voiceChatItem.image = NSImage(systemSymbolName: "bubble.left.and.waveform", accessibilityDescription: nil)
        menu.addItem(voiceChatItem)
        menu.addItem(NSMenuItem.separator())

        let openInbox = NSMenuItem(
            title: L("打开 Yulu", "Open Yulu"),
            action: #selector(StatusAgentApp.onOpenInbox),
            keyEquivalent: ""
        )
        openInbox.target = target
        openInbox.image = NSImage(systemSymbolName: "tray", accessibilityDescription: nil)
        menu.addItem(openInbox)

        let openAgentConsole = NSMenuItem(
            title: L("打开 Agent Console", "Open Agent Console"),
            action: #selector(StatusAgentApp.onOpenAgentConsole),
            keyEquivalent: ""
        )
        openAgentConsole.target = target
        openAgentConsole.image = NSImage(systemSymbolName: "sparkles", accessibilityDescription: nil)
        menu.addItem(openAgentConsole)

        let recentItem = NSMenuItem(title: L("最近记录", "Recent Recordings"), action: nil, keyEquivalent: "")
        recentItem.identifier = NSUserInterfaceItemIdentifier("recent_recordings")
        recentItem.image = NSImage(systemSymbolName: "clock.arrow.circlepath", accessibilityDescription: nil)
        let recentMenu = NSMenu(title: L("最近记录", "Recent Recordings"))
        let recentEmpty = NSMenuItem(title: L("暂无最近记录", "No Recent Recordings"), action: nil, keyEquivalent: "")
        recentEmpty.identifier = NSUserInterfaceItemIdentifier("recent_empty")
        recentEmpty.isEnabled = false
        recentMenu.addItem(recentEmpty)
        for i in 0..<5 {
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.identifier = NSUserInterfaceItemIdentifier("recent_\(i)")
            item.isHidden = true
            recentMenu.addItem(item)
        }
        recentMenu.addItem(NSMenuItem.separator())
        let showAll = NSMenuItem(
            title: L("查看全部记录", "Show All Recordings"),
            action: #selector(StatusAgentApp.onOpenInbox),
            keyEquivalent: ""
        )
        showAll.target = target
        recentMenu.addItem(showAll)
        recentItem.submenu = recentMenu
        menu.addItem(recentItem)

        let settings = NSMenuItem(
            title: L("设置…", "Settings…"),
            action: #selector(StatusAgentApp.onOpenSettings),
            keyEquivalent: ","
        )
        settings.target = target
        settings.image = NSImage(systemSymbolName: "gearshape", accessibilityDescription: nil)
        menu.addItem(settings)
        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(
            title: L("退出 Yulu", "Quit Yulu"),
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quit)
        return menu
    }
}

struct RecentRecording {
    let stem: String
    let title: String
    let mtime: Date
}

struct CurrentMeeting {
    let id: String
    let title: String
    let link: String
    let start: Date
    let end: Date
}

struct CapturedPasteTarget {
    let bundleId: String
    let appName: String
    let element: AXUIElement
}

enum VoiceResultPresentation {
    case dismiss, unconfirmed, recovery
}

func voiceResultPresentation(pasted: Bool, dispatched: Bool, failed: Bool) -> VoiceResultPresentation {
    if failed { return .recovery }
    if pasted { return .dismiss }
    return dispatched ? .unconfirmed : .recovery
}

struct PasteTextSnapshot {
    let value: String?
    let selection: CFRange?

    func expectedValue(inserting text: String) -> String? {
        guard let value, let selection, selection.location >= 0, selection.length >= 0 else { return nil }
        let original = value as NSString
        guard selection.location <= original.length,
              selection.length <= original.length - selection.location else { return nil }
        return original.replacingCharacters(in: NSRange(location: selection.location, length: selection.length), with: text)
    }

    func confirmsInsertion(_ text: String, after: PasteTextSnapshot) -> Bool {
        guard !text.isEmpty, let previous = value, let current = after.value else { return false }
        if let expected = expectedValue(inserting: text), current == expected { return true }
        // Web editors can expose labels around their value or omit a selection
        // range. Require newly observed text, never a pre-existing occurrence.
        func normalized(_ value: String) -> String {
            value.precomposedStringWithCanonicalMapping
                .replacingOccurrences(of: "\r\n", with: "\n")
                .replacingOccurrences(of: "\u{00a0}", with: " ")
                .replacingOccurrences(of: "\u{200b}", with: "")
        }
        let needle = normalized(text)
        guard !needle.isEmpty else { return false }
        let beforeValue = normalized(previous), afterValue = normalized(current)
        return afterValue.components(separatedBy: needle).count > beforeValue.components(separatedBy: needle).count
    }
}

func parseScheduleDate(_ value: String) -> Date? {
    let iso = ISO8601DateFormatter()
    iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = iso.date(from: value) { return d }
    iso.formatOptions = [.withInternetDateTime]
    if let d = iso.date(from: value) { return d }

    let local = DateFormatter()
    local.locale = Locale(identifier: "en_US_POSIX")
    local.timeZone = TimeZone.current
    local.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
    return local.date(from: String(value.prefix(19)))
}

func loadCurrentMeeting() -> CurrentMeeting? {
    guard let data = firstReadableData("schedule.json"),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let meetings = raw["meetings"] as? [[String: Any]] else {
        return nil
    }
    let now = Date()
    var matches: [CurrentMeeting] = []
    for m in meetings {
        guard let id = m["id"] as? String,
              let title = m["title"] as? String,
              let startRaw = m["start"] as? String,
              let start = parseScheduleDate(startRaw) else { continue }
        let end: Date
        if let endRaw = m["end"] as? String, let parsedEnd = parseScheduleDate(endRaw) {
            end = parsedEnd
        } else {
            let duration = (m["duration_min"] as? NSNumber)?.doubleValue
                ?? Double(m["duration_min"] as? Int ?? 60)
            end = start.addingTimeInterval(duration * 60)
        }
        if start <= now && now <= end {
            matches.append(CurrentMeeting(
                id: id,
                title: title,
                link: (m["link"] as? String) ?? "",
                start: start,
                end: end
            ))
        }
    }
    return matches.sorted { $0.start > $1.start }.first
}

func shortMeetingTitle(_ title: String) -> String {
    if title.count <= 38 { return title }
    return "\(title.prefix(35))…"
}

func recentRecordingMenuTitle(time: String, name: String) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.tabStops = [NSTextTab(textAlignment: .left, location: 104)]
    return NSAttributedString(
        string: "\(time)\t\(name)",
        attributes: [
            .font: NSFont.menuFont(ofSize: 0),
            .paragraphStyle: paragraph,
        ]
    )
}

// Resolve the recordings base directory from config.json (D-07): read
// `audio.output_dir`, honor a leading `~/`, and fall back to the historical
// ~/Movies/Yulu default when the key is missing/empty or the file is unreadable.
// Ported from audio_daemon.swift:45-58 — kept on status_agent's
// NSString.expandingTildeInPath / NSHomeDirectory() idiom (line 10) for in-file
// consistency, rather than FileManager.homeDirectoryForCurrentUser.
func configuredRecordingDirectory(_ raw: String) -> String? {
    safeMediaDirectory(raw)?.path
}

func safeMediaDirectory(_ raw: String) -> URL? {
    guard let candidate = canonicalDirectory(raw) else { return nil }
    for root in [DURABLE_DATA_DIR, IPC_DIR, LOGS_DIR, LEGACY_READ_ONLY_DATA_DIR] {
        guard let canonicalRoot = canonicalDirectory(root) else { return nil }
        if pathsOverlap(candidate, canonicalRoot) { return nil }
    }
    return candidate
}

func loadRecordingDir() -> String {
    if let raw = nativeEnvironment["YULU_MEDIA_LIBRARY_DIR"],
       let configured = safeMediaDirectory(raw) {
        return configured.path
    }
    for configPath in CONFIG_READ_PATHS {
        guard let data = FileManager.default.contents(atPath: configPath),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let audio = json["audio"] as? [String: Any],
              let raw = audio["output_dir"] as? String,
              let configured = configuredRecordingDirectory(raw) else {
            continue
        }
        return configured
    }
    let fallback = "\(HOME_DIR)/Movies/Yulu"
    guard let safeFallback = safeMediaDirectory(fallback) else {
        fatalError("no safe Yulu Media Library path")
    }
    return safeFallback.path
}

func activeDictationIntent() -> String {
    guard let data = firstReadableData("dictation/state.json"),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return ""
    }
    return (json["intent"] as? String) ?? ""
}

func dictationTargetLanguage(fallback: String) -> String {
    guard let data = configData(),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let transcription = json["transcription"] as? [String: Any],
          let dictation = transcription["dictation"] as? [String: Any],
          let raw = dictation["target_language"] as? String,
          !raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
        return fallback.isEmpty ? "English" : fallback
    }
    return raw.trimmingCharacters(in: .whitespacesAndNewlines)
}

struct HotkeySpec {
    let action: String
    let keyCode: UInt32
    let modifierMask: UInt32
    let label: String
    let targetLanguage: String
    var inputMode: String = "toggle"
    var key: String = ""
    var modifiers: [String] = []
    var usesModifierMonitor: Bool {
        ModifierShortcutState.keyModifiers[key] != nil || modifiers.contains("fn") || modifiers.contains { $0.contains("_") }
    }
}

/// Matches physical modifier sides without consuming unrelated Command shortcuts.
/// Modifier-only taps resolve on release, so Fn+Space can never also toggle Fn.
struct ModifierShortcutState {
    static let keyModifiers: [String: String] = [
        "Fn": "fn", "Command": "cmd", "Shift": "shift", "Option": "alt", "Control": "ctrl",
        "LeftCommand": "left_cmd", "RightCommand": "right_cmd",
        "LeftShift": "left_shift", "RightShift": "right_shift",
        "LeftOption": "left_alt", "RightOption": "right_alt",
        "LeftControl": "left_ctrl", "RightControl": "right_ctrl",
    ]
    // Device masks are defined by IOKit/hidsystem/IOLLEvent.h.
    static let masks: [String: UInt64] = [
        "cmd": 0x100000, "shift": 0x20000, "alt": 0x80000, "ctrl": 0x40000, "fn": 0x800000,
        "left_cmd": 0x8, "right_cmd": 0x10, "left_shift": 0x2, "right_shift": 0x4,
        "left_alt": 0x20, "right_alt": 0x40, "left_ctrl": 0x1, "right_ctrl": 0x2000,
    ]
    static let relevantMask = masks.values.reduce(UInt64(0), |)
    static let groupMask: UInt64 = 0x1e0000 | 0x800000
    static func group(_ token: String) -> String { String(token.split(separator: "_").last ?? "") }
    static func matches(_ spec: HotkeySpec, flags: UInt64) -> Bool {
        let tokens = spec.modifiers + (keyModifiers[spec.key].map { [$0] } ?? [])
        let groups = tokens.reduce(UInt64(0)) { $0 | (masks[group($1)] ?? 0) }
        let sides: [String: UInt64] = ["cmd": 0x18, "shift": 0x6, "alt": 0x60, "ctrl": 0x2001]
        let exactSides = sides.allSatisfy { name, sideMask in
            let requested = tokens.filter { group($0) == name }
            if requested.isEmpty || requested.contains(name) { return true }
            let expected = requested.reduce(UInt64(0)) { $0 | (masks[$1] ?? 0) }
            return flags & sideMask == expected
        }
        return exactSides && flags & groupMask == groups && tokens.allSatisfy { token in
            guard let mask = masks[token] else { return false }
            return flags & mask != 0
        }
    }

    var specs: [HotkeySpec]
    private var flags: UInt64 = 0
    private var pending: Int?
    private var pendingSince: TimeInterval = 0
    private var active: Int?
    private var activeKey: UInt32?
    private var used = false
    private var consumedKeys: Set<UInt32> = []
    init(specs: [HotkeySpec]) { self.specs = specs }

    mutating func reset() -> [(Int, Bool)] {
        let releases = active.map { [($0, false)] } ?? []
        flags = 0; pending = nil; active = nil; activeKey = nil; used = false; consumedKeys = []
        return releases
    }

    mutating func tick(now: TimeInterval) -> [(Int, Bool)] {
        guard !used, active == nil, let index = pending,
              specs[index].inputMode == "hold", now - pendingSince >= 0.2 else { return [] }
        active = index
        pending = nil
        return [(index, true)]
    }

    mutating func event(type: CGEventType, keyCode: UInt32, flags raw: UInt64, repeated: Bool = false,
                        now: TimeInterval) -> (signals: [(Int, Bool)], consume: Bool) {
        var signals: [(Int, Bool)] = []
        let current = raw & Self.relevantMask
        if [.leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].contains(type) {
            pending = nil; used = current != 0
            if let index = active, activeKey == nil {
                signals.append((index, false)); active = nil
            }
            return (signals, false)
        }
        if type == .flagsChanged {
            let released = flags & ~current != 0
            flags = current
            if released {
                if let index = active {
                    signals.append((index, false)); active = nil; activeKey = nil
                } else if !used, let index = pending {
                    signals += [(index, true), (index, false)]
                }
                pending = nil
                used = true
            } else if !used, active == nil {
                let next = specs.indices.filter {
                    Self.keyModifiers[specs[$0].key] != nil && Self.matches(specs[$0], flags: current)
                }.max { specs[$0].modifiers.count < specs[$1].modifiers.count }
                if next != pending { pendingSince = now }
                pending = next
            }
            if current == 0 { pending = nil; used = false }
            let ownsFn = specs.contains { $0.key == "Fn" || $0.modifiers.contains("fn") }
            return (signals, keyCode == 63 && ownsFn)
        }
        if type == .keyDown {
            pending = nil
            used = true
            if consumedKeys.contains(keyCode) { return (signals, true) }
            // If a held modifier gesture already started, end it rather than
            // switching recording intent halfway through the same gesture.
            if let index = active, activeKey == nil {
                signals.append((index, false)); active = nil
                return (signals, false)
            }
            guard !repeated, active == nil,
                  let index = specs.indices.first(where: {
                      Self.keyModifiers[specs[$0].key] == nil && specs[$0].keyCode == keyCode &&
                      Self.matches(specs[$0], flags: current)
                  }) else { return (signals, false) }
            active = index; activeKey = keyCode; consumedKeys.insert(keyCode)
            signals.append((index, true))
            return (signals, true)
        }
        if type == .keyUp {
            if activeKey == keyCode, let index = active {
                signals.append((index, false)); active = nil; activeKey = nil
            }
            let consume = consumedKeys.remove(keyCode) != nil
            if current == 0 { used = false }
            return (signals, consume)
        }
        return ([], false)
    }
}

final class ModifierHotkeyMonitor {
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    private var timer: Timer?
    private var state = ModifierShortcutState(specs: [])
    private var trigger: ((HotkeySpec, Bool) -> Void)?
    private var configured = false
    var isReady: Bool { configured && (state.specs.isEmpty || (tap.map { CGEvent.tapIsEnabled(tap: $0) } ?? false)) }

    func configure(_ specs: [HotkeySpec], trigger: @escaping (HotkeySpec, Bool) -> Void) {
        stop()
        state = ModifierShortcutState(specs: specs)
        self.trigger = trigger
        configured = true
        retryIfNeeded()
    }
    func retryIfNeeded() {
        guard !state.specs.isEmpty, tap == nil, Bundle.main.bundleURL.pathExtension == "app", AXIsProcessTrusted() else { return }
        let mask = [CGEventType.keyDown, .keyUp, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown, .scrollWheel].reduce(CGEventMask(0)) { $0 | (1 << $1.rawValue) }
        let callback: CGEventTapCallBack = { _, type, event, context in
            guard let context else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<ModifierHotkeyMonitor>.fromOpaque(context).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                monitor.deliver(monitor.state.reset())
                if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            let result = monitor.state.event(type: type,
                keyCode: UInt32(event.getIntegerValueField(.keyboardEventKeycode)), flags: event.flags.rawValue,
                repeated: event.getIntegerValueField(.keyboardEventAutorepeat) != 0, now: ProcessInfo.processInfo.systemUptime)
            monitor.deliver(result.signals)
            return result.consume ? nil : Unmanaged.passUnretained(event)
        }
        guard let created = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
            options: .defaultTap, eventsOfInterest: mask, callback: callback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return }
        tap = created
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0)
        CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
        CGEvent.tapEnable(tap: created, enable: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.025, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.deliver(self.state.tick(now: ProcessInfo.processInfo.systemUptime))
        }
    }
    private func deliver(_ signals: [(Int, Bool)]) {
        for (index, down) in signals {
            let spec = state.specs[index]
            let callback = trigger
            DispatchQueue.main.async { callback?(spec, down) }
        }
    }
    func stop() {
        deliver(state.reset())
        timer?.invalidate(); timer = nil
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CFMachPortInvalidate(tap) }
        source = nil; tap = nil
        state = ModifierShortcutState(specs: [])
        configured = false
    }
}

/// Release may arrive before Capture confirms startup. It must request one
/// stop after confirmation, never toggle a new recording into existence.
public struct VoiceHoldGesture {
    private enum Phase { case idle, starting, recording, releasePending }
    private var phase: Phase = .idle
    public init() {}
    public mutating func begin() -> Bool {
        guard phase == .idle else { return false }
        phase = .starting
        return true
    }
    public mutating func release() -> Bool {
        switch phase {
        case .starting: phase = .releasePending; return false
        case .recording: phase = .idle; return true
        case .idle, .releasePending: return false
        }
    }
    public mutating func started() -> Bool {
        switch phase {
        case .releasePending: phase = .idle; return true
        case .starting: phase = .recording; return false
        case .idle, .recording: return false
        }
    }
    public mutating func cancel() { phase = .idle }
}

func menuKeyEquivalent(for label: String) -> String {
    let key = String(label.drop(while: { "⌘⇧⌃⌥".contains($0) }))
    switch key {
    case "Space": return " "
    case "Tab": return "\t"
    case "Return": return "\r"
    case "Escape": return "\u{1b}"
    default:
        if key.hasPrefix("F"),
           let number = Int(key.dropFirst()),
           (1...20).contains(number),
           let scalar = UnicodeScalar(0xF703 + number) {
            return String(Character(scalar))
        }
        return key.lowercased()
    }
}

func menuModifierFlags(for mask: UInt32) -> NSEvent.ModifierFlags {
    var flags: NSEvent.ModifierFlags = []
    if mask & 0x0100 != 0 { flags.insert(.command) }
    if mask & 0x0200 != 0 { flags.insert(.shift) }
    if mask & 0x0800 != 0 { flags.insert(.option) }
    if mask & 0x1000 != 0 { flags.insert(.control) }
    return flags
}

func defaultHotkeySpecs() -> [HotkeySpec] {
    [
        HotkeySpec(action: "dictate", keyCode: 63, modifierMask: 0, label: "Fn", targetLanguage: "", key: "Fn"),
        HotkeySpec(action: "translate", keyCode: 63, modifierMask: 0x200, label: "Fn + ⇧", targetLanguage: "English", key: "Fn", modifiers: ["shift"]),
        HotkeySpec(action: "voice_chat", keyCode: 49, modifierMask: 0, label: "Fn + Space", targetLanguage: "", key: "Space", modifiers: ["fn"]),
    ]
}

func readHotkeysFromConfig() -> [HotkeySpec] {
    let task = yuluPythonProcess(scriptDir: statusAgentScriptDir())
    task.arguments = ["status_agent_config.py", "hotkeys", "--json"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try nativeWork.run(task)
        let deadline = Date().addingTimeInterval(2)
        while task.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
        if task.isRunning {
            task.terminate()
            return defaultHotkeySpecs()
        }
    } catch {
        log("⚠️ failed to read status_agent hotkeys: \(error)")
        return defaultHotkeySpecs()
    }
    guard task.terminationStatus == 0,
          let data = try? pipe.fileHandleForReading.readToEnd(),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
        return defaultHotkeySpecs()
    }
    let parsed = raw.compactMap { item -> HotkeySpec? in
        guard let action = item["action"] as? String,
              let keyCode = (item["keyCode"] as? NSNumber)?.uint32Value,
              let modifierMask = (item["modifierMask"] as? NSNumber)?.uint32Value,
              let label = item["label"] as? String else {
            return nil
        }
        return HotkeySpec(
            action: action,
            keyCode: keyCode,
            modifierMask: modifierMask,
            label: label,
            targetLanguage: (item["targetLanguage"] as? String) ?? "",
            inputMode: (item["inputMode"] as? String) == "hold" ? "hold" : "toggle",
            key: (item["key"] as? String) ?? "",
            modifiers: (item["modifiers"] as? [String]) ?? []
        )
    }
    return parsed.isEmpty ? defaultHotkeySpecs() : parsed
}

class HotkeyRegistrar {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onTrigger: ((Bool) -> Void)?
    private var pressed = false
    private let id: UInt32

    static let signature: OSType = 0x59556C75

    init(id: UInt32) {
        self.id = id
    }

    func register(keyCode: UInt32, modifierMask: UInt32, _ trigger: @escaping (Bool) -> Void) -> Bool {
        unregister()
        onTrigger = trigger
        let hotKeyID = EventHotKeyID(signature: HotkeyRegistrar.signature, id: id)
        var specs = [
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed)),
            EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyReleased)),
        ]
        let handler: EventHandlerUPP = { (_, event, userData) -> OSStatus in
            guard let userData = userData else { return OSStatus(eventNotHandledErr) }
            let me = Unmanaged<HotkeyRegistrar>.fromOpaque(userData).takeUnretainedValue()
            var hotKeyID = EventHotKeyID()
            let status = GetEventParameter(
                event,
                EventParamName(kEventParamDirectObject),
                EventParamType(typeEventHotKeyID),
                nil,
                MemoryLayout<EventHotKeyID>.size,
                nil,
                &hotKeyID
            )
            guard status == noErr,
                  hotKeyID.signature == HotkeyRegistrar.signature,
                  hotKeyID.id == me.id else {
                return OSStatus(eventNotHandledErr)
            }
            let down = GetEventKind(event) == UInt32(kEventHotKeyPressed)
            DispatchQueue.main.async {
                guard me.pressed != down else { return }
                me.pressed = down
                me.onTrigger?(down)
            }
            return noErr
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(GetApplicationEventTarget(), handler, specs.count, &specs, selfPtr, &handlerRef)
        if installStatus != noErr {
            log("⚠️ InstallEventHandler failed: \(installStatus)")
            return false
        }
        let regStatus = RegisterEventHotKey(keyCode, modifierMask, hotKeyID, GetApplicationEventTarget(), 0, &hotKeyRef)
        if regStatus != noErr {
            log("⚠️ RegisterEventHotKey failed: \(regStatus)")
            return false
        }
        log("hotkey_registered id=\(id) keyCode=\(keyCode) modifiers=0x\(String(modifierMask, radix: 16))")
        return true
    }

    func unregister() {
        pressed = false
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let handler = handlerRef {
            RemoveEventHandler(handler)
            handlerRef = nil
        }
    }
}

enum VoiceOverlayAnimationMode {
    case none, starting, recording, processing, success, recovery, failure
}

/// The panel stays at its final size; only its contents move. This preserves
/// the input target and lets Core Animation keep rendering during AppKit work.
final class VoiceOverlayMotion {
    enum Phase { case hidden, appearing, visible, disappearing }
    private(set) var phase: Phase = .hidden
    private var generation = 0
    var reduceMotion: () -> Bool = { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }
    var schedule: (TimeInterval, @escaping () -> Void) -> Void = { delay, completion in
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: completion)
    }

    func show(_ view: NSView) {
        guard phase == .hidden || phase == .disappearing else { return }
        let entering = phase == .hidden
        generation += 1
        let current = generation
        phase = .appearing
        animate(view, visible: true, entering: entering, duration: 0.20)
        schedule(reduceMotion() ? 0 : 0.20) { [weak self] in
            guard let self, self.generation == current else { return }
            self.phase = .visible
        }
    }

    func hide(_ view: NSView, canceled: Bool = false, completion: @escaping () -> Void) {
        guard phase != .hidden && phase != .disappearing else { return }
        generation += 1
        let current = generation
        phase = .disappearing
        let duration = canceled ? 0.14 : 0.18
        animate(view, visible: false, entering: false, duration: duration)
        schedule(reduceMotion() ? 0 : duration) { [weak self] in
            guard let self, self.generation == current else { return }
            self.phase = .hidden
            completion()
        }
    }

    private func animate(_ view: NSView, visible: Bool, entering: Bool, duration: TimeInterval) {
        guard let layer = view.layer else { return }
        let compact = CGAffineTransform(translationX: view.bounds.width * 0.06, y: 4)
            .scaledBy(x: 0.88, y: 0.96)
        let fromOpacity = entering ? Float(0) : (layer.presentation()?.opacity ?? layer.opacity)
        let fromTransform = entering ? CATransform3DMakeAffineTransform(compact)
            : (layer.presentation()?.transform ?? layer.transform)
        let toTransform = visible ? CATransform3DIdentity : CATransform3DMakeAffineTransform(compact)
        layer.removeAnimation(forKey: "voice-opacity")
        layer.removeAnimation(forKey: "voice-transform")
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.opacity = visible ? 1 : 0
        layer.transform = reduceMotion() ? CATransform3DIdentity : toTransform
        CATransaction.commit()
        guard !reduceMotion() else { return }
        for (key, from, to) in [
            ("opacity", fromOpacity as Any, layer.opacity as Any),
            ("transform", NSValue(caTransform3D: fromTransform), NSValue(caTransform3D: toTransform))
        ] {
            let animation = CABasicAnimation(keyPath: key)
            animation.fromValue = from
            animation.toValue = to
            animation.duration = duration
            animation.timingFunction = CAMediaTimingFunction(name: visible ? .easeOut : .easeInEaseOut)
            layer.add(animation, forKey: "voice-\(key)")
        }
    }
}

private enum VoiceOverlayPalette {
    // The same blue family as Yulu's quotation-mark logo.
    static let highlight = NSColor(srgbRed: 96.0 / 255, green: 170.0 / 255, blue: 243.0 / 255, alpha: 1)
    static let blue = NSColor(srgbRed: 44.0 / 255, green: 93.0 / 255, blue: 189.0 / 255, alpha: 1)
    static let darkSurface = NSColor(srgbRed: 28.0 / 255, green: 34.0 / 255, blue: 45.0 / 255, alpha: 1)
}

/// AppKit still owns tracking and the target/action; only the button chrome is custom.
class VoiceOverlayActionButton: NSButton {
    var primary = false
    var visualScale: CGFloat = 1
    private var hovered = false
    private var hoverTracking: NSTrackingArea?

    override var acceptsFirstResponder: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let hoverTracking { removeTrackingArea(hoverTracking) }
        let tracking = NSTrackingArea(rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(tracking)
        hoverTracking = tracking
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 0.5, dy: 0.5))
        let pressed = cell?.isHighlighted == true
        if primary {
            let blue = VoiceOverlayPalette.blue
            let fill = pressed ? blue.blended(withFraction: 0.18, of: .black) ?? blue
                : hovered ? blue.blended(withFraction: 0.18, of: VoiceOverlayPalette.highlight) ?? blue : blue
            fill.setFill()
            circle.fill()
        } else if hovered || pressed {
            NSColor.labelColor.withAlphaComponent(pressed ? 0.10 : 0.05).setFill()
            circle.fill()
        }
        let size: CGFloat = (primary ? 17 : 12) * visualScale
        let tint: NSColor = primary ? .white : .labelColor.withAlphaComponent(0.76)
        let configuration = NSImage.SymbolConfiguration(pointSize: size, weight: .medium)
            .applying(.init(paletteColors: [tint]))
        guard let symbol = image?.withSymbolConfiguration(configuration) else { return }
        let rect = NSRect(x: (bounds.width - symbol.size.width) / 2,
            y: (bounds.height - symbol.size.height) / 2,
            width: symbol.size.width, height: symbol.size.height)
        symbol.draw(in: rect, from: .zero, operation: .sourceOver, fraction: isEnabled ? 1 : 0.4,
            respectFlipped: true, hints: nil)
    }
}

class VoiceWaveView: NSView {
    private var isDarkAppearance: Bool {
        effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
    }
    private var timer: Timer?
    private var displayedLevel: CGFloat = 0
    private var transitionStartedAt = ProcessInfo.processInfo.systemUptime
    private var collapseFromLevel: CGFloat = 0
    private var collapseFrom: CGFloat = 0
    private var compactness: CGFloat = 0
    deinit { timer?.invalidate() }
    var mode: VoiceOverlayAnimationMode = .none {
        didSet {
            guard mode != oldValue else { return }
            transitionStartedAt = ProcessInfo.processInfo.systemUptime
            collapseFromLevel = displayedLevel
            collapseFrom = compactness
            if mode == .processing && (window?.isVisible != true || (oldValue != .recording && oldValue != .starting)) {
                compactness = 1
                collapseFrom = 1
                collapseFromLevel = 0
            }
            if mode == .starting { displayedLevel = 0; level = 0; compactness = 0 }
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                compactness = mode == .processing ? 1 : 0
            }
            updateTimer()
            needsDisplay = true
        }
    }
    var level: CGFloat = 0 {
        didSet {
            if window == nil || NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                displayedLevel = level
            }
            updateTimer()
            needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTimer()
    }

    private func updateTimer() {
        let shouldAnimate = window != nil
            && (mode == .starting || mode == .processing
                || (mode == .recording && (compactness > 0.005 || abs(displayedLevel - level) > 0.005)))
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !shouldAnimate {
            timer?.invalidate()
            timer = nil
            return
        }
        if timer == nil {
            let next = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
                guard let self else { return }
                self.displayedLevel += (self.level - self.displayedLevel) * 0.12
                if self.mode == .recording { self.compactness *= 0.8 }
                self.needsDisplay = true
                self.updateTimer()
            }
            timer = next
            RunLoop.main.add(next, forMode: .common)
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if mode == .none { return }
        let accent = isDarkAppearance ? VoiceOverlayPalette.highlight : VoiceOverlayPalette.blue
        if mode == .recovery {
            let image = NSImage(systemSymbolName: "text.bubble", accessibilityDescription: nil)
            image?.withSymbolConfiguration(.init(paletteColors: [.secondaryLabelColor]))?
                .draw(in: bounds.insetBy(dx: 3, dy: 3))
            return
        }
        if mode == .success {
            accent.setStroke()
            let check = NSBezierPath()
            check.lineWidth = 2.6
            check.lineCapStyle = .round
            check.lineJoinStyle = .round
            check.move(to: NSPoint(x: bounds.midX - 7, y: bounds.midY))
            check.line(to: NSPoint(x: bounds.midX - 2, y: bounds.midY - 5))
            check.line(to: NSPoint(x: bounds.midX + 8, y: bounds.midY + 6))
            check.stroke()
            return
        }
        drawDotWave()
    }

    private func drawDotWave() {
        let accent = isDarkAppearance ? VoiceOverlayPalette.highlight : VoiceOverlayPalette.blue
        let scale = min(1, bounds.height / 24)
        let bars = 29
        let gap: CGFloat = 2 * scale
        let width: CGFloat = 2.4 * scale
        let total = CGFloat(bars) * width + CGFloat(bars - 1) * gap
        let startX = (bounds.width - total) / 2
        let shapes: [CGFloat] = [0.04, 0.07, 0.06, 0.12, 0.08, 0.18, 0.10, 0.15,
            0.24, 0.36, 0.64, 0.44, 0.82, 1, 0.74, 0.50, 0.34, 0.48, 0.22,
            0.14, 0.20, 0.09, 0.14, 0.08, 0.10, 0.06, 0.08, 0.04, 0.05]
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let elapsed = ProcessInfo.processInfo.systemUptime - transitionStartedAt
        let progress = reduced ? 1 : min(1, elapsed / 0.16)
        if mode == .processing { compactness = collapseFrom + (1 - collapseFrom) * progress }
        let amplitude = mode == .starting ? 0 : mode == .processing
            ? collapseFromLevel * (1 - progress) : max(0, min(1, displayedLevel))
        for i in 0..<bars {
            let height = width + 18 * scale * amplitude * shapes[i]
            let fullX = startX + CGFloat(i) * (width + gap)
            let compactX = bounds.midX - 12 * scale + CGFloat(i - 2) * scale
            let x = fullX + (compactX - fullX) * compactness
            let y = (bounds.height - height) / 2
            let restingOpacity: CGFloat = mode == .processing ? 0.82 : isDarkAppearance ? 0.62 : 0.46
            let retainedDot = i % 4 == 2
            let retainedOpacity: CGFloat = retainedDot ? 1 : 1 - compactness
            let pulse: CGFloat = reduced ? 1 : mode == .starting
                ? 0.72 + 0.28 * CGFloat(sin(elapsed * 3.8))
                : mode == .processing ? 0.65 + 0.35 * CGFloat(sin(elapsed * 5 - Double(i) * 0.28)) : 1
            accent.withAlphaComponent((restingOpacity + amplitude * shapes[i] * (1 - restingOpacity))
                * retainedOpacity * pulse).setFill()
            NSBezierPath(roundedRect: NSRect(x: x, y: y, width: width, height: height),
                xRadius: width / 2, yRadius: width / 2).fill()
        }
    }
}

class VoiceOverlayContainerView: NSView {
    var mode: VoiceOverlayAnimationMode = .none {
        didSet { configureLayer(); needsDisplay = true }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        configureLayer()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        configureLayer()
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        configureLayer()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let dark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let exception = mode == .recovery || mode == .failure
        let radius: CGFloat = exception ? 16 : bounds.height / 2
        let stroke: CGFloat = exception ? 1 : 0.5
        let capsule = NSBezierPath(
            roundedRect: bounds.insetBy(dx: stroke / 2, dy: stroke / 2),
            xRadius: radius,
            yRadius: radius
        )
        (dark ? VoiceOverlayPalette.darkSurface : NSColor.white).setFill()
        capsule.fill()
        capsule.lineWidth = stroke
        (dark ? VoiceOverlayPalette.highlight.withAlphaComponent(0.16)
            : VoiceOverlayPalette.blue.withAlphaComponent(0.13)).setStroke()
        capsule.stroke()
    }

    private func configureLayer() {
        wantsLayer = true
        guard let layer = layer else { return }
        layer.backgroundColor = NSColor.clear.cgColor
        layer.cornerRadius = mode == .recovery || mode == .failure ? 16 : 12
        layer.borderWidth = 0
        layer.shadowOpacity = 0
    }

}

/// A half-size capsule contains only motion and controls. Text belongs to a
/// separate, readable exception panel, which never takes keyboard focus.
class VoiceOverlayContentView: VoiceOverlayContainerView {
    static let capsuleSize = NSSize(width: 122, height: 24)
    let statusLabel = NSTextField(labelWithString: "")
    let hintLabel = NSTextField(labelWithString: "")
    let transcriptLabel = NSTextField(wrappingLabelWithString: "")
    let waveView = VoiceWaveView()
    let stopButton = VoiceOverlayActionButton()
    let cancelButton = VoiceOverlayActionButton()
    let copyButton = NSButton()
    let permissionButton = NSButton()
    private var transcriptHeight: CGFloat = 0
    private var hintHeight: CGFloat = 16
    private var noticeHeight: CGFloat = 0
    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        statusLabel.font = .systemFont(ofSize: 12.5, weight: .medium)
        statusLabel.textColor = .labelColor
        hintLabel.font = .systemFont(ofSize: 11)
        hintLabel.textColor = .secondaryLabelColor
        for label in [statusLabel, hintLabel] {
            label.lineBreakMode = .byTruncatingTail
            label.maximumNumberOfLines = 1
        }
        hintLabel.maximumNumberOfLines = 2
        hintLabel.lineBreakMode = .byWordWrapping
        hintLabel.cell?.wraps = true
        transcriptLabel.font = .systemFont(ofSize: 13)
        transcriptLabel.textColor = .labelColor
        transcriptLabel.maximumNumberOfLines = 4
        transcriptLabel.lineBreakMode = .byWordWrapping
        transcriptLabel.cell?.wraps = true
        transcriptLabel.cell?.truncatesLastVisibleLine = true
        for (button, symbol) in [(stopButton, "arrow.up"), (cancelButton, "xmark")] {
            button.isBordered = false
            button.setButtonType(.momentaryChange)
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            button.imagePosition = .imageOnly
            button.contentTintColor = .secondaryLabelColor
        }
        stopButton.primary = true
        stopButton.setAccessibilityLabel(L("结束录音", "Finish recording"))
        stopButton.toolTip = L("结束录音", "Finish recording")
        copyButton.title = L("复制文字", "Copy text")
        copyButton.bezelStyle = .rounded
        copyButton.font = .systemFont(ofSize: 12, weight: .medium)
        copyButton.setAccessibilityLabel(copyButton.title)
        permissionButton.title = L("开启输入权限", "Enable input access")
        permissionButton.bezelStyle = .rounded
        permissionButton.font = .systemFont(ofSize: 12, weight: .medium)
        for view in [waveView, statusLabel, hintLabel, transcriptLabel, stopButton, cancelButton, copyButton, permissionButton] {
            addSubview(view)
        }
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    func update(title: String, hint: String, mode: VoiceOverlayAnimationMode, transcript: String = "", needsInputAccess: Bool = false) -> NSSize {
        self.mode = mode
        statusLabel.stringValue = title
        hintLabel.stringValue = hint
        transcriptLabel.stringValue = transcript
        waveView.mode = mode
        waveView.isHidden = mode == .none || mode == .failure
        let recovery = mode == .recovery
        let exception = recovery || mode == .failure
        let capturing = mode == .recording || mode == .starting
        statusLabel.isHidden = !exception
        statusLabel.maximumNumberOfLines = mode == .failure ? 0 : 1
        statusLabel.lineBreakMode = mode == .failure ? .byWordWrapping : .byTruncatingTail
        statusLabel.cell?.wraps = mode == .failure
        hintLabel.isHidden = !recovery
        waveView.toolTip = nil
        waveView.setAccessibilityElement(true)
        waveView.setAccessibilityRole(.image)
        waveView.setAccessibilityLabel([title, hint].filter { !$0.isEmpty }.joined(separator: " · "))
        stopButton.isHidden = !capturing
        stopButton.isEnabled = mode == .recording
        cancelButton.isHidden = mode == .success || mode == .none
        cancelButton.toolTip = exception ? L("关闭", "Dismiss") : mode == .processing
            ? L("取消处理", "Cancel processing") : L("取消录音", "Cancel recording")
        cancelButton.setAccessibilityLabel(cancelButton.toolTip)
        copyButton.isHidden = !recovery
        copyButton.title = L("复制文字", "Copy text")
        permissionButton.isHidden = !recovery || !needsInputAccess
        transcriptLabel.isHidden = !recovery
        stopButton.visualScale = 0.5
        cancelButton.visualScale = exception ? 1 : 0.5
        let width: CGFloat = exception ? 360 : Self.capsuleSize.width
        if recovery {
            hintHeight = max(16, ceil((hint as NSString).boundingRect(
                with: NSSize(width: width - 98, height: 100),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: hintLabel.font!]).height) + 2)
            let measured = (transcript as NSString).boundingRect(
                with: NSSize(width: width - 32, height: 500),
                options: [.usesLineFragmentOrigin, .usesFontLeading],
                attributes: [.font: transcriptLabel.font!])
            transcriptHeight = min(76, max(20, ceil(measured.height) + 4))
        } else { transcriptHeight = 0 }
        noticeHeight = max(20, ceil((title as NSString).boundingRect(
            with: NSSize(width: width - 68, height: 500),
            options: [.usesLineFragmentOrigin, .usesFontLeading],
            attributes: [.font: statusLabel.font!]).height) + 4)
        needsLayout = true
        return NSSize(width: width, height: recovery ? max(61, 43 + hintHeight) + 47 + transcriptHeight
            : mode == .failure ? max(52, noticeHeight + 28) : Self.capsuleSize.height)
    }

    override func layout() {
        super.layout()
        if mode != .recovery && mode != .failure {
            waveView.frame = mode == .success
                ? NSRect(x: bounds.midX - 13, y: -1, width: 26, height: 26)
                : NSRect(x: 9, y: 6, width: mode == .processing ? 88 : 63, height: 12)
            cancelButton.frame = NSRect(x: bounds.width - (mode == .processing ? 20 : 42), y: 4, width: 16, height: 16)
            stopButton.frame = NSRect(x: bounds.width - 22, y: 2.5, width: 19, height: 19)
            statusLabel.frame = .zero
            hintLabel.frame = .zero
            return
        }
        let right = bounds.width - 14
        let rowHeight: CGFloat = mode == .recovery ? 60 : bounds.height
        waveView.frame = NSRect(x: 15, y: (rowHeight - 26) / 2, width: 26, height: 26)
        cancelButton.frame = NSRect(x: bounds.width - 40, y: (rowHeight - 32) / 2, width: 32, height: 32)
        let textEnd = cancelButton.isHidden ? right : cancelButton.frame.minX - 8
        let textStart: CGFloat = waveView.isHidden ? 18 : 50
        statusLabel.frame = NSRect(x: textStart, y: mode == .recovery ? 13 : (rowHeight - noticeHeight) / 2,
            width: textEnd - textStart, height: mode == .recovery ? 19 : noticeHeight)
        hintLabel.frame = NSRect(x: textStart, y: 33, width: textEnd - textStart, height: hintHeight)
        transcriptLabel.frame = NSRect(x: 16, y: max(61, 43 + hintHeight), width: bounds.width - 32, height: transcriptHeight)
        copyButton.frame = NSRect(x: bounds.width - 112, y: bounds.height - 40, width: 96, height: 28)
        permissionButton.frame = NSRect(x: 16, y: bounds.height - 40, width: 152, height: 28)
    }
}

// Enumerate the recordings directory directly off disk (no Python, no
// dependency on the web server). Sort newest-first, return top N. Every
// recording now lives in the single root directory (the historical
// ~/Movies/Yulu/memos subdirectory was merged into the root by the
// recording-unify migration).
func recentRecordingFallbackTitle(_ stem: String) -> String {
    let withoutTimestamp = stem.replacingOccurrences(
        of: #"_[0-9]{8}_[0-9]{6}$"#,
        with: "",
        options: .regularExpression
    )
    return withoutTimestamp
        .replacingOccurrences(of: "_", with: " ")
        .replacingOccurrences(
            of: #"([a-z0-9])([A-Z])"#,
            with: "$1 $2",
            options: .regularExpression
        )
}

func loadRecentRecordings(limit: Int = 5) -> [RecentRecording] {
    let base = loadRecordingDir()
    var out: [RecentRecording] = []

    func scan(_ dir: String) {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for f in entries where f.hasSuffix(".wav") {
            let stem = String(f.dropLast(4))
            let path = "\(dir)/\(f)"
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            let mtime = (attrs?[.modificationDate] as? Date) ?? Date.distantPast
            let savedTitle = (try? String(
                contentsOf: URL(fileURLWithPath: "\(dir)/\(stem).title"),
                encoding: .utf8
            ))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let title = savedTitle.isEmpty ? recentRecordingFallbackTitle(stem) : savedTitle
            out.append(RecentRecording(stem: stem, title: title, mtime: mtime))
        }
    }
    scan(base)
    out.sort { $0.mtime > $1.mtime }
    return Array(out.prefix(limit))
}

// Synchronous Unix-socket client. Mirrors record_audio.socket_send's
// line-delimited JSON contract: write one JSON object + newline, read
// one JSON object back.
class DaemonClient {
    static let socketPath = "\(IPC_DIR)/audio_daemon.sock"

    static func send(_ payload: [String: Any]) -> [String: Any]? {
        guard let json = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { p in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = strncpy(p, src.baseAddress!, pathBytes.count)
                }
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        guard connectResult >= 0 else { return nil }

        // Defense in depth: a hung audio_daemon must not tie up our
        // background pollers forever. SO_RCVTIMEO + SO_SNDTIMEO at 3s
        // each turns blocking reads/writes into bounded operations that
        // surface as nil (caller treats as daemon-down after 3 strikes).
        var tv = timeval(tv_sec: 3, tv_usec: 0)
        _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        _ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

        // Write JSON + newline, then half-close the write side.
        //
        // Why SHUT_WR: audio_daemon's SocketServer reads "until newline OR
        // EOF" but the newline path was empirically broken — server stayed
        // blocked on read() even after a properly terminated request. The
        // SHUT_WR path is the reliable framing used by every Python client
        // in the tree (record_audio.py, meeting_daemon.py), and it works
        // regardless of which framing variant the server happens to support.
        // This decouples our IPC reliability from any single server-side
        // framing assumption.
        var line = json
        line.append(0x0A)
        _ = line.withUnsafeBytes { buf in
            write(fd, buf.baseAddress, buf.count)
        }
        _ = shutdown(fd, Int32(SHUT_WR))

        // Read response (up to 64 KB, blocking — daemon is local)
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &buffer, buffer.count)
        guard n > 0 else { return nil }
        let data = Data(buffer[0..<n])
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

enum AgentState: String {
    case idle, recording, processing, meetingBusy, daemonDown
}

class IconStateMachine {
    static func image(for state: AgentState) -> NSImage? {
        let name: String
        switch state {
        case .idle:         name = "status_idle"
        case .recording:    name = "status_recording"
        case .processing:   name = "status_processing"
        case .meetingBusy:  name = "status_idle"   // greyed-out via alpha (set by caller)
        case .daemonDown:   name = "status_idle"   // (caller can overlay; not in v1)
        }
        guard let img = NSImage(named: name) else { return nil }
        img.isTemplate = false
        return img
    }
}

// Spawn `meeting_daemon.py start` / `meeting_daemon.py stop` as detached
// subprocesses — the same path `yulu record start` / `yulu record stop`
// drive. The recording is always mic + system audio (no mic-only mode);
// the status agent is just a button + indicator, all recording lifecycle +
// transcribe + enqueue stays in the Python pipeline.
class RecordingLauncher {
    typealias DictationCompletion = ([String: Any]?, String, Int32) -> Void
    private static var stopProcess: Process?

    static func stopStatus(pid: Int32) -> [String: Any] {
        guard let process = stopProcess, process.processIdentifier == pid else {
            return ["ok": false, "error": "stop_result_unavailable"]
        }
        if process.isRunning { return ["ok": true, "state": "running"] }
        return [
            "ok": true,
            "state": process.terminationStatus == 0 ? "completed" : "failed",
            "exit_status": Int(process.terminationStatus),
        ]
    }

    private static func scriptDir() -> String {
        statusAgentScriptDir()
    }

    private static func launcherLog() -> FileHandle {
        let logPath = "\(LOGS_DIR)/status_agent_launcher.log"
        if !FileManager.default.fileExists(atPath: logPath) {
            FileManager.default.createFile(atPath: logPath, contents: nil)
        }
        let logFH = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
        _ = try? logFH.seekToEnd()
        return logFH
    }

    // Title for a manually-started recording. There's no calendar context for
    // a menu-bar/IPC start, so use the frontmost app's name as a sensible
    // default ("Slack", "zoom.us", …), falling back to a generic "Recording".
    static func defaultTitle() -> String {
        if let name = NSWorkspace.shared.frontmostApplication?.localizedName,
           !name.isEmpty {
            return name
        }
        return L("录音", "Recording")
    }

    // Start a meeting recording (mic + system). meeting_daemon.py start sends
    // the daemon start RPC and returns immediately; the agent's poller then
    // observes recording=true off the audio daemon and drives the indicator.
    @discardableResult
    static func launchStart(title: String) -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        task.arguments = [
            "meeting_daemon.py", "start", title,
        ]
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try nativeWork.run(task)
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch meeting_daemon.py start: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchStartMeeting(meetingId: String, join: Bool) -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        var args = [
            "meeting_daemon.py", "start_meeting", meetingId,
        ]
        if join { args.append("--join") }
        task.arguments = args
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try nativeWork.run(task)
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch meeting_daemon.py start_meeting: \(error)")
            return nil
        }
    }

    // Stop the recording. meeting_daemon.py stop sends the daemon stop RPC and
    // then runs the (potentially slow) per-recording transcription pipeline.
    @discardableResult
    static func launchStop() -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        task.arguments = [
            "meeting_daemon.py", "stop",
        ]
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try nativeWork.run(task)
            stopProcess = task
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch meeting_daemon.py stop: \(error)")
            return nil
        }
    }

    private static func launchDictation(
        arguments: [String],
        completion: @escaping DictationCompletion
    ) -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        // Module execution can read build-time bytecode inside the signed App.
        task.arguments = ["-m", "dictate"] + Array(arguments.dropFirst())
        var environment = task.environment ?? [:]
        environment["YULU_VOICE_PROGRESS"] = "1"
        task.environment = environment
        task.standardInput = FileHandle.nullDevice

        let tempDir = FileManager.default.temporaryDirectory
        let token = UUID().uuidString
        let outputURL = tempDir.appendingPathComponent("yulu-dictation-\(token).out")
        let errorURL = tempDir.appendingPathComponent("yulu-dictation-\(token).err")
        FileManager.default.createFile(atPath: outputURL.path, contents: nil)
        FileManager.default.createFile(atPath: errorURL.path, contents: nil)
        guard let outputHandle = FileHandle(forWritingAtPath: outputURL.path),
              let errorHandle = FileHandle(forWritingAtPath: errorURL.path) else {
            try? FileManager.default.removeItem(at: outputURL)
            try? FileManager.default.removeItem(at: errorURL)
            return nil
        }
        task.standardOutput = outputHandle
        task.standardError = errorHandle
        task.terminationHandler = { process in
            try? outputHandle.close()
            try? errorHandle.close()
            let output = (try? Data(contentsOf: outputURL)) ?? Data()
            let error = (try? Data(contentsOf: errorURL)) ?? Data()
            try? FileManager.default.removeItem(at: outputURL)
            try? FileManager.default.removeItem(at: errorURL)

            let logHandle = launcherLog()
            try? logHandle.write(contentsOf: output)
            try? logHandle.write(contentsOf: error)
            try? logHandle.close()

            let result = parseDictationOutput(output)
            let message = String(data: error, encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            DispatchQueue.main.async {
                completion(result, message, process.terminationStatus)
            }
        }
        do {
            try nativeWork.run(task)
            return task.processIdentifier
        } catch {
            try? outputHandle.close()
            try? errorHandle.close()
            try? FileManager.default.removeItem(at: outputURL)
            try? FileManager.default.removeItem(at: errorURL)
            log("⚠️ failed to launch dictation: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchDictateToggle(
        targetBundleId: String = "",
        targetAppName: String = "",
        completion: @escaping DictationCompletion
    ) -> Int32? {
        var args = [
            "dictate.py", "toggle",
            "--json",
        ]
        if !targetBundleId.isEmpty {
            args.append(contentsOf: ["--target-bundle-id", targetBundleId])
        }
        if !targetAppName.isEmpty {
            args.append(contentsOf: ["--target-app-name", targetAppName])
        }
        return launchDictation(arguments: args, completion: completion)
    }

    @discardableResult
    static func launchDictateTranslateToggle(
        targetLanguage: String,
        targetBundleId: String = "",
        targetAppName: String = "",
        completion: @escaping DictationCompletion
    ) -> Int32? {
        var args = [
            "dictate.py", "toggle",
            "--translate-to", targetLanguage.isEmpty ? "English" : targetLanguage,
            "--json",
        ]
        if !targetBundleId.isEmpty {
            args.append(contentsOf: ["--target-bundle-id", targetBundleId])
        }
        if !targetAppName.isEmpty {
            args.append(contentsOf: ["--target-app-name", targetAppName])
        }
        return launchDictation(arguments: args, completion: completion)
    }

    @discardableResult
    static func launchWarmDictation(targetLanguage: String = "") -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        var args = [
            "dictate.py", "warm",
            "--timeout-sec", "90",
            "--json",
        ]
        if !targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["--translate-to", targetLanguage])
        }
        task.arguments = args
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try nativeWork.run(task)
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py warm: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchVoiceChatToggle(completion: @escaping DictationCompletion) -> Int32? {
        return launchDictation(arguments: [
            "dictate.py", "ask-toggle",
            "--no-paste",
            "--no-copy",
            "--json",
        ], completion: completion)
    }

    @discardableResult
    static func launchDictateCancel(completion: @escaping DictationCompletion) -> Int32? {
        launchDictation(arguments: ["dictate.py", "cancel", "--json"], completion: completion)
    }
}

private final class VoiceLaunchReceipt {
    // Accessed only on main. A very short-lived helper can exit before its
    // background launcher has registered the PID.
    var pid: Int32?
    var registered = false
    var earlyCompletion: (() -> Void)?
}

private enum VoiceCommandKind {
    case dictate, translate(String), chat
}

// IPC server for programmatic toggle/status/open-inbox. Mirrors
// audio_daemon's line-delimited JSON contract (write one JSON object +
// newline, read one back). Wired to a weak StatusAgentApp reference so
// state queries always read from the live delegate; mutating actions
// (`toggle`, `open_inbox`) dispatch onto the main queue before invoking
// AppKit code.
//
// Why a Unix socket and not just a CLI flag: the running agent is a
// long-lived launchd job, not something you re-exec. The socket gives
// `yulu status-agent toggle/state/open-inbox` and acceptance tests a
// way to drive the agent without UI clicks or osascript hackery.
class IPCServer {
    weak var app: StatusAgentApp?
    var sock: Int32 = -1
    private var ownerLock: Int32 = -1
    private var socketIdentity: (dev_t, ino_t)?

    init(app: StatusAgentApp) { self.app = app }

    var ownsEndpoint: Bool {
        var info = stat()
        var descriptor = stat()
        guard sock >= 0, ownerLock >= 0, let identity = socketIdentity,
              fstat(sock, &descriptor) == 0, descriptor.st_mode & S_IFMT == S_IFSOCK,
              lstat(IPC_SOCKET_PATH, &info) == 0 else { return false }
        return info.st_dev == identity.0 && info.st_ino == identity.1
            && info.st_mode & S_IFMT == S_IFSOCK && info.st_uid == geteuid()
    }

    func stop() {
        if sock >= 0 { shutdown(sock, SHUT_RDWR); close(sock); sock = -1 }
        var info = stat()
        if let identity = socketIdentity,
           lstat(IPC_SOCKET_PATH, &info) == 0,
           info.st_dev == identity.0, info.st_ino == identity.1 {
            try? FileManager.default.removeItem(atPath: IPC_SOCKET_PATH)
        }
        socketIdentity = nil
        if ownerLock >= 0 { close(ownerLock); ownerLock = -1 }
    }

    func start() throws {
        guard sock < 0 else { return }
        ownerLock = Darwin.open("\(IPC_SOCKET_PATH).lock", O_CREAT | O_RDWR | O_CLOEXEC | O_NOFOLLOW, 0o600)
        var lockInfo = stat()
        guard ownerLock >= 0, fstat(ownerLock, &lockInfo) == 0,
              lockInfo.st_mode & S_IFMT == S_IFREG,
              lockInfo.st_uid == geteuid(), lockInfo.st_nlink == 1,
              flock(ownerLock, LOCK_EX | LOCK_NB) == 0 else {
            stop()
            throw NSError(domain: "YuluNativeRecording", code: Int(EADDRINUSE), userInfo: [
                NSLocalizedDescriptionKey: "Native recording controls already have an owner or an unsafe lock."
            ])
        }
        var succeeded = false
        defer { if !succeeded { stop() } }
        sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
        _ = fcntl(sock, F_SETFD, FD_CLOEXEC)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = IPC_SOCKET_PATH.utf8CString
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            log("IPC: socket path too long (\(pathBytes.count))")
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(ENAMETOOLONG))
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { p in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = strncpy(p, src.baseAddress!, pathBytes.count)
                }
            }
        }
        var previous = stat()
        if lstat(IPC_SOCKET_PATH, &previous) == 0 {
            guard previous.st_mode & S_IFMT == S_IFSOCK, previous.st_uid == geteuid() else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(EEXIST))
            }
            let probe = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
            guard probe >= 0 else { throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno)) }
            defer { close(probe) }
            let connected = withUnsafePointer(to: &addr) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(probe, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            guard connected != 0, errno == ECONNREFUSED else {
                throw NSError(domain: NSPOSIXErrorDomain, code: Int(EADDRINUSE))
            }
            try FileManager.default.removeItem(atPath: IPC_SOCKET_PATH)
        }
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            log("IPC: bind failed errno=\(errno)")
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        var info = stat()
        guard lstat(IPC_SOCKET_PATH, &info) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        guard Darwin.listen(sock, 5) == 0 else {
            throw NSError(domain: NSPOSIXErrorDomain, code: Int(errno))
        }
        socketIdentity = (info.st_dev, info.st_ino)
        chmod(IPC_SOCKET_PATH, 0o600)
        succeeded = true
        log("IPC: ready at \(IPC_SOCKET_PATH)")

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
                    log("IPC: accept failed errno=\(errno)")
                    usleep(200_000)
                }
            }
        }
    }

    private func handle(_ c: Int32) {
        var data = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        // Paste/search payloads can contain long Unicode transcripts. Bound
        // size and idle time while allowing their existing bulk IPC contract.
        var readTimeout = timeval(tv_sec: 3, tv_usec: 0)
        setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &readTimeout, socklen_t(MemoryLayout<timeval>.size))
        while true {
            let n = read(c, &buf, 4096)
            if n <= 0 { break }
            data.append(buf, count: n)
            if data.count > 1_048_576 {
                sendJSON(c, ["ok": false, "error": "request_too_large"])
                return
            }
            if data.last == 0x0A { break }
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = obj["action"] as? String else {
            sendJSON(c, ["ok": false, "error": "invalid_json"])
            return
        }
        let readOnly = action == "status" || action == "stop_status" || action == "permission_status"
        let admission = readOnly ? nil : nativeWork.admit()
        guard readOnly || admission != nil else {
            sendJSON(c, ["ok": false, "error": "controls_quiescing"])
            return
        }
        // Keep synchronous work owned through its response; queued AppKit work
        // retains the same admission until the main queue has finished with it.
        defer { withExtendedLifetime(admission) {} }
        switch action {
        case "status":
            sendJSON(c, statusResponse())
        case "permission_status":
            sendJSON(c, permissionStatusResponse())
        case "open_permission_settings":
            sendJSON(c, mainResponse(admission: admission) {
                ["ok": $0.openPermissionSettings(obj["permission"] as? String ?? "")]
            })
        case "shortcut_editing":
            sendJSON(c, mainResponse(admission: admission) { app in
                let active = obj["active"] as? Bool == true
                if active && (app.heldHotkey != nil || app.activeRecordingIsDictation) {
                    return ["ok": false, "error": "voice_input_busy"]
                }
                app.shortcutEditingUntil = active ? Date().addingTimeInterval(30) : .distantPast
                return ["ok": true]
            })
        case "notify":
            sendJSON(c, mainResponse(admission: admission) { _ in
                YuluNotificationPresenter.shared.receive(obj)
            })
        case "toggle":
            sendJSON(c, stateChangeResponse(admission: admission) { $0.onMenuToggle() })
        case "stop":
            sendJSON(c, mainResponse(admission: admission) { _ in
                guard let pid = RecordingLauncher.launchStop() else {
                    return ["ok": false, "error": "stop_failed"]
                }
                return ["ok": true, "accepted": true, "launcher_pid": Int(pid)]
            })
        case "stop_status":
            sendJSON(c, mainResponse(admission: nil) { _ in
                guard let rawPID = obj["launcher_pid"] as? Int,
                      let pid = Int32(exactly: rawPID), pid > 0 else {
                    return ["ok": false, "error": "invalid_launcher_pid"]
                }
                return RecordingLauncher.stopStatus(pid: pid)
            })
        case "dictate_toggle":
            sendJSON(c, stateChangeResponse(admission: admission) { $0.onDictateToggle() })
        case "dictation_progress":
            sendJSON(c, mainResponse(admission: admission) { $0.dictationProgress(obj) })
        case "dictate_translate":
            sendJSON(c, stateChangeResponse(admission: admission) {
                $0.onDictateTranslate(targetLanguage: obj["target_language"] as? String ?? "")
            })
        case "voice_chat":
            sendJSON(c, stateChangeResponse(admission: admission) { $0.onVoiceChat() })
        case "open_inbox":
            DispatchQueue.main.async { [weak self] in
                withExtendedLifetime(admission) { self?.app?.onOpenInbox() }
            }
            sendJSON(c, ["ok": true])
        case "open_agent_console":
            DispatchQueue.main.async { [weak self] in
                withExtendedLifetime(admission) { self?.app?.onOpenAgentConsole() }
            }
            sendJSON(c, ["ok": true])
        case "open_voice_chat":
            sendJSON(c, mainResponse(admission: admission) {
                $0.openVoiceChatWindow(urlString: obj["url"] as? String)
                return ["ok": true].merging($0.voiceChatWindowStatus()) { _, new in new }
            })
        case "paste_clipboard":
            sendJSON(c, mainResponse(admission: admission, timeoutError: "paste_timeout") {
                $0.pasteClipboard(
                    text: obj["text"] as? String,
                    targetBundleId: obj["target_bundle_id"] as? String,
                    targetAppName: obj["target_app_name"] as? String
                )
            })
        case "preview_sound":
            sendJSON(c, mainResponse(admission: admission) {
                $0.previewFeedbackSound()
                return ["ok": true, "enabled": feedbackSoundsEnabled()]
            })
        case "search":
            // Shell out to python3 -m search.ipc_helper. Keeps all FTS5
            // logic in Python so the Swift binary doesn't need to bind
            // SQLite + FTS5 + the trigram tokenizer. Bounded timeout so
            // a runaway query can't pin the IPC server.
            sendJSON(c, searchResponse(obj: obj, data: data))
        default:
            sendJSON(c, ["ok": false, "error": "unknown_action: \(action)"])
        }
    }

    /// Spawn `python3 -m search.ipc_helper`, pipe the raw request JSON
    /// to stdin, read JSON response from stdout (3s timeout). Returns
    /// a fallback error envelope on any failure so the client always
    /// gets a valid response.
    private func searchResponse(obj: [String: Any], data: Data) -> [String: Any] {
        // Precedence rule: YULU_SCRIPT_DIR
        // env wins so a launchd-installed bundle can point at a different
        // tree (e.g. a PR-branch worktree being smoke-tested) without a
        // rebuild. Falls back to bundle-relative for the production install.
        let scriptsDir = nativeEnvironment["YULU_SCRIPT_DIR"]
            ?? (Bundle.main.bundlePath.hasSuffix(".app")
                ? (Bundle.main.bundleURL
                    .deletingLastPathComponent()      // /scripts
                    .path)
                : URL(fileURLWithPath: CommandLine.arguments[0])
                    .deletingLastPathComponent().path)

        let task = yuluPythonProcess(scriptDir: scriptsDir)
        task.arguments = ["-m", "search.ipc_helper"]

        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        task.standardInput = stdinPipe
        task.standardOutput = stdoutPipe
        task.standardError = stderrPipe

        do {
            try nativeWork.run(task)
        } catch {
            return ["ok": false, "error": "search helper spawn failed: \(error)"]
        }

        // Write the original request bytes (so we don't re-serialize and
        // risk losing ordering or precision) then close stdin so the
        // helper sees EOF.
        do {
            try stdinPipe.fileHandleForWriting.write(contentsOf: data)
            try stdinPipe.fileHandleForWriting.close()
        } catch {
            try? stdinPipe.fileHandleForWriting.close()
            if task.isRunning { task.terminate() }
            return ["ok": false, "error": "search helper closed request input"]
        }

        // Bounded wait — 3s is generous for a 38-doc corpus (~50ms p50).
        let deadline = Date().addingTimeInterval(3.0)
        while task.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if task.isRunning {
            task.terminate()
            return ["ok": false, "error": "search helper timed out"]
        }
        let out = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
        let firstLine = out.split(separator: 0x0A, maxSplits: 1).first ?? Data()
        if firstLine.isEmpty {
            let err = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            let errStr = String(data: err, encoding: .utf8) ?? "<no stderr>"
            return ["ok": false, "error": "search helper empty stdout: \(errStr)"]
        }
        if let parsed = try? JSONSerialization.jsonObject(with: Data(firstLine))
                as? [String: Any] {
            return parsed
        }
        return ["ok": false, "error": "search helper returned invalid JSON"]
    }

    private func permissionStatusResponse() -> [String: Any] {
        let condition = NSCondition()
        var response: [String: Any]?
        DispatchQueue.main.async { [weak self] in
            guard let app = self?.app else {
                condition.lock()
                response = ["ok": false, "error": "controls_unavailable"]
                condition.signal()
                condition.unlock()
                return
            }
            let access = app.inputAccessCheck()
            let hotkeysReady = app.modifierHotkeys.isReady
            YuluNotificationPresenter.shared.permissionStatus { notifications in
                condition.lock()
                response = ["ok": true,
                    "macos_major": ProcessInfo.processInfo.operatingSystemVersion.majorVersion,
                    "accessibility_trusted": access.trusted,
                    "event_posting_allowed": access.posting,
                    "hotkeys_ready": hotkeysReady,
                    "notifications": notifications]
                condition.signal()
                condition.unlock()
            }
        }
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(2)
        while response == nil {
            if !condition.wait(until: deadline), response == nil {
                return ["ok": false, "error": "permissions_timeout"]
            }
        }
        return response!
    }

    private func statusResponse() -> [String: Any] {
        mainResponse(admission: nil) { app in
            var resp: [String: Any] = ["ok": true]
            resp["state"] = app.state.rawValue
            resp["dictation_active"] = app.activeRecordingIsDictation
            let inputAccess = app.inputAccessCheck()
            resp["accessibility_trusted"] = inputAccess.trusted
            resp["event_posting_allowed"] = inputAccess.posting
            if app.activeRecordingIsDictation {
                resp["dictation_intent"] = activeDictationIntent()
            }
            let pids = app.activeLauncherPids()
            if let pid = pids.first { resp["launcher_pid"] = Int(pid) }
            if !pids.isEmpty { resp["launcher_pids"] = pids.map { Int($0) } }
            resp.merge(app.voiceChatWindowStatus()) { _, new in new }
            return resp
        }
    }

    private func stateChangeResponse(
        admission: NativeWork.Admission?,
        action: @escaping (StatusAgentApp) -> Void
    ) -> [String: Any] {
        mainResponse(admission: admission) { app in
            let before = app.state.rawValue
            action(app)
            return ["ok": true, "state_before": before, "state_after": app.state.rawValue]
        }
    }

    private func mainResponse(
        admission: NativeWork.Admission?,
        timeoutError: String = "controls_timeout",
        action: @escaping (StatusAgentApp) -> [String: Any]
    ) -> [String: Any] {
        let condition = NSCondition()
        var response: [String: Any]?
        var cancelled = false
        DispatchQueue.main.async { [weak self] in
            withExtendedLifetime(admission) {
                condition.lock()
                defer { condition.unlock() }
                guard !cancelled else { return }
                response = self?.app.map(action) ?? ["ok": false, "error": "controls_unavailable"]
                condition.signal()
            }
        }
        condition.lock()
        defer { condition.unlock() }
        let deadline = Date().addingTimeInterval(3)
        while response == nil {
            if !condition.wait(until: deadline), response == nil {
                cancelled = true
                return ["ok": false, "error": timeoutError]
            }
        }
        return response!
    }

    private func sendJSON(_ c: Int32, _ obj: [String: Any]) {
        guard var data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return
        }
        data.append(0x0A)
        _ = data.withUnsafeBytes { buf in write(c, buf.baseAddress, buf.count) }
    }
}

class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var inputAccessCheck: () -> (trusted: Bool, posting: Bool) = {
        (AXIsProcessTrusted(), CGPreflightPostEventAccess())
    }
    var openRoute: ((String) -> Void)?
    private var configurationGeneration = 0
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var voiceChatWindow: NSWindow?
    var voiceOverlayWindow: NSPanel?
    let voiceOverlayMotion = VoiceOverlayMotion()
    var voiceFeedbackWindow: NSPanel?
    let voiceFeedbackMotion = VoiceOverlayMotion()
    var voiceOverlayLabel: NSTextField?
    var voiceOverlayWave: VoiceWaveView?
    var voiceOverlayStopButton: NSButton?
    var voiceOverlayCancelButton: NSButton?
    var voiceRecoveryText: String?
    let feedbackPlayer = VoiceFeedbackPlayer()
    var processingDetailWorkItem: DispatchWorkItem?
    var feedbackDismissWorkItem: DispatchWorkItem?
    var feedbackVisibleUntil: Date?
    var pendingStartFeedbackText: String?
    var holdGesture = VoiceHoldGesture()
    var heldHotkey: HotkeySpec?
    var pendingVoiceStop: (() -> Void)?
    var voiceCommandGeneration = UUID()
    private let voiceCommandQueue = DispatchQueue(label: "com.yulu.voice-command", qos: .userInitiated)
    private var voiceLaunchPending = false
    private var voiceCancellationPending = false
    private var canceledVoicePids: Set<Int32> = []
    private var pendingVoiceRestart: (() -> Void)?
    var voiceCommandStartedAt: [Int32: TimeInterval] = [:]
    // ponytail: one pending dictation target; add per-session IDs if overlapping dictations need exact cursor restore.
    var capturedPasteTarget: CapturedPasteTarget?
    var pollerTimer: Timer?
    var state: AgentState = .daemonDown
    var activeRecordingIsDictation = false
    var daemonDownStreak: Int = 0
    var launcherPids: [Int32] = []
    var voiceLauncherPids: [Int32] = []
    var resultManagedLauncherPids: Set<Int32> = []
    var hotkeyRegistrars: [HotkeyRegistrar] = []
    var modifierHotkeys = ModifierHotkeyMonitor()
    var shortcutEditingUntil = Date.distantPast
    var sighupSource: DispatchSourceSignal?
    // IPC server exposing `status` / `toggle` / `open_inbox` on
    // ~/.config/yulu/status_agent.sock. Lets `yulu status-agent toggle`
    // and acceptance tests drive the agent without UI clicks.
    var ipcServer: IPCServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        do { try startNativeControls() }
        catch {
            log("Native recording controls could not start: \(error.localizedDescription)")
            NSApp.terminate(nil)
        }
    }

    func prepareNativeControls() throws {
        guard ipcServer == nil else { return }
        // A departed IPC client or helper is a failed request, not a shell crash.
        signal(SIGPIPE, SIG_IGN)
        for directory in [DURABLE_DATA_DIR, IPC_DIR, LOGS_DIR, loadRecordingDir()] {
            try FileManager.default.createDirectory(
                atPath: directory,
                withIntermediateDirectories: true
            )
        }
        let ipc = IPCServer(app: self)
        try ipc.start()
        ipcServer = ipc
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")
    }

    func startNativeControls() throws {
        try prepareNativeControls()
        activeAppLanguage = readAppLanguage()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = ""
            btn.toolTip = L("Yulu — 点击开始录制", "Yulu — click to record")
        }
        rebuildMenu()
        _ = prepareVoiceOverlay()
        if embeddedEnvironment == nil {
            _ = RecordingLauncher.launchWarmDictation()
            _ = RecordingLauncher.launchWarmDictation(targetLanguage: dictationTargetLanguage(fallback: "English"))
        }
        signal(SIGHUP, SIG_IGN)
        sighupSource = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
        sighupSource?.setEventHandler { [weak self] in
            log("SIGHUP received — refreshing menu and hotkeys")
            activeAppLanguage = readAppLanguage()
            self?.rebuildMenu()
        }
        sighupSource?.resume()

        // IPC server: start BEFORE the initial poll(). poll() does a
        // blocking read from audio_daemon — if audiodaemon's accept queue
        // is full (a known failure mode under high poll traffic) the read
        // hangs and would otherwise prevent IPC from ever coming up. By
        // ordering IPC first we guarantee the agent stays addressable
        // even when audiodaemon is sick.
        // Start polling at 1 Hz
        pollerTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()  // immediate first tick
    }

    private func rebuildMenu() {
        menu = MenuBuilder.build(target: self)
        menu.delegate = self
        statusItem.menu = menu
        statusItem.button?.toolTip = L("Yulu — 点击开始录制", "Yulu — click to record")
        registerHotkeysFromConfig()
        applyState(state)
    }

    private func registerHotkeysFromConfig() {
        configurationGeneration += 1
        let generation = configurationGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let specs = readHotkeysFromConfig()
            DispatchQueue.main.async {
                guard let self, self.configurationGeneration == generation else { return }
                self.registerHotkeys(specs)
            }
        }
    }

    private func registerHotkeys(_ specs: [HotkeySpec]) {
        // A replaced Carbon registration cannot deliver the old key release.
        // Finish that gesture now, or queue its stop until capture starts.
        if let spec = heldHotkey, holdGesture.release() {
            heldHotkey = nil
            performVoiceAction(spec)
        }
        hotkeyRegistrars.forEach { $0.unregister() }
        hotkeyRegistrars = []
        modifierHotkeys.configure(specs.filter { $0.usesModifierMonitor }) { [weak self] spec, down in
            self?.onHotkey(spec, down: down)
        }
        for (idx, spec) in specs.enumerated() {
            let registrar = HotkeyRegistrar(id: UInt32(idx + 1))
            let ok = !spec.usesModifierMonitor && registrar.register(keyCode: spec.keyCode, modifierMask: spec.modifierMask) { [weak self] down in
                self?.onHotkey(spec, down: down)
            }
            if ok { hotkeyRegistrars.append(registrar) }
            let identifier: String
            switch spec.action {
            case "dictate": identifier = "dictate_once"
            case "translate": identifier = "dictate_translate"
            case "voice_chat": identifier = "voice_chat"
            default: continue
            }
            if let item = menu.items.first(where: {
                $0.identifier == NSUserInterfaceItemIdentifier(identifier)
            }) {
                item.keyEquivalent = ok ? menuKeyEquivalent(for: spec.label) : ""
                item.keyEquivalentModifierMask = menuModifierFlags(for: spec.modifierMask)
                if spec.action == "translate" {
                    let target = targetLanguageDisplayName(spec.targetLanguage)
                    item.title = L("翻译为\(target)", "Translate to \(target)")
                }
            }
        }
    }

    private func onHotkey(_ spec: HotkeySpec, down: Bool) {
        guard nativeWork.isAccepting else { return }
        guard Date() >= shortcutEditingUntil else { return }
        if spec.inputMode == "hold" {
            if down {
                guard state != .recording, pendingStartFeedbackText == nil,
                      resultManagedLauncherPids.isEmpty, heldHotkey == nil,
                      holdGesture.begin() else { return }
                heldHotkey = spec
            } else {
                guard heldHotkey?.action == spec.action, holdGesture.release() else { return }
                heldHotkey = nil
            }
        } else if !down { return }
        performVoiceAction(spec)
    }

    private func finishPendingHoldIfNeeded() {
        if let stop = pendingVoiceStop {
            pendingVoiceStop = nil
            stop()
            return
        }
        guard let spec = heldHotkey, holdGesture.started() else { return }
        heldHotkey = nil
        performVoiceAction(spec)
    }

    private func performVoiceAction(_ spec: HotkeySpec) {
        log("hotkey → \(spec.action)")
        switch spec.action {
        case "dictate":
            onDictateToggle()
        case "translate":
            onDictateTranslate(targetLanguage: spec.targetLanguage)
        case "voice_chat":
            onVoiceChat()
        default:
            break
        }
    }

    private func poll() {
        modifierHotkeys.retryIfNeeded()
        // Move the blocking socket round-trip OFF the main thread.
        // DaemonClient.send does a blocking read with no timeout — when
        // audio_daemon's accept queue is starved (a documented failure
        // mode under sustained polling) the read hangs forever. If poll()
        // runs on main, that hang freezes NSApplication.run() and the
        // entire UI + IPC main-queue dispatches die with it.
        let generation = voiceCommandGeneration
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let resp = DaemonClient.send(["action": "status"])
            DispatchQueue.main.async { [weak self] in
                guard self?.voiceCommandGeneration == generation else { return }
                self?.applyPollResult(resp)
            }
        }
    }

    private func applyPollResult(_ resp: [String: Any]?) {
        guard !voiceCancellationPending else { return }
        guard let resp = resp else {
            daemonDownStreak += 1
            if daemonDownStreak >= 3 {
                applyState(.daemonDown)
            }
            return
        }
        daemonDownStreak = 0
        let recording = (resp["recording"] as? Bool) ?? false
        if let micLevel = resp["micLevel"] as? NSNumber {
            voiceOverlayWave?.level = normalizedMicLevel(micLevel.doubleValue)
        }

        if voiceLaunchPending || !resultManagedLauncherPids.isEmpty {
            applyState(.processing)
            return
        }
        if recording {
            let file = (resp["file"] as? String) ?? ""
            activeRecordingIsDictation = file.hasPrefix("\(DICTATION_MEDIA_DIR)/")
            applyState(.recording)
            if activeRecordingIsDictation, let text = pendingStartFeedbackText {
                pendingStartFeedbackText = nil
                showVoiceOverlay(text, animation: .recording)
                feedbackPlayer.play(.start)
            }
            if activeRecordingIsDictation && !activeDictationIntent().isEmpty { finishPendingHoldIfNeeded() }
            return
        }
        activeRecordingIsDictation = false

        // Not recording. A previous stop may still be transcribing/enqueueing,
        // but that must not block the next start: audio_daemon is the source of
        // truth for whether the capture lane is busy.
        if pendingStartFeedbackText != nil || !activeLauncherPids().isEmpty {
            applyState(.processing)
            return
        }
        applyState(.idle)
    }

    @discardableResult
    func activeLauncherPids() -> [Int32] {
        let active = launcherPids.filter { resultManagedLauncherPids.contains($0) || pidIsActive($0) }
        if active.count != launcherPids.count { launcherPids = active }
        voiceLauncherPids = voiceLauncherPids.filter { active.contains($0) || pidIsActive($0) }
        return active
    }

    private func activeVoiceLauncherPids() -> [Int32] {
        let active = voiceLauncherPids.filter { pidIsActive($0) }
        if active.count != voiceLauncherPids.count { voiceLauncherPids = active }
        return active
    }

    private func pidIsActive(_ pid: Int32) -> Bool {
        var status: Int32 = 0
        let waited = waitpid(pid, &status, WNOHANG)
        if waited == pid { return false }
        if waited == 0 { return kill(pid, 0) == 0 }
        return errno != ECHILD && errno != ESRCH && kill(pid, 0) == 0
    }

    private func showVoiceOverlay(_ text: String, wave: Bool) {
        showVoiceOverlay(text, animation: wave ? .recording : .processing)
    }

    @discardableResult
    private func prepareVoiceOverlay(feedback: Bool = false) -> (NSPanel, VoiceOverlayContentView) {
        let panel: NSPanel
        let visual: VoiceOverlayContentView
        if let existing = feedback ? voiceFeedbackWindow : voiceOverlayWindow,
           let content = existing.contentView as? VoiceOverlayContentView {
            panel = existing
            visual = content
        } else {
            panel = NSPanel(contentRect: NSRect(origin: .zero, size: VoiceOverlayContentView.capsuleSize),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.hidesOnDeactivate = false
            panel.ignoresMouseEvents = false
            panel.title = feedback ? L("Yulu 语音输入提醒", "Yulu Voice Input Notice") : L("Yulu 语音输入", "Yulu Voice Input")
            panel.setAccessibilityElement(true)
            panel.setAccessibilityRole(.window)
            panel.setAccessibilityLabel(panel.title)
            visual = VoiceOverlayContentView(frame: panel.contentView?.bounds ?? .zero)
            visual.autoresizingMask = [.width, .height]
            visual.stopButton.target = self
            visual.stopButton.action = #selector(stopVoiceInputFromOverlay)
            visual.cancelButton.target = self
            visual.cancelButton.action = feedback ? #selector(dismissVoiceFeedback) : #selector(cancelVoiceInputFromOverlay)
            visual.copyButton.target = self
            visual.copyButton.action = #selector(copyVoiceRecoveryText)
            visual.permissionButton.target = self
            visual.permissionButton.action = #selector(openVoiceInputAccessSettings)
            panel.contentView = visual
            if feedback {
                voiceFeedbackWindow = panel
            } else {
                voiceOverlayWindow = panel
                voiceOverlayLabel = visual.statusLabel
                voiceOverlayWave = visual.waveView
                voiceOverlayStopButton = visual.stopButton
                voiceOverlayCancelButton = visual.cancelButton
            }
        }
        return (panel, visual)
    }

    private func showVoiceOverlay(
        _ text: String, animation: VoiceOverlayAnimationMode,
        hint: String? = nil, transcript: String = "", needsInputAccess: Bool = false
    ) {
        let feedback = animation == .recovery || animation == .failure
        let (panel, visual) = prepareVoiceOverlay(feedback: feedback)
        let motion = feedback ? voiceFeedbackMotion : voiceOverlayMotion
        if feedback { hideVoiceCapsule() } else { hideVoiceFeedback() }
        voiceRecoveryText = animation == .recovery ? transcript : nil
        let subtitle = hint ?? (animation == .recording
            ? (heldHotkey != nil ? L("松开快捷键结束", "Release shortcut to finish") : L("再次按快捷键结束", "Press shortcut again to finish"))
            : animation == .processing ? L("正在处理这段录音", "Processing your recording") : "")
        let size = visual.update(title: text, hint: subtitle, mode: animation, transcript: transcript, needsInputAccess: needsInputAccess)
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let target = NSRect(x: f.midX - size.width / 2, y: f.minY + 86, width: size.width, height: size.height)
            if panel.isVisible && motion.phase == .visible
                && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.18
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    panel.animator().setFrame(target, display: true)
                }
            } else { panel.setFrame(target, display: true) }
        }
        visual.layoutSubtreeIfNeeded()
        panel.ignoresMouseEvents = false
        motion.show(visual)
        panel.orderFrontRegardless()
        panel.displayIfNeeded()
    }

    private func showVoiceRecovery(_ text: String, copied: Bool, needsInputAccess: Bool = false) {
        processingDetailWorkItem?.cancel()
        feedbackDismissWorkItem?.cancel()
        // Keep the result available until dismissed or the next capture starts.
        feedbackVisibleUntil = .distantFuture
        applyState(.idle)
        showVoiceOverlay(L("文字已识别", "Your text is ready"), animation: .recovery,
            hint: needsInputAccess ? L("需开启输入权限，才能自动粘贴", "Enable input access to paste automatically")
                : copied ? L("请确认输入框，也可按 ⌘V 粘贴", "Check the field, or paste with ⌘V")
                : L("未能自动输入，可复制后粘贴", "Copy your text to paste it"),
            transcript: text, needsInputAccess: needsInputAccess)
    }

    @objc private func openVoiceInputAccessSettings() {
        _ = openPermissionSettings("input")
    }

    func openPermissionSettings(_ permission: String) -> Bool {
        // Fixed destinations only; never open a caller-provided URL.
        let pane: String
        switch permission {
        case "microphone": pane = "com.apple.preference.security?Privacy_Microphone"
        case "systemAudio": pane = "com.apple.preference.security?Privacy_ScreenCapture"
        case "input":
            pane = "com.apple.preference.security?Privacy_Accessibility"
            // Register Yulu itself so first-time users can find it in the list.
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case "notifications":
            return YuluNotificationPresenter.shared.requestPermissionOrOpenSettings()
        default: return false
        }
        guard let url = URL(string: "x-apple.systempreferences:\(pane)") else { return false }
        return NSWorkspace.shared.open(url)
    }

    @objc private func copyVoiceRecoveryText() {
        guard let text = voiceRecoveryText, let visual = voiceFeedbackWindow?.contentView as? VoiceOverlayContentView else { return }
        if copyRecoveryText(text) {
            visual.copyButton.title = L("已复制", "Copied")
            visual.hintLabel.stringValue = L("回到输入框，按 ⌘V 粘贴", "Return to your text field and press ⌘V")
        } else {
            visual.hintLabel.stringValue = L("复制未完成，请重试", "Could not copy. Try again")
        }
    }

    private func hideVoiceOverlay(canceled: Bool = false) {
        voiceRecoveryText = nil
        hideVoiceFeedback()
        hideVoiceCapsule(canceled: canceled)
    }

    @objc private func dismissVoiceFeedback() {
        feedbackDismissWorkItem?.cancel()
        feedbackVisibleUntil = nil
        voiceRecoveryText = nil
        hideVoiceFeedback()
    }

    private func hideVoiceFeedback() {
        guard let panel = voiceFeedbackWindow, let visual = panel.contentView else { return }
        panel.ignoresMouseEvents = true
        voiceFeedbackMotion.hide(visual) { [weak panel] in panel?.orderOut(nil) }
    }

    private func hideVoiceCapsule(canceled: Bool = false) {
        guard let panel = voiceOverlayWindow, let visual = panel.contentView else { return }
        // Repeated idle polls must not restart the exit. A new show invalidates
        // this completion, so an old session cannot hide the next capsule.
        panel.ignoresMouseEvents = true
        voiceOverlayMotion.hide(visual, canceled: canceled) { [weak self, weak panel] in
            self?.voiceOverlayWave?.mode = .none
            panel?.orderOut(nil)
        }
    }

    private func showTimedVoiceFeedback(
        _ text: String,
        sound: VoiceFeedbackSound?,
        duration: TimeInterval
    ) {
        processingDetailWorkItem?.cancel()
        feedbackDismissWorkItem?.cancel()
        // Successful or unconfirmed dispatch needs no text popup. Only an
        // actionable exception gets a readable, separate notification panel.
        guard sound == .failure else {
            feedbackVisibleUntil = nil
            hideVoiceOverlay()
            applyState(.idle)
            if let sound { feedbackPlayer.play(sound) }
            return
        }
        feedbackVisibleUntil = Date().addingTimeInterval(duration)
        applyState(.idle)
        showVoiceOverlay(text, animation: .failure)
        if let sound { feedbackPlayer.play(sound) }
        let dismiss = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.feedbackVisibleUntil = nil
            if self.state == .idle { self.hideVoiceOverlay() }
        }
        feedbackDismissWorkItem = dismiss
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: dismiss)
    }

    func dictationProgress(_ input: [String: Any]) -> [String: Any] {
        guard let rawPID = input["launcher_pid"] as? Int, let pid = Int32(exactly: rawPID),
              voiceLauncherPids.contains(pid) else { return ["ok": false, "error": "stale_dictation"] }
        let stage = input["stage"] as? String ?? ""
        if stage == "recording" {
            let path = input["audio_path"] as? String ?? ""
            guard path.hasPrefix("\(DICTATION_MEDIA_DIR)/"), !resultManagedLauncherPids.contains(pid) else {
                return ["ok": false, "error": "invalid_capture_feedback"]
            }
            if let started = voiceCommandStartedAt[pid] {
                log("dictation capture ready startup_ms=\(Int((ProcessInfo.processInfo.systemUptime - started) * 1000))")
            }
            if pendingStartFeedbackText != nil { applyPollResult(["recording": true, "file": path]) }
            return ["ok": true]
        }
        guard state == .processing, resultManagedLauncherPids.contains(pid) else {
            return ["ok": false, "error": "stale_dictation"]
        }
        let labels = [
            "transcribing": L("正在完成识别…", "Finishing transcription…"),
            "cleaning": L("正在整理文字…", "Editing text…"),
            "translating": L("正在翻译…", "Translating…"),
            "inserting": L("正在输入…", "Inserting…"),
        ]
        guard let label = labels[stage] else { return ["ok": false, "error": "invalid_stage"] }
        processingDetailWorkItem?.cancel()
        showVoiceOverlay(label, animation: .processing)
        return ["ok": true]
    }

    private func scheduleStartConfirmationPolls() {
        // Fallback for older capture clients; current clients signal readiness.
        for delay in [0.1, 0.3, 0.5, 0.75] {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard self?.pendingStartFeedbackText != nil else { return }
                self?.poll()
            }
        }
    }

    @objc private func stopVoiceInputFromOverlay() {
        guard state == .recording && activeRecordingIsDictation else { return }
        if activeDictationIntent() == "voice_chat" {
            onVoiceChat()
        } else {
            onDictateToggle()
        }
    }

    @objc private func cancelVoiceInputFromOverlay() {
        if voiceRecoveryText != nil {
            feedbackVisibleUntil = nil
            hideVoiceOverlay(canceled: true)
            return
        }
        pendingVoiceRestart = nil
        pendingVoiceStop = nil
        holdGesture.cancel()
        heldHotkey = nil
        if voiceCancellationPending {
            hideVoiceOverlay(canceled: true)
            return
        }
        guard let admission = nativeWork.admit() else { return }
        voiceCommandGeneration = UUID()
        voiceCancellationPending = true
        voiceLaunchPending = false
        pendingVoiceStop = nil
        pendingStartFeedbackText = nil
        canceledVoicePids.formUnion(voiceLauncherPids)
        let canceled = Set(voiceLauncherPids)
        launcherPids.removeAll { canceled.contains($0) }
        voiceLauncherPids.removeAll()
        resultManagedLauncherPids.subtract(canceled)
        feedbackDismissWorkItem?.cancel()
        processingDetailWorkItem?.cancel()
        feedbackVisibleUntil = nil
        activeRecordingIsDictation = false
        capturedPasteTarget = nil
        holdGesture.cancel()
        heldHotkey = nil
        hideVoiceOverlay(canceled: true)
        applyState(.idle)
        log("voice overlay cancel clicked — draining active voice input")
        // Serial with preparation/spawn. A requested restart remains queued
        // until cancellation has actually stopped the old capture.
        voiceCommandQueue.async { [weak self] in
            guard let self else { return }
            let pids = DispatchQueue.main.sync { self.canceledVoicePids }
            let complete: RecordingLauncher.DictationCompletion = { [weak self] result, _, status in
                withExtendedLifetime(admission) {
                    guard let self else { return }
                    self.voiceCancellationPending = false
                    self.canceledVoicePids.removeAll()
                    let restart = self.pendingVoiceRestart
                    self.pendingVoiceRestart = nil
                    if status == 0 && result?["canceled"] as? Bool == true && result?["audio_status_error"] == nil {
                        restart?()
                    } else {
                        self.pendingVoiceStop = nil
                        self.holdGesture.cancel()
                        self.heldHotkey = nil
                        self.showTimedVoiceFeedback(L("未能结束录音，请重试", "Could not stop recording. Try again"),
                            sound: .failure, duration: 3)
                    }
                }
            }
            guard nativeWork.terminateVoiceProcesses(pids) else {
                DispatchQueue.main.async { complete(nil, "cancel_drain_failed", -1) }
                return
            }
            if RecordingLauncher.launchDictateCancel(completion: complete) == nil {
                DispatchQueue.main.async { complete(nil, "cancel_launch_failed", -1) }
            }
        }
    }

    private func applyState(_ new: AgentState) {
        state = new
        let feedbackStillVisible = feedbackVisibleUntil.map { $0 > Date() } ?? false
        if new == .daemonDown || (new == .idle && !feedbackStillVisible) {
            hideVoiceOverlay()
        }
        if let btn = statusItem.button {
            if let img = IconStateMachine.image(for: new) {
                btn.image = img
                btn.title = ""
            } else {
                let symbol: String
                switch new {
                case .idle, .meetingBusy: symbol = "quote.bubble.fill"
                case .recording: symbol = "record.circle.fill"
                case .processing: symbol = "ellipsis.circle.fill"
                case .daemonDown: symbol = "exclamationmark.circle.fill"
                }
                btn.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "Yulu")
                btn.title = ""
            }
            if new == .meetingBusy {
                btn.alphaValue = 0.4  // greyed-out
            } else {
                btn.alphaValue = 1.0
            }
        }
        // Update the menu's toggle label (use items.first since NSMenu has
        // no item(withIdentifier:) API)
        let wantId = NSUserInterfaceItemIdentifier("toggle")
        if let item = menu.items.first(where: { $0.identifier == wantId }) {
            switch new {
            case .idle:        item.title = L("开始录制", "Start Recording")
            case .recording:   item.title = activeRecordingIsDictation ? L("听写进行中", "Dictation in Progress") : L("停止录制", "Stop Recording")
            case .processing:  item.title = L("开始录制（上一条正在转写）", "Start Recording (transcribing previous)")
            case .meetingBusy: item.title = L("会议进行中", "Meeting in Progress")
            case .daemonDown:  item.title = L("音频服务不可用", "Audio Service Unavailable")
            }
            item.image = NSImage(
                systemSymbolName: new == .recording && !activeRecordingIsDictation
                    ? "stop.circle.fill"
                    : "record.circle",
                accessibilityDescription: nil
            )
            item.isEnabled = (new == .idle || (new == .recording && !activeRecordingIsDictation) || new == .processing)
        }
        let voiceChatActive = (new == .recording && activeRecordingIsDictation && activeDictationIntent() == "voice_chat")
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("dictate_once") }) {
            item.title = voiceChatActive
                ? L("语音对话进行中", "Voice Chat in Progress")
                : ((new == .recording && activeRecordingIsDictation) ? L("停止听写", "Stop Dictation") : L("开始听写", "Start Dictation"))
            item.isEnabled = (new == .idle || new == .processing || (new == .recording && activeRecordingIsDictation && !voiceChatActive))
        }
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("dictate_translate") }) {
            item.isEnabled = (new == .idle || new == .processing)
        }
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("voice_chat") }) {
            item.title = voiceChatActive ? L("停止语音对话", "Stop Voice Chat") : L("语音询问 Agent", "Ask Agent by Voice")
            item.isEnabled = (new == .idle || new == .processing || voiceChatActive)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        voiceCommandGeneration = UUID()
        pendingVoiceRestart = nil
        pollerTimer?.invalidate()
        configurationGeneration += 1
        pollerTimer = nil
        sighupSource?.cancel()
        sighupSource = nil
        processingDetailWorkItem?.cancel()
        feedbackDismissWorkItem?.cancel()
        voiceOverlayWindow?.close()
        voiceFeedbackWindow?.close()
        voiceChatWindow?.close()
        hotkeyRegistrars.forEach { $0.unregister() }
        modifierHotkeys.stop()
        if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
        statusItem = nil
        ipcServer?.stop()
        ipcServer = nil
        if (try? String(contentsOfFile: PID_FILE, encoding: .utf8)) == "\(getpid())" {
            try? FileManager.default.removeItem(atPath: PID_FILE)
        }
    }

    // Refresh dynamic items whenever the menu is about to display
    func menuWillOpen(_ menu: NSMenu) {
        refreshCurrentMeetingItems()

        let recents = loadRecentRecordings(limit: 5)
        let dateFormatter = DateFormatter()
        dateFormatter.locale = appLocale()
        dateFormatter.setLocalizedDateFormatFromTemplate("MMM d HH:mm")
        if let recentMenu = menu.items.first(where: {
            $0.identifier == NSUserInterfaceItemIdentifier("recent_recordings")
        })?.submenu {
            recentMenu.items.first(where: {
                $0.identifier == NSUserInterfaceItemIdentifier("recent_empty")
            })?.isHidden = !recents.isEmpty
            for i in 0..<5 {
                let wantId = NSUserInterfaceItemIdentifier("recent_\(i)")
                guard let item = recentMenu.items.first(where: { $0.identifier == wantId })
                    else { continue }
                if i < recents.count {
                    let r = recents[i]
                    let time = dateFormatter.string(from: r.mtime)
                    let name = shortMeetingTitle(r.title)
                    item.title = "\(time) \(name)"
                    item.attributedTitle = recentRecordingMenuTitle(time: time, name: name)
                    item.target = self
                    item.action = #selector(onRecentClicked(_:))
                    item.representedObject = r.stem
                    item.isHidden = false
                } else {
                    item.isHidden = true
                }
            }
        }
    }

    private func refreshCurrentMeetingItems() {
        let meeting = loadCurrentMeeting()
        let canStart = (state == .idle || state == .processing)
        let visible = meeting != nil

        let label = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("current_meeting_label") })
        let record = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("current_meeting_record") })
        let join = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("current_meeting_join") })
        let sep = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("current_meeting_separator") })
        let toggle = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("toggle") })

        label?.isHidden = !visible
        record?.isHidden = !visible
        sep?.isHidden = !visible
        if state == .idle {
            toggle?.title = visible ? L("开始无标题录制", "Start Untitled Recording") : L("开始录制", "Start Recording")
        }

        guard let meeting = meeting else {
            join?.isHidden = true
            return
        }

        let title = shortMeetingTitle(meeting.title)
        let endFormatter = DateFormatter()
        endFormatter.locale = appLocale()
        endFormatter.timeStyle = .short
        label?.title = L(
            "当前会议 · \(title) · \(endFormatter.string(from: meeting.end)) 结束",
            "Current Meeting · \(title) · Ends \(endFormatter.string(from: meeting.end))"
        )
        record?.title = L("录制此会议", "Record This Meeting")
        record?.representedObject = meeting.id
        record?.isEnabled = canStart

        join?.title = L("录制并加入", "Record and Join")
        join?.representedObject = meeting.id
        join?.isHidden = meeting.link.isEmpty
        join?.isEnabled = canStart
    }

    @objc func onMenuToggle() {
        guard nativeWork.isAccepting else { return }
        log("toggle (state=\(state.rawValue))")
        switch state {
        case .idle:
            startRecordingFromMenu()
        case .recording:
            if activeRecordingIsDictation {
                log("dictation recording active; ignoring meeting stop")
                return
            }
            // Keep displaying recording until the audio daemon confirms the
            // stop. Transcription progress belongs to the recording itself.
            _ = RecordingLauncher.launchStop()
        case .processing:
            log("starting next recording while previous processing continues")
            startRecordingFromMenu()
        case .meetingBusy:
            // Unreachable from the poller (any recording is now surfaced as
            // .recording), kept only for switch exhaustiveness.
            applyState(.recording)
        case .daemonDown:
            showDaemonDownNotification()
        }
    }

    private func startRecordingFromMenu() {
        let title = RecordingLauncher.defaultTitle()
        // The poller moves the UI only after the audio daemon confirms capture.
        _ = RecordingLauncher.launchStart(title: title)
    }

    func previewFeedbackSound() {
        feedbackPlayer.play(.success)
    }

    private func handleDictationCompletion(
        result: [String: Any]?,
        error: String,
        status: Int32,
        wasStopping: Bool,
        recordingText: String,
        pid: Int32?,
        generation: UUID
    ) {
        if let pid {
            if wasStopping, let started = voiceCommandStartedAt[pid] {
                log("dictation command complete stop_ms=\(Int((ProcessInfo.processInfo.systemUptime - started) * 1000))")
            }
            voiceCommandStartedAt.removeValue(forKey: pid)
            resultManagedLauncherPids.remove(pid)
            launcherPids.removeAll { $0 == pid }
            voiceLauncherPids.removeAll { $0 == pid }
        }
        guard generation == voiceCommandGeneration else { return }
        let isStartCompletion = !wasStopping && status == 0 && result?["action"] as? String == "start"
        if isStartCompletion && !resultManagedLauncherPids.isEmpty { return }
        processingDetailWorkItem?.cancel()
        if isStartCompletion {
            feedbackVisibleUntil = nil
            activeRecordingIsDictation = true
            applyState(.recording)
            showVoiceOverlay(recordingText, animation: .recording)
            if pendingStartFeedbackText != nil {
                pendingStartFeedbackText = nil
                feedbackPlayer.play(.start)
            }
            finishPendingHoldIfNeeded()
            return
        }

        pendingStartFeedbackText = nil
        pendingVoiceStop = nil
        activeRecordingIsDictation = false
        capturedPasteTarget = nil
        holdGesture.cancel()
        heldHotkey = nil
        let needsInputAccess = result?["error_code"] as? String == "accessibility_not_trusted"
        if wasStopping && status == 0 && result?["action"] as? String == "stop" {
            if result?["chat"] is [String: Any] {
                hideVoiceOverlay()
                applyState(.idle)
                return
            }
            log("dictation result success pasted=\(result?["pasted"] as? Bool == true) post_stop_ms=\(result?["post_stop_ms"] ?? 0)")
            let presentation = voiceResultPresentation(
                pasted: result?["pasted"] as? Bool == true,
                dispatched: result?["paste_dispatched"] as? Bool == true,
                failed: !(result?["error_code"] as? String ?? "").isEmpty)
            if presentation == .dismiss {
                feedbackDismissWorkItem?.cancel()
                feedbackVisibleUntil = nil
                hideVoiceOverlay()
                applyState(.idle)
                feedbackPlayer.play(.success)
            } else if presentation == .unconfirmed {
                // Sending a paste is not proof it landed, but is also not a
                // failure. Don't open a recovery panel or encourage duplicates.
                showTimedVoiceFeedback(L("文字已发送，可在历史中找回", "Text sent · Saved in history"), sound: nil, duration: 1.2)
            } else if result?["copied"] as? Bool == true {
                if let text = result?["text"] as? String, !text.isEmpty {
                    showVoiceRecovery(text, copied: true, needsInputAccess: needsInputAccess)
                    return
                }
                let attempted = result?["paste_dispatched"] as? Bool == true
                showTimedVoiceFeedback(attempted
                    ? L("已尝试输入 · 请确认，文字已复制", "Insertion attempted · Check the field; text copied")
                    : L("已复制，请按 ⌘V", "Copied — press ⌘V"), sound: .failure, duration: 3.5)
            } else {
                if let text = result?["text"] as? String, !text.isEmpty {
                    showVoiceRecovery(text, copied: false, needsInputAccess: needsInputAccess)
                    return
                }
                showTimedVoiceFeedback(L("听写完成，未自动输入", "Dictation complete — not inserted"), sound: .failure, duration: 3.5)
            }
            return
        }

        if let text = result?["text"] as? String, !text.isEmpty {
            showVoiceRecovery(text, copied: result?["copied"] as? Bool == true, needsInputAccess: needsInputAccess)
            return
        }
        let code = result?["error_code"] as? String ?? "transcription_failed"
        let message: String
        if !wasStopping {
            message = L("无法开始听写", "Could not start dictation")
        } else if code == "no_speech" {
            message = L("没有听到清晰语音", "No clear speech detected")
        } else if code == "paste_failed" {
            message = L("已复制，请按 ⌘V", "Copied — press ⌘V")
        } else {
            message = L("听写失败 · 录音已保留", "Dictation failed · Recording saved")
        }
        log("dictation result failure status=\(status) code=\(code) error=\(error)")
        showTimedVoiceFeedback(message, sound: .failure, duration: code == "no_speech" ? 2.5 : 4.0)
        poll()
    }

    private func launchVoiceCommand(_ kind: VoiceCommandKind, stopping: Bool, recordingText: String) {
        guard let admission = nativeWork.admit() else { return }
        let commandStartedAt = ProcessInfo.processInfo.systemUptime
        // Snapshot the app before showing even our nonactivating panel. AX
        // queries and process creation happen after the first visual response.
        let front = stopping ? nil : NSWorkspace.shared.frontmostApplication
        let receipt = VoiceLaunchReceipt()
        voiceCommandGeneration = UUID()
        let generation = voiceCommandGeneration
        voiceLaunchPending = true
        feedbackDismissWorkItem?.cancel()
        feedbackVisibleUntil = nil
        if stopping {
            holdGesture.cancel()
            heldHotkey = nil
        } else {
            pendingStartFeedbackText = recordingText
            capturedPasteTarget = nil
        }
        applyState(.processing)
        showVoiceOverlay(stopping ? L("正在完成识别…", "Finishing transcription…") : L("正在启动…", "Starting…"),
            animation: stopping ? .processing : .starting)
        log("voice capsule response_ms=\(Int((ProcessInfo.processInfo.systemUptime - commandStartedAt) * 1000))")

        voiceCommandQueue.async { [weak self] in
            defer { withExtendedLifetime(admission) {} }
            guard let self else { return }
            let wantsTarget: Bool
            if case .chat = kind { wantsTarget = false } else { wantsTarget = !stopping }
            let target = wantsTarget ? self.currentInputTargetApplication(preferred: front) : nil
            let pasteTarget = wantsTarget ? self.capturePasteTarget(for: target) : nil
            let current = DispatchQueue.main.sync { () -> Bool in
                guard self.voiceCommandGeneration == generation else { return false }
                if !stopping { self.capturedPasteTarget = pasteTarget }
                return true
            }
            guard current else { return }
            let completion: RecordingLauncher.DictationCompletion = { [weak self] result, error, status in
                let deliver: () -> Void = { [weak self] in
                    self?.handleDictationCompletion(result: result, error: error, status: status,
                        wasStopping: stopping, recordingText: recordingText, pid: receipt.pid, generation: generation)
                }
                if receipt.registered { deliver() }
                else { receipt.earlyCompletion = deliver }
            }
            let pid: Int32?
            switch kind {
            case .dictate:
                pid = RecordingLauncher.launchDictateToggle(targetBundleId: target?.bundleIdentifier ?? "",
                    targetAppName: target?.localizedName ?? "", completion: completion)
            case .translate(let language):
                pid = RecordingLauncher.launchDictateTranslateToggle(targetLanguage: language,
                    targetBundleId: target?.bundleIdentifier ?? "", targetAppName: target?.localizedName ?? "",
                    completion: completion)
            case .chat:
                pid = RecordingLauncher.launchVoiceChatToggle(completion: completion)
            }
            DispatchQueue.main.sync {
                receipt.pid = pid
                receipt.registered = true
                if self.voiceCommandGeneration == generation {
                    self.voiceLaunchPending = false
                    if let pid {
                        self.launcherPids.append(pid)
                        self.voiceLauncherPids.append(pid)
                        self.voiceCommandStartedAt[pid] = commandStartedAt
                        if stopping { self.resultManagedLauncherPids.insert(pid) }
                        else { self.scheduleStartConfirmationPolls() }
                    }
                } else if let pid {
                    // Cancel may have arrived between validation and spawn.
                    self.canceledVoicePids.insert(pid)
                }
                if let early = receipt.earlyCompletion { receipt.earlyCompletion = nil; early() }
                else if pid == nil { completion(nil, "launch_failed", -1) }
            }
        }
    }

    @objc func onDictateToggle() {
        guard nativeWork.isAccepting else { return }
        if voiceCancellationPending {
            queueVoiceRestart { [weak self] in self?.onDictateToggle() }
            showVoiceOverlay(L("正在启动…", "Starting…"), animation: .starting)
            return
        }
        if pendingStartFeedbackText != nil {
            pendingVoiceStop = { [weak self] in self?.onDictateToggle() }
            return
        }
        guard !voiceLaunchPending, resultManagedLauncherPids.isEmpty else { return }
        if state == .recording && !activeRecordingIsDictation { return }
        let stopping = state == .recording && activeRecordingIsDictation
        if stopping && activeDictationIntent() == "voice_chat" { return }
        launchVoiceCommand(.dictate, stopping: stopping, recordingText: L("听写中", "Dictating"))
    }

    @objc func onDictateTranslateFromMenu() {
        onDictateTranslate(targetLanguage: dictationTargetLanguage(fallback: "English"))
    }

    func onDictateTranslate(targetLanguage: String) {
        guard nativeWork.isAccepting else { return }
        if voiceCancellationPending {
            queueVoiceRestart { [weak self] in self?.onDictateTranslate(targetLanguage: targetLanguage) }
            showVoiceOverlay(L("正在启动…", "Starting…"), animation: .starting)
            return
        }
        if pendingStartFeedbackText != nil {
            pendingVoiceStop = { [weak self] in self?.onDictateTranslate(targetLanguage: targetLanguage) }
            return
        }
        guard !voiceLaunchPending, resultManagedLauncherPids.isEmpty else { return }
        if state == .recording && !activeRecordingIsDictation { return }
        let stopping = state == .recording && activeRecordingIsDictation
        if stopping && activeDictationIntent() == "voice_chat" { return }
        launchVoiceCommand(.translate(dictationTargetLanguage(fallback: targetLanguage)),
            stopping: stopping, recordingText: L("正在翻译", "Translating"))
    }

    @objc func onVoiceChat() {
        guard nativeWork.isAccepting else { return }
        if voiceCancellationPending {
            queueVoiceRestart { [weak self] in self?.onVoiceChat() }
            showVoiceOverlay(L("正在启动…", "Starting…"), animation: .starting)
            return
        }
        if pendingStartFeedbackText != nil {
            pendingVoiceStop = { [weak self] in self?.onVoiceChat() }
            return
        }
        guard !voiceLaunchPending, resultManagedLauncherPids.isEmpty else { return }
        if state == .recording && !activeRecordingIsDictation { return }
        let stopping = state == .recording && activeRecordingIsDictation
        if stopping && activeDictationIntent() != "voice_chat" { return }
        launchVoiceCommand(.chat, stopping: stopping, recordingText: L("正在听问题", "Listening to your question"))
    }

    private func queueVoiceRestart(_ action: @escaping () -> Void) {
        if pendingVoiceRestart == nil { pendingVoiceRestart = action }
        else { pendingVoiceStop = action }
    }

    @objc func onCurrentMeetingRecord(_ sender: NSMenuItem) {
        startCurrentMeeting(from: sender, join: false)
    }

    @objc func onCurrentMeetingRecordJoin(_ sender: NSMenuItem) {
        startCurrentMeeting(from: sender, join: true)
    }

    private func startCurrentMeeting(from sender: NSMenuItem, join: Bool) {
        guard nativeWork.isAccepting else { return }
        guard let meetingId = sender.representedObject as? String,
              !meetingId.isEmpty else { return }
        _ = RecordingLauncher.launchStartMeeting(meetingId: meetingId, join: join)
    }

    private func showDaemonDownNotification() {
        log("daemon down — surfacing notification")
        _ = YuluNotificationPresenter.shared.receive(["kind": "audio_unavailable", "id": "capture"])
    }

    @objc func onOpenInbox() {
        if let openRoute { openRoute("/inbox"); return }
        if let url = URL(string: "http://127.0.0.1:7777/inbox") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func onOpenAgentConsole() {
        if let openRoute { openRoute("/agent-console"); return }
        if let url = URL(string: "http://127.0.0.1:7777/agent-console") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func onOpenSettings() {
        if let openRoute { openRoute("/settings"); return }
        if let url = URL(string: "http://127.0.0.1:7777/settings") {
            NSWorkspace.shared.open(url)
        }
    }

    private func currentInputTargetApplication(preferred: NSRunningApplication? = nil) -> NSRunningApplication? {
        if let front = preferred ?? NSWorkspace.shared.frontmostApplication,
           isUsableInputTarget(front) {
            return front
        }
        if let focused = focusedInputApplication() {
            return focused
        }
        return NSWorkspace.shared.runningApplications.first { app in
            app.isActive && isUsableInputTarget(app)
        }
    }

    private func focusedInputApplication() -> NSRunningApplication? {
        guard AXIsProcessTrusted() else { return nil }
        let system = AXUIElementCreateSystemWide()
        setAXTimeout(system)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            system,
            kAXFocusedUIElementAttribute as CFString,
            &focused
        ) == .success, let focused else { return nil }
        var pid: pid_t = 0
        guard AXUIElementGetPid(focused as! AXUIElement, &pid) == .success,
              let app = NSRunningApplication(processIdentifier: pid),
              isUsableInputTarget(app) else { return nil }
        return app
    }

    private func isUsableInputTarget(_ app: NSRunningApplication) -> Bool {
        let bundleId = app.bundleIdentifier ?? ""
        if bundleId == "com.apple.loginwindow" || bundleId == "com.apple.SecurityAgent" || bundleId == Bundle.main.bundleIdentifier {
            return false
        }
        return app.activationPolicy != .prohibited
    }

    private func capturePasteTarget(for app: NSRunningApplication?) -> CapturedPasteTarget? {
        guard AXIsProcessTrusted(), let app, isUsableInputTarget(app) else { return nil }
        let appElement = AXUIElementCreateApplication(app.processIdentifier)
        setAXTimeout(appElement)
        var focused: CFTypeRef?
        if AXUIElementCopyAttributeValue(
            appElement,
            kAXFocusedUIElementAttribute as CFString,
            &focused
        ) != .success || focused == nil {
            let system = AXUIElementCreateSystemWide()
            setAXTimeout(system)
            _ = AXUIElementCopyAttributeValue(
                system,
                kAXFocusedUIElementAttribute as CFString,
                &focused
            )
        }
        guard let focused else { return nil }
        var focusedPID: pid_t = 0
        guard AXUIElementGetPid(focused as! AXUIElement, &focusedPID) == .success,
              focusedPID == app.processIdentifier else { return nil }
        return CapturedPasteTarget(
            bundleId: app.bundleIdentifier ?? "",
            appName: app.localizedName ?? "",
            element: focused as! AXUIElement
        )
    }

    private func capturedPasteTargetMatches(_ target: CapturedPasteTarget, bundleId: String, appName: String) -> Bool {
        if bundleId.isEmpty && appName.isEmpty { return false }
        return (!bundleId.isEmpty && target.bundleId == bundleId)
            || (!appName.isEmpty && target.appName == appName)
    }

    private func shouldAvoidAccessibilityInsert(bundleId: String, appName: String) -> Bool {
        let bundle = bundleId.lowercased()
        let name = appName.lowercased()
        // ponytail: Codex's AX value can include nearby UI labels; use paste for that web editor.
        return bundle == "com.openai.codex" || name == "codex"
    }

    private func runningTextTarget(bundleId: String, appName: String) -> NSRunningApplication? {
        NSWorkspace.shared.runningApplications.first { app in
            (!bundleId.isEmpty && app.bundleIdentifier == bundleId)
                || (!appName.isEmpty && (app.localizedName ?? "") == appName)
        }
    }

    private func activateTextTarget(bundleId: String, appName: String) {
        guard let target = runningTextTarget(bundleId: bundleId, appName: appName) else { return }
        if #unavailable(macOS 14.0) {
            target.activate(options: [.activateIgnoringOtherApps])
        }
        if let url = target.bundleURL {
            let config = NSWorkspace.OpenConfiguration()
            config.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: config) { _, _ in }
            return
        }
    }

    private func isFrontTextTarget(bundleId: String, appName: String) -> Bool {
        if bundleId.isEmpty && appName.isEmpty { return true }
        guard let front = NSWorkspace.shared.frontmostApplication else {
            return runningTextTarget(bundleId: bundleId, appName: appName)?.isActive == true
        }
        if (!bundleId.isEmpty && front.bundleIdentifier == bundleId)
            || (!appName.isEmpty && (front.localizedName ?? "") == appName) {
            return true
        }
        if !isUsableInputTarget(front),
           runningTextTarget(bundleId: bundleId, appName: appName) != nil {
            // ponytail: launchd agents can report loginwindow as frontmost; after activating the target, try Cmd+V.
            return true
        }
        return false
    }

    private func waitForFrontTextTarget(bundleId: String, appName: String, timeout: TimeInterval = 0.8) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if isFrontTextTarget(bundleId: bundleId, appName: appName) {
                return true
            }
            Thread.sleep(forTimeInterval: 0.05)
        }
        return isFrontTextTarget(bundleId: bundleId, appName: appName)
    }

    private func insertTextWithAccessibility(_ text: String, bundleId: String, appName: String) -> (Bool, String) {
        activateTextTarget(bundleId: bundleId, appName: appName)
        _ = waitForFrontTextTarget(bundleId: bundleId, appName: appName)
        guard AXIsProcessTrusted() else { return (false, "accessibility_not_trusted") }
        var focused: CFTypeRef?
        var focusedSource = "system"
        var focusedErr: AXError?
        var targetAppElement: AXUIElement?
        if let target = runningTextTarget(bundleId: bundleId, appName: appName) {
            focusedSource = "target"
            targetAppElement = AXUIElementCreateApplication(target.processIdentifier)
            setAXTimeout(targetAppElement!)
            focusedErr = AXUIElementCopyAttributeValue(
                targetAppElement!,
                kAXFocusedUIElementAttribute as CFString,
                &focused
            )
        }
        if focused == nil {
            focusedSource = "system"
            let system = AXUIElementCreateSystemWide()
            setAXTimeout(system)
            focusedErr = AXUIElementCopyAttributeValue(
                system,
                kAXFocusedUIElementAttribute as CFString,
                &focused
            )
        }
        var lastError = "\(focusedSource)_focused_element_unavailable:\(focusedErr?.rawValue ?? -1)"
        if focusedErr == .success, let focused {
            let element = focused as! AXUIElement
            let direct = insertText(text, into: element)
            if direct.0 { return direct }
            lastError = "\(focusedSource)_\(direct.1)"
        }
        if let targetAppElement {
            for attr in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
                var windowRef: CFTypeRef?
                if AXUIElementCopyAttributeValue(
                    targetAppElement,
                    attr as CFString,
                    &windowRef
                ) == .success, let windowRef,
                   let writable = findWritableTextElement(in: windowRef as! AXUIElement, depth: 3, budget: 16) {
                    let nested = insertText(text, into: writable)
                    if nested.0 { return nested }
                    lastError = "target_nested_\(nested.1)"
                }
            }
            // ponytail: keep AX search shallow; Cmd+V fallback is faster than walking the whole app tree.
        }
        return (false, lastError)
    }

    private func setAXTimeout(_ element: AXUIElement) {
        AXUIElementSetMessagingTimeout(element, 0.03)
    }

    private func insertText(_ text: String, into element: AXUIElement) -> (Bool, String) {
        setAXTimeout(element)
        var valueRef: CFTypeRef?
        let valueErr = AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &valueRef
        )
        guard valueErr == .success, let value = valueRef as? String else {
            return (false, "focused_value_unavailable:\(valueErr.rawValue)")
        }
        var rangeRef: CFTypeRef?
        let rangeErr = AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeRef
        )
        guard rangeErr == .success, let rangeValue = rangeRef else {
            return (false, "selected_range_unavailable:\(rangeErr.rawValue)")
        }
        var cfRange = CFRange(location: 0, length: 0)
        guard AXValueGetValue(rangeValue as! AXValue, .cfRange, &cfRange) else {
            return (false, "selected_range_invalid")
        }
        let nsValue = value as NSString
        let start = max(0, min(cfRange.location, nsValue.length))
        let length = max(0, min(cfRange.length, nsValue.length - start))
        let nextValue = nsValue.replacingCharacters(
            in: NSRange(location: start, length: length),
            with: text
        )
        let setErr = AXUIElementSetAttributeValue(
            element,
            kAXValueAttribute as CFString,
            nextValue as CFTypeRef
        )
        guard setErr == .success else { return (false, "set_value_failed:\(setErr.rawValue)") }
        var nextRange = CFRange(location: start + (text as NSString).length, length: 0)
        if let axRange = AXValueCreate(.cfRange, &nextRange) {
            _ = AXUIElementSetAttributeValue(
                element,
                kAXSelectedTextRangeAttribute as CFString,
                axRange
            )
        }
        var confirmedValue: CFTypeRef?
        let verified = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &confirmedValue) == .success
            && (confirmedValue as? String) == nextValue
        // A successful AX write must never be replayed through Cmd+V merely
        // because the target won't let us read it back.
        return (true, verified ? "" : "unverified")
    }

    private func findWritableTextElement(in element: AXUIElement, depth: Int, budget: Int) -> AXUIElement? {
        if depth < 0 || budget <= 0 { return nil }
        setAXTimeout(element)
        if isWritableTextElement(element) {
            return element
        }
        var childrenRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXChildrenAttribute as CFString,
            &childrenRef
        ) == .success, let children = childrenRef as? [AXUIElement] else {
            return nil
        }
        var remaining = budget - 1
        for child in children {
            if let found = findWritableTextElement(in: child, depth: depth - 1, budget: remaining) {
                return found
            }
            remaining -= 1
            if remaining <= 0 { break }
        }
        return nil
    }

    private func isWritableTextElement(_ element: AXUIElement) -> Bool {
        setAXTimeout(element)
        var valueRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXValueAttribute as CFString,
            &valueRef
        ) == .success, valueRef is String else {
            return false
        }
        var rangeRef: CFTypeRef?
        guard AXUIElementCopyAttributeValue(
            element,
            kAXSelectedTextRangeAttribute as CFString,
            &rangeRef
        ) == .success, rangeRef != nil else {
            return false
        }
        return true
    }

    private func sendPasteKeystroke(to target: NSRunningApplication?) -> String? {
        let source = CGEventSource(stateID: .hidSystemState)
        guard let down = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: true),
              let up = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: false) else {
            return nil
        }
        down.flags = .maskCommand
        up.flags = .maskCommand
        if let target {
            down.postToPid(target.processIdentifier)
            up.postToPid(target.processIdentifier)
            return "target_keystroke"
        }
        down.post(tap: .cghidEventTap)
        up.post(tap: .cghidEventTap)
        return "keystroke"
    }

    private func pasteTextSnapshot(_ element: AXUIElement) -> PasteTextSnapshot {
        setAXTimeout(element)
        var value: CFTypeRef?
        var range: CFTypeRef?
        _ = AXUIElementCopyAttributeValue(element, kAXValueAttribute as CFString, &value)
        var selected = CFRange(location: 0, length: 0)
        let hasRange = AXUIElementCopyAttributeValue(element, kAXSelectedTextRangeAttribute as CFString, &range) == .success
        if hasRange, let range, CFGetTypeID(range) == AXValueGetTypeID(),
           AXValueGetValue(range as! AXValue, .cfRange, &selected) {
            return PasteTextSnapshot(value: value as? String, selection: selected)
        }
        return PasteTextSnapshot(value: value as? String, selection: nil)
    }

    @discardableResult
    private func copyRecoveryText(_ text: String) -> Bool {
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(text, forType: .string)
    }

    func pasteClipboard(text: String? = nil, targetBundleId: String?, targetAppName: String?) -> [String: Any] {
        let bundleId = (targetBundleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let appName = (targetAppName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = (text ?? "").trimmingCharacters(in: .newlines)
        // Capture and the retired StatusAgent have separate TCC identities.
        // Their permission does not authorize the current Yulu shell to type.
        // CGEvent posting silently drops events when this permission is missing.
        let inputAccess = inputAccessCheck()
        guard inputAccess.trusted, inputAccess.posting else {
            let copied = !text.isEmpty && copyRecoveryText(text)
            log("dictation paste blocked: accessibility_not_trusted target=\(bundleId)")
            return ["ok": false, "error": "accessibility_not_trusted", "dispatched": false,
                    "verified": false, "copied": copied, "method": "clipboard_only"]
        }
        var accessibilityError = ""
        if !text.isEmpty {
            let captured = capturedPasteTarget
            capturedPasteTarget = nil
            if !shouldAvoidAccessibilityInsert(bundleId: bundleId, appName: appName) {
                if let captured,
                   capturedPasteTargetMatches(captured, bundleId: bundleId, appName: appName) {
                    let inserted = insertText(text, into: captured.element)
                    if inserted.0 {
                        let verified = inserted.1.isEmpty
                        let copied = !verified && copyRecoveryText(text)
                        return ["ok": true, "method": "captured_accessibility", "verified": verified, "copied": copied]
                    }
                    accessibilityError = "captured_\(inserted.1)"
                }
                let inserted = insertTextWithAccessibility(text, bundleId: bundleId, appName: appName)
                if inserted.0 {
                    let verified = inserted.1.isEmpty
                    let copied = !verified && copyRecoveryText(text)
                    return ["ok": true, "method": "accessibility", "verified": verified, "copied": copied]
                }
                accessibilityError = accessibilityError.isEmpty ? inserted.1 : "\(accessibilityError);\(inserted.1)"
            }
        }
        activateTextTarget(bundleId: bundleId, appName: appName)
        if !waitForFrontTextTarget(bundleId: bundleId, appName: appName) {
            var resp: [String: Any] = [
                "ok": false,
                "error": "target_not_front",
                "front_app_name": NSWorkspace.shared.frontmostApplication?.localizedName ?? "",
                "front_bundle_id": NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "",
            ]
            if !accessibilityError.isEmpty { resp["accessibility_error"] = accessibilityError }
            return resp
        }
        let target = runningTextTarget(bundleId: bundleId, appName: appName)
        let element = capturePasteTarget(for: target)?.element
        let before = element.map { pasteTextSnapshot($0) }
        let pasteboard = NSPasteboard.general
        let savedItems = pasteboard.pasteboardItems?.map { item -> NSPasteboardItem in
            let snapshot = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { snapshot.setData(data, forType: type) }
            }
            return snapshot
        } ?? []
        if !text.isEmpty && !copyRecoveryText(text) {
            return ["ok": false, "error": "copy_failed", "copied": false]
        }
        let clipboardGeneration = pasteboard.changeCount
        guard let pasteMethod = sendPasteKeystroke(to: target) else {
            var resp: [String: Any] = ["ok": false, "error": "paste_failed"]
            if !accessibilityError.isEmpty { resp["accessibility_error"] = accessibilityError }
            return resp
        }
        var verified = false
        if !text.isEmpty, let element, let before {
            let deadline = Date().addingTimeInterval(0.45)
            repeat {
                if before.confirmsInsertion(text, after: pasteTextSnapshot(element)) { verified = true; break }
                // React/contenteditable inputs can replace their AX element on paste.
                if let fresh = capturePasteTarget(for: target)?.element, !CFEqual(element, fresh),
                   before.confirmsInsertion(text, after: pasteTextSnapshot(fresh)) { verified = true; break }
                Thread.sleep(forTimeInterval: 0.02)
            } while Date() < deadline
        }
        if verified && pasteboard.changeCount == clipboardGeneration && !text.isEmpty {
            pasteboard.clearContents()
            if !savedItems.isEmpty { pasteboard.writeObjects(savedItems) }
        }
        var resp: [String: Any] = ["ok": true, "method": pasteMethod, "verified": verified, "copied": !verified]
        if !accessibilityError.isEmpty { resp["accessibility_error"] = accessibilityError }
        return resp
    }

    func openVoiceChatWindow(urlString: String? = nil) {
        hideVoiceOverlay()
        let raw = urlString ?? "http://127.0.0.1:7777/voice-chat"
        guard let url = URL(string: raw), url.scheme == "http",
              ["127.0.0.1", "localhost"].contains(url.host ?? ""), url.port == 7777,
              url.path == "/voice-chat", url.user == nil, url.password == nil else { return }
        let panel: NSPanel
        if let existing = voiceChatWindow as? NSPanel {
            panel = existing
        } else {
            panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 520, height: 560),
                styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.title = L("Yulu 语音对话", "Yulu Voice Chat")
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titlebarAppearsTransparent = true
            panel.hidesOnDeactivate = false
            panel.becomesKeyOnlyIfNeeded = true
            panel.contentView = WKWebView(frame: panel.contentView?.bounds ?? .zero)
            voiceChatWindow = panel
        }
        if let web = panel.contentView as? WKWebView {
            web.autoresizingMask = [.width, .height]
            if web.url != url { web.load(URLRequest(url: url)) }
        }
        if !panel.isVisible { panel.center() }
        panel.orderFrontRegardless()
    }

    func voiceChatWindowStatus() -> [String: Any] {
        var resp: [String: Any] = [
            "voice_chat_window_visible": voiceChatWindow?.isVisible ?? false,
        ]
        if let web = voiceChatWindow?.contentView as? WKWebView,
           let url = web.url?.absoluteString {
            resp["voice_chat_window_url"] = url
        }
        return resp
    }

    @objc func onRecentClicked(_ sender: NSMenuItem) {
        guard let stem = sender.representedObject as? String,
              let url = URL(string: "http://127.0.0.1:7777/inbox/\(stem)") else { return }
        if let openRoute { openRoute(url.path); return }
        NSWorkspace.shared.open(url)
    }
}

#if !YULU_NATIVE_RECORDING_LIBRARY
@main
struct StatusAgentMain {
    static func main() {
        if CommandLine.arguments.contains("--self-test") {
            let scriptsDir = "/tmp/yulu-scripts"
            let task = yuluPythonProcess(scriptDir: scriptsDir)
            guard task.executableURL?.path != "/usr/bin/env",
                  task.currentDirectoryURL?.path == scriptsDir,
                  task.environment?["PYTHONPATH"]?.split(separator: ":").first == Substring(scriptsDir) else {
                fputs("status_agent self-test failed\n", stderr)
                exit(1)
            }
            let prettyJSON = Data("{\n  \"action\": \"stop\",\n  \"pasted\": true\n}\n".utf8)
            assert(parseDictationOutput(prettyJSON)?["action"] as? String == "stop")
            assert(normalizedMicLevel(0) == 0)
            assert(normalizedMicLevel(0.1) > normalizedMicLevel(0.01))
            assert(menuKeyEquivalent(for: "⌃⌥Space") == " ")
            assert(menuKeyEquivalent(for: "⌃⌥T") == "t")
            assert(menuModifierFlags(for: 0x1800) == [.control, .option])
            assert(recentRecordingFallbackTitle("AgentKey_Product_Weekly_20260804_160014") == "Agent Key Product Weekly")
            assert(recentRecordingMenuTitle(time: "Aug 5 09:30", name: "Roadmap").string == "Aug 5 09:30\tRoadmap")
            activeAppLanguage = .en
            let menuTarget = StatusAgentApp()
            let menu = MenuBuilder.build(target: menuTarget)
            assert(menu.items.first(where: { $0.identifier?.rawValue == "current_meeting_label" })?.isHidden == true)
            assert(menu.items.first(where: { $0.identifier?.rawValue == "recent_recordings" })?.submenu != nil)
            assert(menu.items.contains(where: { $0.title == "Settings…" && $0.keyEquivalent == "," }))
            assert(menu.items.last?.title == "Quit Yulu")
            withExtendedLifetime(menuTarget) {}
            print("status_agent self-test ok: \(task.executableURL?.path ?? "missing")")
            exit(0)
        }

        let app = NSApplication.shared
        let delegate = StatusAgentApp()
        app.delegate = delegate
        app.setActivationPolicy(.accessory)  // belt-and-braces: hide from Dock even if LSUIElement somehow missing
        app.run()
    }
}
#endif
