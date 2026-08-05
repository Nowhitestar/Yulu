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

let CONFIG_DIR = ("~/.config/yulu" as NSString).expandingTildeInPath
let PID_FILE = "\(CONFIG_DIR)/status_agent.pid"
let LOG_FILE = "\(CONFIG_DIR)/status_agent.log"
let IPC_SOCKET_PATH = "\(CONFIG_DIR)/status_agent.sock"

enum AppLanguage: String {
    case zh, en
}

var activeAppLanguage: AppLanguage = .zh

func readAppLanguage() -> AppLanguage {
    let path = "\(CONFIG_DIR)/config.json"
    guard let data = FileManager.default.contents(atPath: path),
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
    ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
}

func yuluPythonProcess(scriptDir: String) -> Process {
    let task = Process()
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    let python = candidates.first(where: FileManager.default.isExecutableFile(atPath:))
        ?? "/usr/bin/python3"
    task.executableURL = URL(fileURLWithPath: python)
    task.currentDirectoryURL = URL(fileURLWithPath: scriptDir)
    var env = ProcessInfo.processInfo.environment
    let existing = env["PYTHONPATH"] ?? ""
    env["PYTHONPATH"] = existing.isEmpty ? scriptDir : "\(scriptDir):\(existing)"
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
    let path = "\(CONFIG_DIR)/config.json"
    guard let data = FileManager.default.contents(atPath: path),
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
    let path = "\(CONFIG_DIR)/schedule.json"
    guard let data = FileManager.default.contents(atPath: path),
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
func loadRecordingDir() -> String {
    let defaultDir = ("~/Movies/Yulu" as NSString).expandingTildeInPath
    let configPath = "\(CONFIG_DIR)/config.json"
    guard let data = FileManager.default.contents(atPath: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let audio = json["audio"] as? [String: Any],
          let raw = audio["output_dir"] as? String,
          !raw.isEmpty else {
        return defaultDir
    }
    return raw.hasPrefix("~/")
        ? ("\(raw)" as NSString).expandingTildeInPath
        : raw
}

func activeDictationIntent() -> String {
    let path = "\(CONFIG_DIR)/dictation/state.json"
    guard let data = FileManager.default.contents(atPath: path),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
        return ""
    }
    return (json["intent"] as? String) ?? ""
}

func dictationTargetLanguage(fallback: String) -> String {
    let configPath = "\(CONFIG_DIR)/config.json"
    guard let data = FileManager.default.contents(atPath: configPath),
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
        HotkeySpec(action: "dictate", keyCode: 49, modifierMask: 0x1800, label: "⌃⌥Space", targetLanguage: ""),
        HotkeySpec(action: "translate", keyCode: 17, modifierMask: 0x1800, label: "⌃⌥T", targetLanguage: "English"),
        HotkeySpec(action: "voice_chat", keyCode: 0, modifierMask: 0x1800, label: "⌃⌥A", targetLanguage: ""),
    ]
}

func readHotkeysFromConfig() -> [HotkeySpec] {
    let task = yuluPythonProcess(scriptDir: statusAgentScriptDir())
    task.arguments = ["status_agent_config.py", "hotkeys", "--json"]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
        task.waitUntilExit()
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
            targetLanguage: (item["targetLanguage"] as? String) ?? ""
        )
    }
    return parsed.isEmpty ? defaultHotkeySpecs() : parsed
}

class HotkeyRegistrar {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onTrigger: (() -> Void)?
    private let id: UInt32

    static let signature: OSType = 0x59556C75

    init(id: UInt32) {
        self.id = id
    }

    func register(keyCode: UInt32, modifierMask: UInt32, _ trigger: @escaping () -> Void) -> Bool {
        unregister()
        onTrigger = trigger
        let hotKeyID = EventHotKeyID(signature: HotkeyRegistrar.signature, id: id)
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
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
            DispatchQueue.main.async { me.onTrigger?() }
            return noErr
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(GetApplicationEventTarget(), handler, 1, &spec, selfPtr, &handlerRef)
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
    case none, recording, processing, success
}

class VoiceWaveView: NSView {
    private var tick = 0
    private var timer: Timer?
    var mode: VoiceOverlayAnimationMode = .recording {
        didSet { updateTimer(); needsDisplay = true }
    }
    var level: CGFloat = 0 {
        didSet { needsDisplay = true }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        updateTimer()
    }

    private func updateTimer() {
        let shouldAnimate = window != nil
            && mode == .processing
            && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        if !shouldAnimate {
            timer?.invalidate()
            timer = nil
            return
        }
        if timer == nil {
            timer = Timer.scheduledTimer(withTimeInterval: 0.08, repeats: true) { [weak self] _ in
                self?.tick += 1
                self?.needsDisplay = true
            }
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        if mode == .none { return }
        let electricBlue = NSColor(calibratedRed: 0.15, green: 0.67, blue: 1.0, alpha: 1)
        if mode == .success {
            NSColor(calibratedRed: 0.25, green: 0.86, blue: 0.63, alpha: 1).setStroke()
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
        if mode == .processing {
            electricBlue.setStroke()
            let ring = NSBezierPath()
            ring.lineWidth = 2.2
            ring.lineCapStyle = .round
            let start = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 25.0 : Double(tick * 24)
            ring.appendArc(
                withCenter: NSPoint(x: bounds.midX, y: bounds.midY),
                radius: 7,
                startAngle: start,
                endAngle: start + 275
            )
            ring.stroke()
            return
        }
        let bars = 5
        let gap: CGFloat = 2
        let width: CGFloat = 3
        let total = CGFloat(bars) * width + CGFloat(bars - 1) * gap
        let startX = (bounds.width - total) / 2
        let shapes: [CGFloat] = [0.42, 0.78, 1, 0.68, 0.32]
        let amplitude = max(0.40, min(1, level))
        NSGraphicsContext.saveGraphicsState()
        let glow = NSShadow()
        glow.shadowColor = electricBlue.withAlphaComponent(0.58)
        glow.shadowBlurRadius = 5
        glow.set()
        electricBlue.setFill()
        for i in 0..<bars {
            let height = 4 + 16 * amplitude * shapes[i]
            let x = startX + CGFloat(i) * (width + gap)
            let y = (bounds.height - height) / 2
            let slash = min(1.5, height / 3)
            let bar = NSBezierPath()
            bar.move(to: NSPoint(x: x, y: y + slash))
            bar.line(to: NSPoint(x: x + width, y: y))
            bar.line(to: NSPoint(x: x + width, y: y + height - slash))
            bar.line(to: NSPoint(x: x, y: y + height))
            bar.close()
            bar.fill()
        }
        electricBlue.withAlphaComponent(0.78).setFill()
        NSBezierPath(rect: NSRect(x: startX - 1, y: bounds.midY - 0.5, width: total + 2, height: 1)).fill()
        NSGraphicsContext.restoreGraphicsState()
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
        let capsule = NSBezierPath(
            roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
            xRadius: 17.5,
            yRadius: 17.5
        )
        NSColor(calibratedRed: 0.055, green: 0.10, blue: 0.15, alpha: 0.97).setFill()
        capsule.fill()
        capsule.lineWidth = 1
        NSColor(calibratedRed: 0.20, green: 0.39, blue: 0.53, alpha: 0.72).setStroke()
        capsule.stroke()
    }

    private func configureLayer() {
        wantsLayer = true
        guard let layer = layer else { return }
        layer.backgroundColor = NSColor.clear.cgColor
        layer.cornerRadius = 18
        layer.borderWidth = 0
        let isRecording = mode == .recording
        layer.shadowColor = isRecording
            ? NSColor(calibratedRed: 0.15, green: 0.67, blue: 1.0, alpha: 1).cgColor
            : NSColor.black.cgColor
        layer.shadowOpacity = isRecording ? 0.18 : 0.28
        layer.shadowRadius = isRecording ? 12 : 14
        layer.shadowOffset = NSSize(width: 0, height: isRecording ? 2 : 5)
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
    static let socketPath = (("~/.config/yulu/audio_daemon.sock") as NSString).expandingTildeInPath

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

    private static func scriptDir() -> String {
        ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
            ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
    }

    private static func launcherLog() -> FileHandle {
        let logPath = (("~/.config/yulu/status_agent_launcher.log") as NSString).expandingTildeInPath
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
            try task.run()
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
            try task.run()
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
            try task.run()
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
        task.arguments = arguments
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
            try task.run()
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
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py warm: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchVoiceChatToggle() -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        task.arguments = [
            "dictate.py", "ask-toggle",
            "--no-paste",
            "--no-copy",
            "--json",
        ]
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py ask-toggle: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchDictateCancel() -> Int32? {
        let task = yuluPythonProcess(scriptDir: scriptDir())
        task.arguments = [
            "dictate.py", "cancel",
            "--json",
        ]
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py cancel: \(error)")
            return nil
        }
    }
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

    init(app: StatusAgentApp) { self.app = app }

    func stop() {
        if sock >= 0 { close(sock); sock = -1 }
        try? FileManager.default.removeItem(atPath: IPC_SOCKET_PATH)
    }

    func start() {
        try? FileManager.default.removeItem(atPath: IPC_SOCKET_PATH)
        sock = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard sock >= 0 else { log("IPC: socket() failed"); return }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = IPC_SOCKET_PATH.utf8CString
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else {
            log("IPC: socket path too long (\(pathBytes.count))")
            close(sock); sock = -1; return
        }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { p in
                pathBytes.withUnsafeBufferPointer { src in
                    _ = strncpy(p, src.baseAddress!, pathBytes.count)
                }
            }
        }
        let bindResult = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(sock, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            log("IPC: bind failed errno=\(errno)")
            close(sock); sock = -1; return
        }
        Darwin.listen(sock, 5)
        chmod(IPC_SOCKET_PATH, 0o600)
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
        // Read until newline or EOF. Clients are local + cooperative;
        // we don't bound the read because requests are tiny (<200 bytes).
        while true {
            let n = read(c, &buf, 4096)
            if n <= 0 { break }
            data.append(buf, count: n)
            if data.last == 0x0A { break }
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let action = obj["action"] as? String else {
            sendJSON(c, ["ok": false, "error": "invalid_json"])
            return
        }
        switch action {
        case "status":
            sendJSON(c, statusResponse())
        case "toggle":
            sendJSON(c, toggleResponse())
        case "dictate_toggle":
            sendJSON(c, dictateToggleResponse())
        case "dictate_translate":
            sendJSON(c, dictateTranslateResponse(obj: obj))
        case "voice_chat":
            sendJSON(c, voiceChatResponse())
        case "open_inbox":
            DispatchQueue.main.async { [weak self] in self?.app?.onOpenInbox() }
            sendJSON(c, ["ok": true])
        case "open_agent_console":
            DispatchQueue.main.async { [weak self] in self?.app?.onOpenAgentConsole() }
            sendJSON(c, ["ok": true])
        case "open_voice_chat":
            sendJSON(c, openVoiceChatResponse(obj: obj))
        case "paste_clipboard":
            sendJSON(c, pasteClipboardResponse(obj: obj))
        case "preview_sound":
            sendJSON(c, previewSoundResponse())
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
        let scriptsDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
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
            try task.run()
        } catch {
            return ["ok": false, "error": "search helper spawn failed: \(error)"]
        }

        // Write the original request bytes (so we don't re-serialize and
        // risk losing ordering or precision) then close stdin so the
        // helper sees EOF.
        stdinPipe.fileHandleForWriting.write(data)
        try? stdinPipe.fileHandleForWriting.close()

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

    private func statusResponse() -> [String: Any] {
        var resp: [String: Any] = ["ok": true]
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            resp["state"] = app.state.rawValue
            resp["dictation_active"] = app.activeRecordingIsDictation
            if app.activeRecordingIsDictation {
                resp["dictation_intent"] = activeDictationIntent()
            }
            let pids = app.activeLauncherPids()
            if let pid = pids.first { resp["launcher_pid"] = Int(pid) }
            if !pids.isEmpty { resp["launcher_pids"] = pids.map { Int($0) } }
            resp.merge(app.voiceChatWindowStatus()) { _, new in new }
        }
        _ = sem.wait(timeout: .now() + 2)
        return resp
    }

    private func toggleResponse() -> [String: Any] {
        var before = "unknown"
        var after = "unknown"
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            before = app.state.rawValue
            app.onMenuToggle()
            after = app.state.rawValue
        }
        _ = sem.wait(timeout: .now() + 3)
        return ["ok": true, "state_before": before, "state_after": after]
    }

    private func dictateToggleResponse() -> [String: Any] {
        var before = "unknown"
        var after = "unknown"
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            before = app.state.rawValue
            app.onDictateToggle()
            after = app.state.rawValue
        }
        _ = sem.wait(timeout: .now() + 3)
        return ["ok": true, "state_before": before, "state_after": after]
    }

    private func dictateTranslateResponse(obj: [String: Any]) -> [String: Any] {
        var before = "unknown"
        var after = "unknown"
        let targetLanguage = obj["target_language"] as? String ?? ""
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            before = app.state.rawValue
            app.onDictateTranslate(targetLanguage: targetLanguage)
            after = app.state.rawValue
        }
        _ = sem.wait(timeout: .now() + 3)
        return ["ok": true, "state_before": before, "state_after": after]
    }

    private func voiceChatResponse() -> [String: Any] {
        var before = "unknown"
        var after = "unknown"
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            before = app.state.rawValue
            app.onVoiceChat()
            after = app.state.rawValue
        }
        _ = sem.wait(timeout: .now() + 3)
        return ["ok": true, "state_before": before, "state_after": after]
    }

    private func openVoiceChatResponse(obj: [String: Any]) -> [String: Any] {
        var resp: [String: Any] = ["ok": false]
        let url = obj["url"] as? String
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            app.openVoiceChatWindow(urlString: url)
            resp = ["ok": true]
            resp.merge(app.voiceChatWindowStatus()) { _, new in new }
        }
        _ = sem.wait(timeout: .now() + 3)
        return resp
    }

    private func pasteClipboardResponse(obj: [String: Any]) -> [String: Any] {
        var resp: [String: Any] = ["ok": false, "error": "paste_timeout"]
        let sem = DispatchSemaphore(value: 0)
        let bundleId = obj["target_bundle_id"] as? String
        let appName = obj["target_app_name"] as? String
        let text = obj["text"] as? String
        DispatchQueue.main.async { [weak self] in
            defer { sem.signal() }
            guard let app = self?.app else { return }
            resp = app.pasteClipboard(text: text, targetBundleId: bundleId, targetAppName: appName)
        }
        _ = sem.wait(timeout: .now() + 2)
        return resp
    }

    private func previewSoundResponse() -> [String: Any] {
        let sem = DispatchSemaphore(value: 0)
        DispatchQueue.main.async { [weak self] in
            self?.app?.previewFeedbackSound()
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 2)
        return ["ok": true, "enabled": feedbackSoundsEnabled()]
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
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    var voiceChatWindow: NSWindow?
    var voiceOverlayWindow: NSPanel?
    var voiceOverlayLabel: NSTextField?
    var voiceOverlayWave: VoiceWaveView?
    var voiceOverlayStopButton: NSButton?
    var voiceOverlayCancelButton: NSButton?
    let feedbackPlayer = VoiceFeedbackPlayer()
    var processingDetailWorkItem: DispatchWorkItem?
    var feedbackDismissWorkItem: DispatchWorkItem?
    var feedbackVisibleUntil: Date?
    var pendingStartFeedbackText: String?
    // ponytail: one pending dictation target; add per-session IDs if overlapping dictations need exact cursor restore.
    var capturedPasteTarget: CapturedPasteTarget?
    var pollerTimer: Timer?
    var state: AgentState = .idle
    var activeRecordingIsDictation = false
    var daemonDownStreak: Int = 0
    var launcherPids: [Int32] = []
    var voiceLauncherPids: [Int32] = []
    var resultManagedLauncherPids: Set<Int32> = []
    var hotkeyRegistrars: [HotkeyRegistrar] = []
    var sighupSource: DispatchSourceSignal?
    // IPC server exposing `status` / `toggle` / `open_inbox` on
    // ~/.config/yulu/status_agent.sock. Lets `yulu status-agent toggle`
    // and acceptance tests drive the agent without UI clicks.
    var ipcServer: IPCServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")
        activeAppLanguage = readAppLanguage()

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = ""
            btn.toolTip = L("Yulu — 点击开始录制", "Yulu — click to record")
        }
        rebuildMenu()
        _ = RecordingLauncher.launchWarmDictation()
        _ = RecordingLauncher.launchWarmDictation(targetLanguage: dictationTargetLanguage(fallback: "English"))
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
        let ipc = IPCServer(app: self)
        ipc.start()
        ipcServer = ipc

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
        hotkeyRegistrars.forEach { $0.unregister() }
        hotkeyRegistrars = []
        let specs = readHotkeysFromConfig()
        for (idx, spec) in specs.enumerated() {
            let registrar = HotkeyRegistrar(id: UInt32(idx + 1))
            let ok = registrar.register(keyCode: spec.keyCode, modifierMask: spec.modifierMask) { [weak self] in
                self?.onHotkey(spec)
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

    private func onHotkey(_ spec: HotkeySpec) {
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
        // Move the blocking socket round-trip OFF the main thread.
        // DaemonClient.send does a blocking read with no timeout — when
        // audio_daemon's accept queue is starved (a documented failure
        // mode under sustained polling) the read hangs forever. If poll()
        // runs on main, that hang freezes NSApplication.run() and the
        // entire UI + IPC main-queue dispatches die with it.
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let resp = DaemonClient.send(["action": "status"])
            DispatchQueue.main.async { [weak self] in
                self?.applyPollResult(resp)
            }
        }
    }

    private func applyPollResult(_ resp: [String: Any]?) {
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

        if !resultManagedLauncherPids.isEmpty {
            applyState(.processing)
            return
        }
        if recording {
            let file = (resp["file"] as? String) ?? ""
            activeRecordingIsDictation = file.hasPrefix("\(CONFIG_DIR)/dictation/")
            applyState(.recording)
            if activeRecordingIsDictation, let text = pendingStartFeedbackText {
                pendingStartFeedbackText = nil
                showVoiceOverlay(text, animation: .recording)
                feedbackPlayer.play(.start)
            }
            return
        }
        activeRecordingIsDictation = false

        // Not recording. A previous stop may still be transcribing/enqueueing,
        // but that must not block the next start: audio_daemon is the source of
        // truth for whether the capture lane is busy.
        if !activeLauncherPids().isEmpty {
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

    private func showVoiceOverlay(_ text: String, animation: VoiceOverlayAnimationMode) {
        let panel: NSPanel
        if let existing = voiceOverlayWindow {
            panel = existing
        } else {
            panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 180, height: 36),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.ignoresMouseEvents = false
            panel.title = L("Yulu 听写状态", "Yulu Dictation Status")
            panel.setAccessibilityElement(true)
            panel.setAccessibilityRole(.window)
            panel.setAccessibilityLabel(L("Yulu 听写状态", "Yulu Dictation Status"))

            let visual = VoiceOverlayContainerView(frame: panel.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 180, height: 36))
            visual.appearance = NSAppearance(named: .darkAqua)
            visual.autoresizingMask = [.width, .height]
            visual.setAccessibilityElement(true)
            visual.setAccessibilityRole(.group)

            let label = NSTextField(labelWithString: text)
            label.alignment = .center
            label.font = .systemFont(ofSize: 13, weight: .semibold)
            label.textColor = NSColor(calibratedWhite: 0.94, alpha: 1)
            label.translatesAutoresizingMaskIntoConstraints = false
            label.setAccessibilityElement(true)

            let waveView = VoiceWaveView()
            waveView.translatesAutoresizingMaskIntoConstraints = false
            waveView.setAccessibilityElement(false)
            let stopButton = NSButton(title: "■", target: self, action: #selector(stopVoiceInputFromOverlay))
            stopButton.isBordered = false
            stopButton.font = .systemFont(ofSize: 12, weight: .semibold)
            stopButton.attributedTitle = NSAttributedString(
                string: "■",
                attributes: [.foregroundColor: NSColor(calibratedWhite: 0.94, alpha: 1)]
            )
            stopButton.wantsLayer = true
            stopButton.layer?.backgroundColor = NSColor.white.withAlphaComponent(0.10).cgColor
            stopButton.layer?.cornerRadius = 8
            stopButton.toolTip = L("停止听写", "Stop dictation")
            stopButton.setAccessibilityLabel(L("停止听写", "Stop dictation"))
            stopButton.translatesAutoresizingMaskIntoConstraints = false
            let cancelButton = NSButton(title: "×", target: self, action: #selector(cancelVoiceInputFromOverlay))
            cancelButton.isBordered = false
            cancelButton.font = .systemFont(ofSize: 17, weight: .medium)
            cancelButton.attributedTitle = NSAttributedString(
                string: "×",
                attributes: [.foregroundColor: NSColor(calibratedWhite: 0.62, alpha: 1)]
            )
            cancelButton.toolTip = L("取消听写", "Cancel dictation")
            cancelButton.setAccessibilityLabel(L("取消听写", "Cancel dictation"))
            cancelButton.translatesAutoresizingMaskIntoConstraints = false
            let content = NSStackView(views: [waveView, label, stopButton, cancelButton])
            content.orientation = .horizontal
            content.alignment = .centerY
            content.spacing = 2
            content.detachesHiddenViews = true
            content.translatesAutoresizingMaskIntoConstraints = false
            content.setCustomSpacing(6, after: waveView)
            content.setCustomSpacing(8, after: label)

            visual.addSubview(content)
            NSLayoutConstraint.activate([
                content.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
                content.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
                content.leadingAnchor.constraint(greaterThanOrEqualTo: visual.leadingAnchor, constant: 8),
                content.trailingAnchor.constraint(lessThanOrEqualTo: visual.trailingAnchor, constant: -8),
                waveView.widthAnchor.constraint(equalToConstant: 24),
                waveView.heightAnchor.constraint(equalToConstant: 20),
                stopButton.widthAnchor.constraint(equalToConstant: 28),
                stopButton.heightAnchor.constraint(equalToConstant: 28),
                cancelButton.widthAnchor.constraint(equalToConstant: 24),
                cancelButton.heightAnchor.constraint(equalToConstant: 28),
            ])

            panel.contentView = visual
            voiceOverlayWindow = panel
            voiceOverlayLabel = label
            voiceOverlayWave = waveView
            voiceOverlayStopButton = stopButton
            voiceOverlayCancelButton = cancelButton
        }

        voiceOverlayLabel?.stringValue = text
        voiceOverlayLabel?.textColor = NSColor(calibratedWhite: 0.94, alpha: 1)
        voiceOverlayLabel?.setAccessibilityLabel(text)
        voiceOverlayWave?.mode = animation
        voiceOverlayWave?.isHidden = animation == .none
        (panel.contentView as? VoiceOverlayContainerView)?.mode = animation
        let recordingControls = animation == .recording
        voiceOverlayStopButton?.isHidden = !recordingControls
        voiceOverlayCancelButton?.isHidden = !recordingControls
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            let textWidth = voiceOverlayLabel?.intrinsicContentSize.width ?? 0
            let compactWidth: CGFloat
            switch animation {
            case .recording:
                compactWidth = 180
            case .processing:
                compactWidth = text == L("正在启动…", "Starting…") || text == L("正在输入…", "Inserting…")
                    ? 140
                    : min(260, max(140, ceil(textWidth + 52)))
            case .success:
                compactWidth = 112
            case .none:
                compactWidth = min(260, max(112, ceil(textWidth + 32)))
            }
            let target = NSRect(x: f.midX - compactWidth / 2, y: f.minY + 86, width: compactWidth, height: 36)
            if panel.isVisible && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.18
                    context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                    panel.animator().setFrame(target, display: true)
                }
            } else {
                panel.setFrame(target, display: true)
            }
        }
        panel.orderFrontRegardless()
    }

    private func hideVoiceOverlay() {
        voiceOverlayWindow?.orderOut(nil)
    }

    private func showTimedVoiceFeedback(
        _ text: String,
        sound: VoiceFeedbackSound?,
        duration: TimeInterval
    ) {
        processingDetailWorkItem?.cancel()
        feedbackDismissWorkItem?.cancel()
        feedbackVisibleUntil = Date().addingTimeInterval(duration)
        applyState(.idle)
        showVoiceOverlay(text, animation: text == L("已输入", "Inserted") ? .success : .none)
        if let sound { feedbackPlayer.play(sound) }
        let dismiss = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.feedbackVisibleUntil = nil
            if self.state == .idle { self.hideVoiceOverlay() }
        }
        feedbackDismissWorkItem = dismiss
        DispatchQueue.main.asyncAfter(deadline: .now() + duration, execute: dismiss)
    }

    private func scheduleLongProcessingLabel() {
        processingDetailWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard self?.state == .processing else { return }
            self?.showVoiceOverlay(L("正在确认完整录音…", "Finalizing recording…"), animation: .processing)
        }
        processingDetailWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.0, execute: item)
    }

    private func scheduleStartConfirmationPolls() {
        for delay in [0.05, 0.15, 0.3] {
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
        log("voice overlay cancel clicked — canceling active voice input")
        let voicePids = activeVoiceLauncherPids()
        for pid in voicePids {
            _ = kill(pid, SIGTERM)
        }
        let canceled = Set(voicePids)
        launcherPids.removeAll { canceled.contains($0) }
        voiceLauncherPids.removeAll { canceled.contains($0) }
        resultManagedLauncherPids.subtract(canceled)
        _ = RecordingLauncher.launchDictateCancel()
        pendingStartFeedbackText = nil
        activeRecordingIsDictation = false
        capturedPasteTarget = nil
        showTimedVoiceFeedback(L("已取消", "Canceled"), sound: nil, duration: 0.8)
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
        hotkeyRegistrars.forEach { $0.unregister() }
        ipcServer?.stop()
        try? FileManager.default.removeItem(atPath: PID_FILE)
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
        pid: Int32?
    ) {
        if let pid {
            resultManagedLauncherPids.remove(pid)
            launcherPids.removeAll { $0 == pid }
            voiceLauncherPids.removeAll { $0 == pid }
        }
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
            return
        }

        pendingStartFeedbackText = nil
        activeRecordingIsDictation = false
        capturedPasteTarget = nil
        if wasStopping && status == 0 && result?["action"] as? String == "stop" {
            log("dictation result success pasted=\(result?["pasted"] as? Bool == true) post_stop_ms=\(result?["post_stop_ms"] ?? 0)")
            if result?["pasted"] as? Bool == true {
                showTimedVoiceFeedback(L("已输入", "Inserted"), sound: .success, duration: 0.8)
            } else if result?["copied"] as? Bool == true {
                showTimedVoiceFeedback(L("已复制，请按 ⌘V", "Copied — press ⌘V"), sound: .failure, duration: 3.5)
            } else {
                showTimedVoiceFeedback(L("听写完成，未自动输入", "Dictation complete — not inserted"), sound: .failure, duration: 3.5)
            }
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

    @objc func onDictateToggle() {
        let stopping = (state == .recording && activeRecordingIsDictation)
        if stopping && activeDictationIntent() == "voice_chat" {
            log("voice chat recording active; ignoring dictation")
            return
        }
        let target = stopping ? nil : currentInputTargetApplication()
        let pasteTarget = stopping ? nil : capturePasteTarget(for: target)
        feedbackDismissWorkItem?.cancel()
        feedbackVisibleUntil = nil
        if stopping {
            showVoiceOverlay(L("正在输入…", "Inserting…"), animation: .processing)
            applyState(.processing)
            scheduleLongProcessingLabel()
        } else {
            capturedPasteTarget = pasteTarget
            pendingStartFeedbackText = L("听写中", "Dictating")
            applyState(.processing)
            showVoiceOverlay(L("正在启动…", "Starting…"), animation: .processing)
        }
        var launchedPid: Int32?
        let pid = RecordingLauncher.launchDictateToggle(
            targetBundleId: target?.bundleIdentifier ?? "",
            targetAppName: target?.localizedName ?? ""
        ) { [weak self] result, error, status in
            self?.handleDictationCompletion(
                result: result,
                error: error,
                status: status,
                wasStopping: stopping,
                recordingText: L("听写中", "Dictating"),
                pid: launchedPid
            )
        }
        launchedPid = pid
        if pid != nil && !stopping { scheduleStartConfirmationPolls() }
        if let pid, stopping {
            launcherPids.append(pid)
            voiceLauncherPids.append(pid)
            resultManagedLauncherPids.insert(pid)
        } else if pid == nil {
            handleDictationCompletion(
                result: nil,
                error: "launch_failed",
                status: -1,
                wasStopping: stopping,
                recordingText: L("听写中", "Dictating"),
                pid: nil
            )
        }
    }

    @objc func onDictateTranslateFromMenu() {
        onDictateTranslate(targetLanguage: dictationTargetLanguage(fallback: "English"))
    }

    func onDictateTranslate(targetLanguage: String) {
        if state == .recording && !activeRecordingIsDictation {
            log("meeting recording active; ignoring translate dictation")
            return
        }
        let stopping = (state == .recording && activeRecordingIsDictation)
        if stopping && activeDictationIntent() == "voice_chat" {
            log("voice chat recording active; ignoring translate dictation")
            return
        }
        let target = stopping ? nil : currentInputTargetApplication()
        let pasteTarget = stopping ? nil : capturePasteTarget(for: target)
        feedbackDismissWorkItem?.cancel()
        feedbackVisibleUntil = nil
        if stopping {
            showVoiceOverlay(L("正在输入…", "Inserting…"), animation: .processing)
            applyState(.processing)
            scheduleLongProcessingLabel()
        } else {
            capturedPasteTarget = pasteTarget
            pendingStartFeedbackText = L("正在翻译", "Translating")
            applyState(.processing)
            showVoiceOverlay(L("正在启动…", "Starting…"), animation: .processing)
        }
        var launchedPid: Int32?
        let pid = RecordingLauncher.launchDictateTranslateToggle(
            targetLanguage: dictationTargetLanguage(fallback: targetLanguage),
            targetBundleId: target?.bundleIdentifier ?? "",
            targetAppName: target?.localizedName ?? ""
        ) { [weak self] result, error, status in
            self?.handleDictationCompletion(
                result: result,
                error: error,
                status: status,
                wasStopping: stopping,
                recordingText: L("正在翻译", "Translating"),
                pid: launchedPid
            )
        }
        launchedPid = pid
        if pid != nil && !stopping { scheduleStartConfirmationPolls() }
        if let pid, stopping {
            launcherPids.append(pid)
            voiceLauncherPids.append(pid)
            resultManagedLauncherPids.insert(pid)
        } else if pid == nil {
            handleDictationCompletion(
                result: nil,
                error: "launch_failed",
                status: -1,
                wasStopping: stopping,
                recordingText: L("正在翻译", "Translating"),
                pid: nil
            )
        }
    }

    @objc func onVoiceChat() {
        if state == .recording && !activeRecordingIsDictation {
            log("meeting recording active; ignoring voice chat")
            return
        }
        let stopping = (state == .recording && activeRecordingIsDictation)
        if stopping && activeDictationIntent() != "voice_chat" {
            log("dictation recording active; ignoring voice chat")
            return
        }
        if let pid = RecordingLauncher.launchVoiceChatToggle() {
            if stopping {
                launcherPids.append(pid)
                voiceLauncherPids.append(pid)
                showVoiceOverlay(L("正在处理", "Processing"), wave: false)
                applyState(.processing)
            } else {
                activeRecordingIsDictation = true
                capturedPasteTarget = nil
                showVoiceOverlay(L("正在提问", "Asking"), wave: true)
                applyState(.recording)
            }
        }
    }

    @objc func onCurrentMeetingRecord(_ sender: NSMenuItem) {
        startCurrentMeeting(from: sender, join: false)
    }

    @objc func onCurrentMeetingRecordJoin(_ sender: NSMenuItem) {
        startCurrentMeeting(from: sender, join: true)
    }

    private func startCurrentMeeting(from sender: NSMenuItem, join: Bool) {
        guard let meetingId = sender.representedObject as? String,
              !meetingId.isEmpty else { return }
        _ = RecordingLauncher.launchStartMeeting(meetingId: meetingId, join: join)
    }

    private func showDaemonDownNotification() {
        log("daemon down — surfacing notification")
        let note = NSUserNotification()
        note.title = "Yulu"
        note.informativeText = L(
            "音频服务未运行，请在 Yulu 健康状态中重新启动。",
            "The audio service is not running. Restart it from Yulu Health."
        )
        NSUserNotificationCenter.default.deliver(note)
    }

    @objc func onOpenInbox() {
        if let url = URL(string: "http://127.0.0.1:7777/inbox") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func onOpenAgentConsole() {
        if let url = URL(string: "http://127.0.0.1:7777/agent-console") {
            NSWorkspace.shared.open(url)
        }
    }

    @objc func onOpenSettings() {
        if let url = URL(string: "http://127.0.0.1:7777/settings") {
            NSWorkspace.shared.open(url)
        }
    }

    private func currentInputTargetApplication() -> NSRunningApplication? {
        if let front = NSWorkspace.shared.frontmostApplication,
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
        return (true, "")
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

    func pasteClipboard(text: String? = nil, targetBundleId: String?, targetAppName: String?) -> [String: Any] {
        let bundleId = (targetBundleId ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let appName = (targetAppName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let text = (text ?? "").trimmingCharacters(in: .newlines)
        var accessibilityError = ""
        if !text.isEmpty {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(text, forType: .string)
            let captured = capturedPasteTarget
            capturedPasteTarget = nil
            if !shouldAvoidAccessibilityInsert(bundleId: bundleId, appName: appName) {
                if let captured,
                   capturedPasteTargetMatches(captured, bundleId: bundleId, appName: appName) {
                    let inserted = insertText(text, into: captured.element)
                    if inserted.0 {
                        return ["ok": true, "method": "captured_accessibility"]
                    }
                    accessibilityError = "captured_\(inserted.1)"
                }
                let inserted = insertTextWithAccessibility(text, bundleId: bundleId, appName: appName)
                if inserted.0 {
                    return ["ok": true, "method": "accessibility"]
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
        guard let pasteMethod = sendPasteKeystroke(to: runningTextTarget(bundleId: bundleId, appName: appName)) else {
            var resp: [String: Any] = ["ok": false, "error": "paste_failed"]
            if !accessibilityError.isEmpty { resp["accessibility_error"] = accessibilityError }
            return resp
        }
        var resp: [String: Any] = ["ok": true, "method": pasteMethod, "verified": false]
        if !accessibilityError.isEmpty { resp["accessibility_error"] = accessibilityError }
        return resp
    }

    func openVoiceChatWindow(urlString: String? = nil) {
        hideVoiceOverlay()
        let raw = urlString ?? "http://127.0.0.1:7777/voice-chat"
        guard let url = URL(string: raw) else { return }
        let panel: NSPanel
        if let existing = voiceChatWindow as? NSPanel {
            panel = existing
        } else {
            panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 760, height: 620),
                styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            panel.title = L("Yulu 语音对话", "Yulu Voice Chat")
            panel.isReleasedWhenClosed = false
            panel.level = .floating
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel.titlebarAppearsTransparent = true
            panel.contentView = WKWebView(frame: panel.contentView?.bounds ?? .zero)
            voiceChatWindow = panel
        }
        if let web = panel.contentView as? WKWebView {
            web.autoresizingMask = [.width, .height]
            web.load(URLRequest(url: url))
        }
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
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
        NSWorkspace.shared.open(url)
    }
}

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
