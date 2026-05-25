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

class StatusAgentApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            // Placeholder: text glyph until the icon assets are wired in D.2.
            btn.title = "语"
            btn.toolTip = "Yulu — click to record voicemail"
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }
}

let app = NSApplication.shared
let delegate = StatusAgentApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // belt-and-braces: hide from Dock even if LSUIElement somehow missing
app.run()
