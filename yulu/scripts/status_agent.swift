// Yulu Status Agent — menu-bar item + recording indicator.
//
// Built as a Cocoa app with LSUIElement=true so it lives only in the menu
// bar (no Dock icon, no main window). The "Start Recording" menu item shells
// out to `yulu record start` (mic + system audio); this binary is a button
// plus a live recording-state indicator polled off the audio daemon.

import Cocoa

let CONFIG_DIR = ("~/.config/yulu" as NSString).expandingTildeInPath
let PID_FILE = "\(CONFIG_DIR)/status_agent.pid"
let LOG_FILE = "\(CONFIG_DIR)/status_agent.log"
let IPC_SOCKET_PATH = "\(CONFIG_DIR)/status_agent.sock"

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
        menu.addItem(NSMenuItem.separator())

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
        case "open_inbox":
            DispatchQueue.main.async { [weak self] in self?.app?.onOpenInbox() }
            sendJSON(c, ["ok": true])
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
            if let pid = app.launcherPid { resp["launcher_pid"] = Int(pid) }
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
    var pollerTimer: Timer?
    var state: AgentState = .idle
    var daemonDownStreak: Int = 0
    var launcherPid: Int32?
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
            // Any active recording — whether started from this menu, the
            // `yulu record start` CLI, or a calendar auto-record — is a
            // meeting (mic + system). The agent can stop any of them, so we
            // surface a single clickable "recording" state.
            applyState(.recording)
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
            case .idle:        item.title = "Start Recording"
            case .recording:   item.title = "● Recording — click to stop"
            case .processing:  item.title = "⋯ Transcribing…"
            case .meetingBusy: item.title = "Meeting in progress"
            case .daemonDown:  item.title = "Audio daemon not running"
            }
            item.isEnabled = (new == .idle || new == .recording)
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        ipcServer?.stop()
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }

    // Refresh dynamic items whenever the menu is about to display
    func menuWillOpen(_ menu: NSMenu) {
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

    @objc func onMenuToggle() {
        log("toggle (state=\(state.rawValue))")
        switch state {
        case .idle:
            let title = RecordingLauncher.defaultTitle()
            if RecordingLauncher.launchStart(title: title) != nil {
                // meeting_daemon.py start returns immediately; the poller
                // observes recording=true and drives the indicator. We don't
                // track this PID — the stop launcher is the one that owns the
                // (slow) transcribe pipeline and the "processing" state.
                applyState(.recording)
            }
        case .recording:
            // Spawn the stop+transcribe pipeline detached and track its PID so
            // the indicator shows "processing" until the transcript is written.
            launcherPid = RecordingLauncher.launchStop()
        case .processing:
            log("ignoring click while processing")
        case .meetingBusy:
            // Unreachable from the poller (any recording is now surfaced as
            // .recording), kept only for switch exhaustiveness.
            applyState(.recording)
        case .daemonDown:
            showDaemonDownNotification()
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
