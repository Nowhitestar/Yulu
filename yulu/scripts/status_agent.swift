// Yulu Status Agent — menu-bar item + global hotkey for voicemail capture.
//
// Built as a Cocoa app with LSUIElement=true so it lives only in the menu
// bar (no Dock icon, no main window). All voicemail logic stays in
// voicemail.recorder (Phase 4); this binary is a button that shells out.

import Cocoa
import Carbon

let CONFIG_DIR = ("~/.config/yulu" as NSString).expandingTildeInPath
let PID_FILE = "\(CONFIG_DIR)/status_agent.pid"
let LOG_FILE = "\(CONFIG_DIR)/status_agent.log"

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    FileManager.default.createFile(atPath: LOG_FILE, contents: nil)  // no-op if exists
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
            title: "Start Voicemail",
            action: #selector(StatusAgentApp.onMenuToggle),
            keyEquivalent: ""
        )
        toggleItem.target = target
        toggleItem.identifier = NSUserInterfaceItemIdentifier("toggle")
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())

        let recentLabel = NSMenuItem(title: "Recent voicemails", action: nil, keyEquivalent: "")
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
            title: "Open inbox in Terminal",
            action: #selector(StatusAgentApp.onOpenInbox),
            keyEquivalent: ""
        )
        openInbox.target = target
        menu.addItem(openInbox)
        menu.addItem(NSMenuItem.separator())

        let hotkeyLabel = NSMenuItem(title: "Hotkey: (loading…)",
                                      action: nil, keyEquivalent: "")
        hotkeyLabel.isEnabled = false
        hotkeyLabel.identifier = NSUserInterfaceItemIdentifier("hotkey_label")
        menu.addItem(hotkeyLabel)
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

// Helper to read recent voicemails via the existing Python repo.
// Shells out to a tiny one-liner so we don't reimplement repo logic
// in Swift. Returns up to N (stem, has_summary) tuples; empty on error.
func loadRecentVoicemails(limit: Int = 5) -> [(stem: String, hasSummary: Bool)] {
    let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = [
        "PYTHONPATH=\(scriptDir)",
        "python3", "-c",
        """
        from voicemail.repo import list_voicemails
        for r in list_voicemails(limit=\(limit)):
            print(f"{r.stem}\\t{int(r.has_summary)}")
        """
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        log("⚠️ failed to enumerate voicemails: \(error)")
        return []
    }
    guard let data = try? pipe.fileHandleForReading.readToEnd(),
          let text = String(data: data, encoding: .utf8) else {
        return []
    }
    var out: [(stem: String, hasSummary: Bool)] = []
    for line in text.split(separator: "\n") {
        let parts = line.split(separator: "\t")
        if parts.count == 2 {
            out.append((String(parts[0]), parts[1] == "1"))
        }
    }
    return out
}

// Carbon RegisterEventHotKey wrapper.
//
// We use Carbon (not NSEvent.addGlobalMonitorForEvents) because Carbon
// doesn't require Input Monitoring permission — system-wide hotkeys with
// modifier keys work out of the box. The API is legacy but stable on
// macOS 14/15. RegisterEventHotKey contract: returns OSStatus, fills in
// an EventHotKeyRef out-parameter, fires kEventHotKeyPressed events to
// the application event target. We install one handler that fires our
// toggle closure.

class HotkeyRegistrar {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onTrigger: (() -> Void)?

    static let signature: OSType = 0x59556C75  // 'YuLu' fourcc

    func register(keyCode: UInt32, modifierMask: UInt32, _ trigger: @escaping () -> Void) -> Bool {
        unregister()
        onTrigger = trigger

        let hotKeyID = EventHotKeyID(signature: HotkeyRegistrar.signature, id: 1)
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                  eventKind: UInt32(kEventHotKeyPressed))

        // Install global handler if not yet installed
        let handler: EventHandlerUPP = { (_, eventRef, userData) -> OSStatus in
            guard let userData = userData else { return noErr }
            let me = Unmanaged<HotkeyRegistrar>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { me.onTrigger?() }
            return noErr
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            handler, 1, &spec, selfPtr, &handlerRef
        )
        if installStatus != noErr {
            log("⚠️ InstallEventHandler failed: \(installStatus)")
            return false
        }

        let regStatus = RegisterEventHotKey(
            keyCode, modifierMask, hotKeyID,
            GetApplicationEventTarget(), 0, &hotKeyRef
        )
        if regStatus != noErr {
            log("⚠️ RegisterEventHotKey failed: \(regStatus) (key conflict?)")
            return false
        }
        log("hotkey_registered keyCode=\(keyCode) modifiers=0x\(String(modifierMask, radix: 16))")
        return true
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let h = handlerRef {
            RemoveEventHandler(h)
            handlerRef = nil
        }
    }
}

// Read config (key + modifiers) by shelling to the Python helper.
// Returns (keyCode, modifierMask, prettyLabel). Falls back to ⌘⇧V on error.
func readHotkeyFromConfig() -> (keyCode: UInt32, modifierMask: UInt32, pretty: String) {
    let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = [
        "PYTHONPATH=\(scriptDir)",
        "python3", "-c",
        """
        import status_agent_config as sac
        b = sac.load()
        k = sac.keycode_for(b['hotkey']['key'])
        m = sac.modifier_mask(b['hotkey']['modifiers'])
        p = sac.format_hotkey(b['hotkey'])
        print(f'{k}\\t{m}\\t{p}')
        """
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        return (9, 0x300, "⌘⇧V")  // fallback
    }
    guard let data = try? pipe.fileHandleForReading.readToEnd(),
          let text = String(data: data, encoding: .utf8) else {
        return (9, 0x300, "⌘⇧V")
    }
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\t")
    guard parts.count == 3,
          let kc = UInt32(parts[0]),
          let mm = UInt32(parts[1]) else {
        return (9, 0x300, "⌘⇧V")
    }
    return (kc, mm, String(parts[2]))
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

        // Write JSON + newline
        var line = json
        line.append(0x0A)
        _ = line.withUnsafeBytes { buf in
            write(fd, buf.baseAddress, buf.count)
        }

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

// Spawn `voicemail.cli new` / `voicemail.cli stop` as detached subprocesses.
// All recording lifecycle + transcribe + enqueue stays in the Phase 4
// Python module — the status agent is just a button.
class VoicemailLauncher {
    static func launchNew() -> Int32? {
        let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
            ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir)",
            "python3", "-m", "voicemail.cli", "new",
        ]
        // Detach from agent's stdio so the subprocess survives independently
        task.standardInput = FileHandle.nullDevice
        let logPath = (("~/.config/yulu/status_agent_launcher.log") as NSString).expandingTildeInPath
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let logFH = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
        _ = try? logFH.seekToEnd()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch voicemail.cli new: \(error)")
            return nil
        }
    }

    static func sendStop() {
        // `voicemail.cli stop` is the user-visible idempotent stop. The
        // already-running `voicemail.cli new` subprocess detects the
        // recording→idle transition in its poll loop and triggers
        // _transcribe_and_enqueue itself; cmd_stop's role is just to send
        // the daemon stop RPC.
        let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
            ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir)",
            "python3", "-m", "voicemail.cli", "stop",
        ]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()  // stop is fast (just one socket roundtrip)
    }
}

class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    let hotkey = HotkeyRegistrar()
    var pollerTimer: Timer?
    var state: AgentState = .idle
    var daemonDownStreak: Int = 0
    var launcherPid: Int32?

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = "语"
            btn.toolTip = "Yulu — click to record voicemail"
        }
        menu = MenuBuilder.build(target: self)
        menu.delegate = self
        statusItem.menu = menu

        // Initial hotkey registration
        registerHotkeyFromConfig()

        // SIGHUP → re-read config + re-register
        let sigsrc = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
        sigsrc.setEventHandler { [weak self] in
            log("SIGHUP received — re-registering hotkey")
            self?.registerHotkeyFromConfig()
        }
        sigsrc.resume()
        // Carbon expects SIGHUP delivered to the process, so suppress the
        // default SIG_DFL action that would otherwise terminate us.
        signal(SIGHUP, SIG_IGN)

        // Start polling at 1 Hz
        pollerTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()  // immediate first tick
    }

    private func poll() {
        guard let resp = DaemonClient.send(["action": "status"]) else {
            daemonDownStreak += 1
            if daemonDownStreak >= 3 {
                applyState(.daemonDown)
            }
            return
        }
        daemonDownStreak = 0
        let recording = (resp["recording"] as? Bool) ?? false
        let file = (resp["file"] as? String) ?? ""

        if recording {
            if file.contains("/voicemails/") {
                applyState(.recording)
            } else {
                applyState(.meetingBusy)
            }
            return
        }

        // Not recording. Are we waiting for a launcher to finish (processing)?
        if let pid = launcherPid, kill(pid, 0) == 0 {
            applyState(.processing)
            return
        }
        if launcherPid != nil { launcherPid = nil }
        applyState(.idle)
    }

    private func applyState(_ new: AgentState) {
        guard new != state else { return }
        state = new
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
            case .idle:        item.title = "Start Voicemail"
            case .recording:   item.title = "● Recording — click to stop"
            case .processing:  item.title = "⋯ Transcribing…"
            case .meetingBusy: item.title = "Meeting in progress"
            case .daemonDown:  item.title = "Audio daemon not running"
            }
            item.isEnabled = (new == .idle || new == .recording)
        }
    }

    private func registerHotkeyFromConfig() {
        let (kc, mm, pretty) = readHotkeyFromConfig()
        let ok = hotkey.register(keyCode: kc, modifierMask: mm) { [weak self] in
            self?.onHotkeyToggle()
        }
        // Update the menu's hotkey label (use items.first since NSMenu has
        // no item(withIdentifier:) API)
        let wantId = NSUserInterfaceItemIdentifier("hotkey_label")
        if let item = menu.items.first(where: { $0.identifier == wantId }) {
            item.title = ok ? "Hotkey: \(pretty)" : "Hotkey: unavailable (\(pretty) — registration failed)"
        }
    }

    @objc func onHotkeyToggle() {
        log("hotkey → toggle")
        onMenuToggle()
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }

    // Refresh dynamic items whenever the menu is about to display
    func menuWillOpen(_ menu: NSMenu) {
        let recents = loadRecentVoicemails(limit: 5)
        for i in 0..<5 {
            let wantId = NSUserInterfaceItemIdentifier("recent_\(i)")
            guard let item = menu.items.first(where: { $0.identifier == wantId })
                else { continue }
            if i < recents.count {
                let r = recents[i]
                let glyph = r.hasSummary ? "✓ " : "  "
                item.title = "\(glyph)\(r.stem)"
                item.target = self
                item.action = #selector(onRecentClicked(_:))
                item.representedObject = r.stem
                item.isHidden = false
            } else {
                item.isHidden = true
            }
        }
    }

    @objc func onMenuToggle() {
        log("toggle (state=\(state.rawValue))")
        switch state {
        case .idle:
            if let pid = VoicemailLauncher.launchNew() {
                launcherPid = pid
                applyState(.recording)
            }
        case .recording:
            VoicemailLauncher.sendStop()
            // Poller will see recording=false; launcherPid still alive → processing
        case .processing:
            log("ignoring click while processing")
        case .meetingBusy:
            showMeetingBusyNotification()
        case .daemonDown:
            showDaemonDownNotification()
        }
    }

    private func showMeetingBusyNotification() {
        guard let resp = DaemonClient.send(["action": "status"]) else { return }
        let file = (resp["file"] as? String) ?? "<unknown>"
        let title = (file as NSString).lastPathComponent
        log("meeting busy: \(title)")
        let note = NSUserNotification()
        note.title = "Yulu"
        note.informativeText = "Recording in progress: \(title)"
        NSUserNotificationCenter.default.deliver(note)
    }

    private func showDaemonDownNotification() {
        log("daemon down — surfacing notification")
        let note = NSUserNotification()
        note.title = "Yulu"
        note.informativeText = "audio_daemon not running. Restart with: launchctl load ~/Library/LaunchAgents/com.yulu.audiodaemon.plist"
        NSUserNotificationCenter.default.deliver(note)
    }

    @objc func onOpenInbox() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", "tell application \"Terminal\" to do script \"yulu memo list\""]
        try? task.run()
    }

    @objc func onRecentClicked(_ sender: NSMenuItem) {
        guard let stem = sender.representedObject as? String else { return }
        let dir = ("~/Movies/Yulu/voicemails" as NSString).expandingTildeInPath
        // Prefer summary over transcript over wav
        for ext in [".summary.md", ".transcript.txt", ".wav"] {
            let path = "\(dir)/\(stem)\(ext)"
            if FileManager.default.fileExists(atPath: path) {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                return
            }
        }
    }
}

let app = NSApplication.shared
let delegate = StatusAgentApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // belt-and-braces: hide from Dock even if LSUIElement somehow missing
app.run()
