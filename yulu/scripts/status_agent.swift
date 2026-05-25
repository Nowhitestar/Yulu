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
          let text = String(data: data ?? Data(), encoding: .utf8) else {
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

class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!

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
        // Wired in D.5 (VoicemailLauncher). For now, just log.
        log("menu → Start/Stop tapped (toggle stub)")
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
