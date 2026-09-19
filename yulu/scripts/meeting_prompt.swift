import Cocoa

let HOME_DIR = FileManager.default.homeDirectoryForCurrentUser.path

func environmentDirectory(_ name: String, fallback: String) -> String {
    guard let raw = ProcessInfo.processInfo.environment[name],
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
let LEGACY_READ_ONLY_DATA_DIR = environmentDirectory(
    "YULU_LEGACY_READ_ONLY_DATA_DIR",
    fallback: "\(HOME_DIR)/.config/yulu"
)
let CONFIG_READ_PATHS = [
    "\(DURABLE_DATA_DIR)/config.json",
    "\(LEGACY_READ_ONLY_DATA_DIR)/config.json",
]

func configData() -> Data? {
    for path in CONFIG_READ_PATHS {
        if let data = FileManager.default.contents(atPath: path) { return data }
    }
    return nil
}

enum AppLanguage: String {
    case zh, en
}

func readAppLanguage() -> AppLanguage {
    guard let data = configData(),
          let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let ui = raw["ui"] as? [String: Any],
          let value = ui["language"] as? String,
          let language = AppLanguage(rawValue: value) else { return .zh }
    return language
}

let activeAppLanguage = readAppLanguage()

func L(_ zh: String, _ en: String) -> String {
    activeAppLanguage == .zh ? zh : en
}


/// Native confirmation layout adapts to long titles, appearance and text size.
/// The helper only returns a choice; the capture controller owns the action.
struct MeetingPrompt {
    let title: String
    let link: String
    let primaryAction: String
    let stopping: Bool

    var heading: String { stopping ? L("会议结束了吗？", "Has the meeting ended?") : L("开始录音？", "Start recording?") }
    var detail: String {
        let clean = title.components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
        let subject = clean.isEmpty ? L("未命名会议", "Untitled meeting") : String(clean.prefix(240)) + (clean.count > 240 ? "…" : "")
        return stopping
            ? subject + "\n" + L("已到预计结束时间，录音仍在继续。", "The scheduled end time has passed. Recording is still running.")
            : subject
    }
    var defaultTitle: String { stopping ? L("继续录音", "Keep recording") : L("开始录音", "Start recording") }
    var otherTitle: String { stopping ? L("停止录音", "Stop recording") : L("暂不录音", "Not now") }
    var canJoin: Bool { !stopping && !link.isEmpty }

    func choice(confirmed: Bool, join: Bool) -> String {
        if stopping { return confirmed ? "continue" : "stop" }
        return confirmed ? (canJoin && join ? "record_join" : "record") : "ignore"
    }
}

func promptIcon() -> NSImage? {
    var directory = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.deletingLastPathComponent()
    for _ in 0..<6 {
        for relative in ["Yulu.icns", "Resources/Yulu.icns", "Contents/Resources/Yulu.icns", "assets/Yulu.icns"] {
            if let icon = NSImage(contentsOf: directory.appendingPathComponent(relative)) { return icon }
        }
        directory.deleteLastPathComponent()
    }
    return NSImage(systemSymbolName: "waveform", accessibilityDescription: "Yulu")
}

final class PromptApp: NSObject, NSApplicationDelegate {
    let prompt: MeetingPrompt
    let timeout: TimeInterval?
    var timer: Timer?
    var timedOut = false

    init(prompt: MeetingPrompt, timeout: TimeInterval?) { self.prompt = prompt; self.timeout = timeout }

    func applicationDidFinishLaunching(_ notification: Notification) {
        let alert = NSAlert()
        alert.messageText = prompt.heading
        alert.informativeText = prompt.detail
        alert.alertStyle = .informational
        alert.icon = promptIcon()
        NSApp.applicationIconImage = alert.icon
        alert.addButton(withTitle: prompt.defaultTitle).keyEquivalent = "\r"
        alert.addButton(withTitle: prompt.otherTitle).keyEquivalent = prompt.stopping ? "" : "\u{1b}"
        // Escape must keep capture running in a stop confirmation.
        let escapeMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            if self?.prompt.stopping == true && event.keyCode == 53 {
                NSApp.abortModal()
                return nil
            }
            return event
        }
        defer { if let escapeMonitor { NSEvent.removeMonitor(escapeMonitor) } }
        if prompt.canJoin {
            alert.showsSuppressionButton = true
            alert.suppressionButton?.title = L("同时加入会议", "Also join the meeting")
            alert.suppressionButton?.state = prompt.primaryAction == "record_join" ? .on : .off
        }
        if let timeout, timeout > 0 {
            timer = Timer(timeInterval: timeout, repeats: false) { [weak self] _ in
                self?.timedOut = true
                NSApp.abortModal()
            }
            RunLoop.main.add(timer!, forMode: .modalPanel)
        }
        NSApp.activate(ignoringOtherApps: true)
        let response = alert.runModal()
        timer?.invalidate()
        let join = alert.suppressionButton?.state == .on
        let choice: String
        if timedOut || response == .abort || response == .cancel {
            choice = prompt.stopping ? "continue" : "ignore"
        } else {
            choice = prompt.choice(confirmed: response == .alertFirstButtonReturn, join: join)
        }
        printPayload(["choice": choice, "primary_action": prompt.canJoin && join ? "record_join" : "record"])
        NSApp.terminate(nil)
    }
}

func printPayload(_ payload: [String: String]) {
    let data = try! JSONSerialization.data(withJSONObject: payload)
    print(String(data: data, encoding: .utf8)!)
    fflush(stdout)
}

if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--self-test" {
    printPayload(["choice": "record", "primary_action": "record"])
    exit(0)
}
let args = CommandLine.arguments
let prompt = MeetingPrompt(
    title: args.count > 1 ? args[1] : L("未命名会议", "Untitled meeting"),
    link: args.count > 2 ? args[2] : "",
    primaryAction: args.count > 3 ? args[3] : "record",
    stopping: args.count > 4 && args[4] == "stop"
)
let app = NSApplication.shared
let delegate = PromptApp(prompt: prompt, timeout: args.count > 5 ? TimeInterval(args[5]) : nil)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
