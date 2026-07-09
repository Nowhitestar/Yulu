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

func statusAgentScriptDir() -> String {
    ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
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

class MenuBuilder {
    static func build(target: AnyObject) -> NSMenu {
        let menu = NSMenu()
        // The Start/Stop title is updated dynamically by StatusAgentApp;
        // here we just provide an action wire-up.
        let toggleItem = NSMenuItem(
            title: "Start Recording",
            action: #selector(StatusAgentApp.onMenuToggle),
            keyEquivalent: ""
        )
        toggleItem.target = target
        toggleItem.identifier = NSUserInterfaceItemIdentifier("toggle")
        menu.addItem(toggleItem)

        let dictateItem = NSMenuItem(
            title: "Start Dictation",
            action: #selector(StatusAgentApp.onDictateToggle),
            keyEquivalent: ""
        )
        dictateItem.target = target
        dictateItem.identifier = NSUserInterfaceItemIdentifier("dictate_once")
        menu.addItem(dictateItem)
        let voiceChatItem = NSMenuItem(
            title: "Ask Agent by Voice",
            action: #selector(StatusAgentApp.onVoiceChat),
            keyEquivalent: ""
        )
        voiceChatItem.target = target
        voiceChatItem.identifier = NSUserInterfaceItemIdentifier("voice_chat")
        menu.addItem(voiceChatItem)
        menu.addItem(NSMenuItem.separator())
        let hotkeyLabel = NSMenuItem(title: "Hotkeys: loading...", action: nil, keyEquivalent: "")
        hotkeyLabel.isEnabled = false
        hotkeyLabel.identifier = NSUserInterfaceItemIdentifier("hotkeys_label")
        menu.addItem(hotkeyLabel)
        menu.addItem(NSMenuItem.separator())

        let currentLabel = NSMenuItem(title: "Current meeting", action: nil, keyEquivalent: "")
        currentLabel.identifier = NSUserInterfaceItemIdentifier("current_meeting_label")
        currentLabel.isEnabled = false
        currentLabel.isHidden = true
        menu.addItem(currentLabel)

        let currentRecord = NSMenuItem(
            title: "Record current meeting",
            action: #selector(StatusAgentApp.onCurrentMeetingRecord(_:)),
            keyEquivalent: ""
        )
        currentRecord.target = target
        currentRecord.identifier = NSUserInterfaceItemIdentifier("current_meeting_record")
        currentRecord.isHidden = true
        menu.addItem(currentRecord)

        let currentJoin = NSMenuItem(
            title: "Record and join current meeting",
            action: #selector(StatusAgentApp.onCurrentMeetingRecordJoin(_:)),
            keyEquivalent: ""
        )
        currentJoin.target = target
        currentJoin.identifier = NSUserInterfaceItemIdentifier("current_meeting_join")
        currentJoin.isHidden = true
        menu.addItem(currentJoin)

        let currentSep = NSMenuItem.separator()
        currentSep.identifier = NSUserInterfaceItemIdentifier("current_meeting_separator")
        currentSep.isHidden = true
        menu.addItem(currentSep)

        let recentLabel = NSMenuItem(title: "Recent recordings", action: nil, keyEquivalent: "")
        recentLabel.isEnabled = false
        menu.addItem(recentLabel)
        // Up to 5 dynamic items inserted here at menuWillOpen time
        for i in 0..<5 {
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.identifier = NSUserInterfaceItemIdentifier("recent_\(i)")
            item.isHidden = true
            menu.addItem(item)
        }
        let openInbox = NSMenuItem(
            title: "Open inbox",
            action: #selector(StatusAgentApp.onOpenInbox),
            keyEquivalent: ""
        )
        openInbox.target = target
        menu.addItem(openInbox)
        let openAgentConsole = NSMenuItem(
            title: "Open Agent Console",
            action: #selector(StatusAgentApp.onOpenAgentConsole),
            keyEquivalent: ""
        )
        openAgentConsole.target = target
        menu.addItem(openAgentConsole)
        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(
            title: "Quit Yulu Status Agent",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quit)
        return menu
    }
}

struct RecentRecording {
    let stem: String
    let mtime: Date
}

struct CurrentMeeting {
    let id: String
    let title: String
    let link: String
    let start: Date
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
                start: start
            ))
        }
    }
    return matches.sorted { $0.start > $1.start }.first
}

func shortMeetingTitle(_ title: String) -> String {
    if title.count <= 38 { return title }
    return "\(title.prefix(35))..."
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

func defaultHotkeySpecs() -> [HotkeySpec] {
    [
        HotkeySpec(action: "dictate", keyCode: 49, modifierMask: 0x1800, label: "⌃⌥Space", targetLanguage: ""),
        HotkeySpec(action: "translate", keyCode: 17, modifierMask: 0x1800, label: "⌃⌥T", targetLanguage: "English"),
        HotkeySpec(action: "voice_chat", keyCode: 0, modifierMask: 0x1800, label: "⌃⌥A", targetLanguage: ""),
    ]
}

func readHotkeysFromConfig() -> [HotkeySpec] {
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = [
        "PYTHONPATH=\(statusAgentScriptDir())",
        "python3", "status_agent_config.py", "hotkeys", "--json",
    ]
    task.currentDirectoryURL = URL(fileURLWithPath: statusAgentScriptDir())
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
    case none, recording, processing
}

class VoiceWaveView: NSView {
    private var tick = 0
    private var timer: Timer?
    var mode: VoiceOverlayAnimationMode = .recording {
        didSet { needsDisplay = true }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
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
        NSColor.controlAccentColor.setFill()
        if mode == .processing {
            let dots = 3
            let size: CGFloat = 5
            let gap: CGFloat = 5
            let total = CGFloat(dots) * size + CGFloat(dots - 1) * gap
            let startX = (bounds.width - total) / 2
            for i in 0..<dots {
                let phase = Double(tick + i * 3) * 0.38
                let alpha = CGFloat(0.35 + (sin(phase) + 1) * 0.28)
                NSColor.controlAccentColor.withAlphaComponent(alpha).setFill()
                let x = startX + CGFloat(i) * (size + gap)
                let y = (bounds.height - size) / 2
                NSBezierPath(ovalIn: NSRect(x: x, y: y, width: size, height: size)).fill()
            }
            return
        }
        let bars = 5
        let gap: CGFloat = 2
        let width: CGFloat = 3
        let total = CGFloat(bars) * width + CGFloat(bars - 1) * gap
        let startX = (bounds.width - total) / 2
        for i in 0..<bars {
            let phase = Double(tick + i * 2) * 0.42
            let height = CGFloat(8 + (sin(phase) + 1) * 10)
            let x = startX + CGFloat(i) * (width + gap)
            let y = (bounds.height - height) / 2
            NSBezierPath(roundedRect: NSRect(x: x, y: y, width: width, height: height), xRadius: 2, yRadius: 2).fill()
        }
    }
}

class VoiceOverlayContainerView: NSView {
    var onCancel: (() -> Void)?

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
    }

    private func configureLayer() {
        wantsLayer = true
        guard let layer = layer else { return }
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let fill = isDark
            ? NSColor(calibratedRed: 0.07, green: 0.09, blue: 0.13, alpha: 0.96)
            : NSColor(calibratedRed: 0.96, green: 0.985, blue: 1.0, alpha: 0.97)
        layer.backgroundColor = fill.cgColor
        layer.cornerRadius = 20
        layer.borderWidth = 1
        layer.borderColor = NSColor.controlAccentColor.withAlphaComponent(isDark ? 0.20 : 0.16).cgColor
        layer.shadowColor = NSColor.black.cgColor
        layer.shadowOpacity = isDark ? 0.32 : 0.12
        layer.shadowRadius = 16
        layer.shadowOffset = NSSize(width: 0, height: 6)
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func mouseDown(with event: NSEvent) {
        alphaValue = 0.76
        onCancel?()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.alphaValue = 1.0
        }
    }
}

// Enumerate the recordings directory directly off disk (no Python, no
// dependency on the web server). Sort newest-first, return top N. Every
// recording now lives in the single root directory (the historical
// ~/Movies/Yulu/memos subdirectory was merged into the root by the
// recording-unify migration).
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
            out.append(RecentRecording(stem: stem, mtime: mtime))
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
        img.isTemplate = true
        return img
    }
}

// Spawn `meeting_daemon.py start` / `meeting_daemon.py stop` as detached
// subprocesses — the same path `yulu record start` / `yulu record stop`
// drive. The recording is always mic + system audio (no mic-only mode);
// the status agent is just a button + indicator, all recording lifecycle +
// transcribe + enqueue stays in the Python pipeline.
class RecordingLauncher {
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
        return "Recording"
    }

    // Start a meeting recording (mic + system). meeting_daemon.py start sends
    // the daemon start RPC and returns immediately; the agent's poller then
    // observes recording=true off the audio daemon and drives the indicator.
    @discardableResult
    static func launchStart(title: String) -> Int32? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "meeting_daemon.py", "start", title,
        ]
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var args = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "meeting_daemon.py", "start_meeting", meetingId,
        ]
        if join { args.append("--join") }
        task.arguments = args
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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
    // then runs the (potentially slow) transcribe + enqueue pipeline, so it's
    // spawned detached and its PID returned to the caller — the agent tracks it
    // as the "processing" launcher until it exits.
    @discardableResult
    static func launchStop() -> Int32? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "meeting_daemon.py", "stop",
        ]
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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

    @discardableResult
    static func launchDictateToggle(targetBundleId: String = "", targetAppName: String = "") -> Int32? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var args = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "dictate.py", "toggle",
            "--json",
        ]
        if !targetBundleId.isEmpty {
            args.append(contentsOf: ["--target-bundle-id", targetBundleId])
        }
        if !targetAppName.isEmpty {
            args.append(contentsOf: ["--target-app-name", targetAppName])
        }
        task.arguments = args
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py toggle: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchDictateTranslateToggle(targetLanguage: String, targetBundleId: String = "", targetAppName: String = "") -> Int32? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var args = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "dictate.py", "toggle",
            "--translate-to", targetLanguage.isEmpty ? "English" : targetLanguage,
            "--json",
        ]
        if !targetBundleId.isEmpty {
            args.append(contentsOf: ["--target-bundle-id", targetBundleId])
        }
        if !targetAppName.isEmpty {
            args.append(contentsOf: ["--target-app-name", targetAppName])
        }
        task.arguments = args
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
        task.standardInput = FileHandle.nullDevice
        let logFH = launcherLog()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch dictate.py translate toggle: \(error)")
            return nil
        }
    }

    @discardableResult
    static func launchWarmDictation(targetLanguage: String = "") -> Int32? {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        var args = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "dictate.py", "warm",
            "--timeout-sec", "90",
            "--json",
        ]
        if !targetLanguage.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            args.append(contentsOf: ["--translate-to", targetLanguage])
        }
        task.arguments = args
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "dictate.py", "ask-toggle",
            "--no-paste",
            "--no-copy",
            "--json",
        ]
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir())",
            "python3", "dictate.py", "cancel",
            "--json",
        ]
        task.currentDirectoryURL = URL(fileURLWithPath: scriptDir())
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

        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = ["python3", "-m", "search.ipc_helper"]
        var env = ProcessInfo.processInfo.environment
        let existing = env["PYTHONPATH"] ?? ""
        env["PYTHONPATH"] = existing.isEmpty
            ? scriptsDir
            : "\(scriptsDir):\(existing)"
        task.environment = env

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
    // ponytail: one pending dictation target; add per-session IDs if overlapping dictations need exact cursor restore.
    var capturedPasteTarget: CapturedPasteTarget?
    var pollerTimer: Timer?
    var state: AgentState = .idle
    var activeRecordingIsDictation = false
    var daemonDownStreak: Int = 0
    var launcherPids: [Int32] = []
    var voiceLauncherPids: [Int32] = []
    var hotkeyRegistrars: [HotkeyRegistrar] = []
    var sighupSource: DispatchSourceSignal?
    // IPC server exposing `status` / `toggle` / `open_inbox` on
    // ~/.config/yulu/status_agent.sock. Lets `yulu status-agent toggle`
    // and acceptance tests drive the agent without UI clicks.
    var ipcServer: IPCServer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = "语"
            btn.toolTip = "Yulu — click to record"
        }
        menu = MenuBuilder.build(target: self)
        menu.delegate = self
        statusItem.menu = menu
        registerHotkeysFromConfig()
        _ = RecordingLauncher.launchWarmDictation()
        _ = RecordingLauncher.launchWarmDictation(targetLanguage: dictationTargetLanguage(fallback: "English"))
        signal(SIGHUP, SIG_IGN)
        sighupSource = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
        sighupSource?.setEventHandler { [weak self] in
            log("SIGHUP received — re-registering hotkeys")
            self?.registerHotkeysFromConfig()
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

    private func registerHotkeysFromConfig() {
        hotkeyRegistrars.forEach { $0.unregister() }
        hotkeyRegistrars = []
        let specs = readHotkeysFromConfig()
        var labels: [String] = []
        for (idx, spec) in specs.enumerated() {
            let registrar = HotkeyRegistrar(id: UInt32(idx + 1))
            let ok = registrar.register(keyCode: spec.keyCode, modifierMask: spec.modifierMask) { [weak self] in
                self?.onHotkey(spec)
            }
            if ok { hotkeyRegistrars.append(registrar) }
            let name: String
            switch spec.action {
            case "dictate": name = "Dictate"
            case "translate": name = "Translate"
            case "voice_chat": name = "Ask"
            default: name = spec.action
            }
            labels.append(ok ? "\(name) \(spec.label)" : "\(name) unavailable")
        }
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("hotkeys_label") }) {
            item.title = "Hotkeys: \(labels.joined(separator: " · "))"
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

        if recording {
            let file = (resp["file"] as? String) ?? ""
            activeRecordingIsDictation = file.hasPrefix("\(CONFIG_DIR)/dictation/")
            applyState(.recording)
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
        let active = launcherPids.filter { pidIsActive($0) }
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
                contentRect: NSRect(x: 0, y: 0, width: 120, height: 40),
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

            let visual = VoiceOverlayContainerView(frame: panel.contentView?.bounds ?? NSRect(x: 0, y: 0, width: 120, height: 40))
            visual.autoresizingMask = [.width, .height]
            visual.onCancel = { [weak self] in
                self?.cancelVoiceInputFromOverlay()
            }

            let label = NSTextField(labelWithString: text)
            label.alignment = .left
            label.font = .systemFont(ofSize: 13, weight: .semibold)
            label.textColor = .labelColor
            label.translatesAutoresizingMaskIntoConstraints = false

            let waveView = VoiceWaveView()
            waveView.translatesAutoresizingMaskIntoConstraints = false
            let content = NSView()
            content.translatesAutoresizingMaskIntoConstraints = false

            visual.addSubview(content)
            content.addSubview(waveView)
            content.addSubview(label)
            NSLayoutConstraint.activate([
                content.centerXAnchor.constraint(equalTo: visual.centerXAnchor),
                content.centerYAnchor.constraint(equalTo: visual.centerYAnchor),
                content.leadingAnchor.constraint(greaterThanOrEqualTo: visual.leadingAnchor, constant: 8),
                content.trailingAnchor.constraint(lessThanOrEqualTo: visual.trailingAnchor, constant: -8),
                waveView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
                waveView.centerYAnchor.constraint(equalTo: content.centerYAnchor),
                waveView.widthAnchor.constraint(equalToConstant: 24),
                waveView.heightAnchor.constraint(equalToConstant: 20),
                label.leadingAnchor.constraint(equalTo: waveView.trailingAnchor, constant: 6),
                label.trailingAnchor.constraint(equalTo: content.trailingAnchor),
                label.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            ])

            panel.contentView = visual
            voiceOverlayWindow = panel
            voiceOverlayLabel = label
            voiceOverlayWave = waveView
        }

        voiceOverlayLabel?.stringValue = text
        voiceOverlayWave?.mode = animation
        voiceOverlayWave?.isHidden = animation == .none
        if let screen = NSScreen.main {
            let f = screen.visibleFrame
            panel.setFrameOrigin(NSPoint(x: f.midX - panel.frame.width / 2, y: f.minY + 86))
        }
        panel.orderFrontRegardless()
    }

    private func hideVoiceOverlay() {
        voiceOverlayWindow?.orderOut(nil)
    }

    private func cancelVoiceInputFromOverlay() {
        log("voice overlay clicked — canceling active voice input")
        let voicePids = activeVoiceLauncherPids()
        for pid in voicePids {
            _ = kill(pid, SIGTERM)
        }
        let canceled = Set(voicePids)
        launcherPids.removeAll { canceled.contains($0) }
        voiceLauncherPids.removeAll { canceled.contains($0) }
        _ = RecordingLauncher.launchDictateCancel()
        activeRecordingIsDictation = false
        capturedPasteTarget = nil
        applyState(.idle)
        showVoiceOverlay("已取消", animation: .none)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
            if self?.state == .idle {
                self?.hideVoiceOverlay()
            }
        }
    }

    private func applyState(_ new: AgentState) {
        state = new
        if new == .idle || new == .daemonDown {
            hideVoiceOverlay()
        }
        if let btn = statusItem.button {
            if let img = IconStateMachine.image(for: new) {
                btn.image = img
                btn.title = ""
            } else {
                // Fallback if assets missing — keep text glyph
                btn.image = nil
                switch new {
                case .idle:        btn.title = "语"
                case .recording:   btn.title = "● 语"
                case .processing:  btn.title = "⋯ 语"
                case .meetingBusy: btn.title = "🟡 语"
                case .daemonDown:  btn.title = "🚫 语"
                }
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
            case .idle:        item.title = "Start Recording"
            case .recording:   item.title = activeRecordingIsDictation ? "Dictation in progress" : "● Recording — click to stop"
            case .processing:  item.title = "Start Recording (transcribing previous)"
            case .meetingBusy: item.title = "Meeting in progress"
            case .daemonDown:  item.title = "Audio daemon not running"
            }
            item.isEnabled = (new == .idle || (new == .recording && !activeRecordingIsDictation) || new == .processing)
        }
        let voiceChatActive = (new == .recording && activeRecordingIsDictation && activeDictationIntent() == "voice_chat")
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("dictate_once") }) {
            item.title = voiceChatActive ? "Voice Chat in progress" : ((new == .recording && activeRecordingIsDictation) ? "Stop Dictation" : "Start Dictation")
            item.isEnabled = (new == .idle || new == .processing || (new == .recording && activeRecordingIsDictation && !voiceChatActive))
        }
        if let item = menu.items.first(where: { $0.identifier == NSUserInterfaceItemIdentifier("voice_chat") }) {
            item.title = voiceChatActive ? "Stop Voice Chat" : "Ask Agent by Voice"
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
        for i in 0..<5 {
            let wantId = NSUserInterfaceItemIdentifier("recent_\(i)")
            guard let item = menu.items.first(where: { $0.identifier == wantId })
                else { continue }
            if i < recents.count {
                let r = recents[i]
                item.title = r.stem
                item.target = self
                item.action = #selector(onRecentClicked(_:))
                item.representedObject = r.stem
                item.isHidden = false
            } else {
                item.isHidden = true
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

        label?.isHidden = !visible
        record?.isHidden = !visible
        sep?.isHidden = !visible

        guard let meeting = meeting else {
            join?.isHidden = true
            return
        }

        let title = shortMeetingTitle(meeting.title)
        record?.title = "Record: \(title)"
        record?.representedObject = meeting.id
        record?.isEnabled = canStart

        join?.title = "Record and join: \(title)"
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
            // Spawn the stop+transcribe pipeline detached and track its PID so
            // the indicator shows "processing" until the transcript is written.
            if let pid = RecordingLauncher.launchStop() {
                launcherPids.append(pid)
                applyState(.processing)
            }
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
        if RecordingLauncher.launchStart(title: title) != nil {
            // meeting_daemon.py start returns immediately; the poller observes
            // recording=true and drives the indicator. Stop launchers remain in
            // launcherPids so prior transcription can finish in the background.
            applyState(.recording)
        }
    }

    @objc func onDictateToggle() {
        let stopping = (state == .recording && activeRecordingIsDictation)
        if stopping && activeDictationIntent() == "voice_chat" {
            log("voice chat recording active; ignoring dictation")
            return
        }
        let target = stopping ? nil : currentInputTargetApplication()
        let pasteTarget = stopping ? nil : capturePasteTarget(for: target)
        if let pid = RecordingLauncher.launchDictateToggle(
            targetBundleId: target?.bundleIdentifier ?? "",
            targetAppName: target?.localizedName ?? ""
        ) {
            if stopping {
                launcherPids.append(pid)
                voiceLauncherPids.append(pid)
                showVoiceOverlay("正在处理", wave: false)
                applyState(.processing)
            } else {
                activeRecordingIsDictation = true
                capturedPasteTarget = pasteTarget
                showVoiceOverlay("正在听写", wave: true)
                applyState(.recording)
            }
        }
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
        if let pid = RecordingLauncher.launchDictateTranslateToggle(
            targetLanguage: dictationTargetLanguage(fallback: targetLanguage),
            targetBundleId: target?.bundleIdentifier ?? "",
            targetAppName: target?.localizedName ?? ""
        ) {
            if stopping {
                launcherPids.append(pid)
                voiceLauncherPids.append(pid)
                showVoiceOverlay("正在处理", wave: false)
                applyState(.processing)
            } else {
                activeRecordingIsDictation = true
                capturedPasteTarget = pasteTarget
                showVoiceOverlay("正在翻译", wave: true)
                applyState(.recording)
            }
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
                showVoiceOverlay("正在处理", wave: false)
                applyState(.processing)
            } else {
                activeRecordingIsDictation = true
                capturedPasteTarget = nil
                showVoiceOverlay("正在提问", wave: true)
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
        if RecordingLauncher.launchStartMeeting(meetingId: meetingId, join: join) != nil {
            applyState(.recording)
        }
    }

    private func showDaemonDownNotification() {
        log("daemon down — surfacing notification")
        let note = NSUserNotification()
        note.title = "Yulu"
        note.informativeText = "audio_daemon not running. Restart with: launchctl load ~/Library/LaunchAgents/com.yulu.audiodaemon.plist"
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

    private func currentInputTargetApplication() -> NSRunningApplication? {
        if let front = NSWorkspace.shared.frontmostApplication,
           isUsableInputTarget(front) {
            return front
        }
        return NSWorkspace.shared.runningApplications.first { app in
            app.isActive && isUsableInputTarget(app)
        }
    }

    private func isUsableInputTarget(_ app: NSRunningApplication) -> Bool {
        let bundleId = app.bundleIdentifier ?? ""
        if bundleId == "com.apple.loginwindow" || bundleId == Bundle.main.bundleIdentifier {
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
            panel.title = "Yulu Voice Chat"
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

let app = NSApplication.shared
let delegate = StatusAgentApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // belt-and-braces: hide from Dock even if LSUIElement somehow missing
app.run()
