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

extension NSColor {
    convenience init(hex: String, alpha: CGFloat = 1) {
        var s = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt64(s, radix: 16) else {
            self.init(calibratedWhite: 0, alpha: alpha); return
        }
        self.init(
            calibratedRed: CGFloat((v >> 16) & 0xff) / 255,
            green: CGFloat((v >> 8) & 0xff) / 255,
            blue: CGFloat(v & 0xff) / 255,
            alpha: alpha
        )
    }
}

struct PromptTheme {
    let glass: NSColor
    let edge: NSColor
    let edgeTop: NSColor
    let text: NSColor
    let muted: NSColor
    let accent: NSColor
    let red: NSColor

    static func load() -> PromptTheme {
        guard let data = configData(),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let ui = raw["ui"] as? [String: Any],
              let theme = ui["theme"] as? [String: Any] else {
            return preset(family: "default", mode: systemMode())
        }
        let family = theme["family"] as? String ?? "default"
        let mode = resolvedMode(theme["mode"] as? String)
        if family == "custom",
           let custom = theme["custom"] as? [String: Any],
           let tokens = custom[mode] as? [String: Any] {
            return customTheme(tokens: tokens, dark: mode == "dark")
        }
        return preset(family: family, mode: mode)
    }

    static func resolvedMode(_ mode: String?) -> String {
        if mode == "light" || mode == "dark" { return mode! }
        return systemMode()
    }

    static func systemMode() -> String {
        let match = NSApplication.shared.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua])
        return match == .darkAqua ? "dark" : "light"
    }

    static func customTheme(tokens: [String: Any], dark: Bool) -> PromptTheme {
        let surface = str(tokens["surface"], fallback: dark ? "#1c2534" : "#ffffff")
        let edge = str(tokens["edge"], fallback: dark ? "#5c6678" : "#9aa9bc")
        let text = str(tokens["text"], fallback: dark ? "#f4f7fb" : "#172033")
        let muted = str(tokens["muted"], fallback: dark ? "#a7b1c2" : "#687488")
        let accent = str(tokens["accent"], fallback: dark ? "#69a7ff" : "#1473e6")
        let red = str(tokens["red"], fallback: dark ? "#ff6961" : "#d70015")
        return PromptTheme(
            glass: NSColor(hex: surface, alpha: dark ? 0.78 : 0.90),
            edge: NSColor(hex: edge, alpha: dark ? 0.34 : 0.28),
            edgeTop: NSColor.white.withAlphaComponent(dark ? 0.10 : 0.78),
            text: NSColor(hex: text),
            muted: NSColor(hex: muted),
            accent: NSColor(hex: accent),
            red: NSColor(hex: red)
        )
    }

    static func str(_ v: Any?, fallback: String) -> String {
        return (v as? String)?.isEmpty == false ? (v as! String) : fallback
    }

    static func preset(family: String, mode: String) -> PromptTheme {
        let dark = mode == "dark"
        switch (family, mode) {
        case ("ayu", "light"):
            return make("#fcfcfc", "#6b7d8f", "#5c6166", "#828e9f", "#f29718", "#e65050", false)
        case ("ayu", "dark"):
            return make("#10141c", "#ffffff", "#bfbdb6", "#5a6378", "#e6b450", "#d95757", true)
        case ("paper", "light"):
            return make("#f7f7f7", "#444444", "#444444", "#6e6e6e", "#005f87", "#af0000", false)
        case ("paper", "dark"):
            return make("#262626", "#d0d0d0", "#d0d0d0", "#a8a8a8", "#5f8787", "#af005f", true)
        default:
            return dark
                ? make("#10151e", "#ffffff", "#f4f7fb", "#a7b1c2", "#69a7ff", "#ff6961", true)
                : make("#ffffff", "#e7f1ff", "#172033", "#687488", "#1473e6", "#d70015", false)
        }
    }

    static func make(_ glassHex: String, _ edgeHex: String, _ textHex: String,
                     _ mutedHex: String, _ accentHex: String, _ redHex: String,
                     _ dark: Bool) -> PromptTheme {
        return PromptTheme(
            glass: NSColor(hex: glassHex, alpha: dark ? 0.78 : 0.90),
            edge: NSColor(hex: edgeHex, alpha: dark ? 0.10 : 0.28),
            edgeTop: NSColor.white.withAlphaComponent(dark ? 0.10 : 0.78),
            text: NSColor(hex: textHex),
            muted: NSColor(hex: mutedHex),
            accent: NSColor(hex: accentHex),
            red: NSColor(hex: redHex)
        )
    }
}

final class DotView: NSView {
    var theme = PromptTheme.load()

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let c = NSPoint(x: bounds.midX, y: bounds.midY)
        ctx.setStrokeColor(theme.red.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(2)
        ctx.addArc(center: c, radius: 8, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        ctx.setFillColor(theme.red.cgColor)
        ctx.addArc(center: c, radius: 3.5, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.fillPath()
    }
}

final class PromptApp: NSObject, NSApplicationDelegate {
    let meetingTitle: String
    let meetingLink: String
    let initialAction: String
    let theme = PromptTheme.load()
    var selectedAction: String
    var window: NSWindow!
    var primaryButton: NSButton!
    var actionMenu: NSPopUpButton!

    init(title: String, link: String, primaryAction: String) {
        self.meetingTitle = title
        self.meetingLink = link
        let canJoin = !link.isEmpty
        self.initialAction = canJoin && primaryAction == "record_join" ? "record_join" : "record"
        self.selectedAction = self.initialAction
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        makeWindow()
        makeUI()
        window.center()
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
    }

    func makeWindow() {
        let rect = NSRect(x: 0, y: 0, width: 560, height: 246)
        window = NSWindow(contentRect: rect, styleMask: [.titled, .fullSizeContentView],
                          backing: .buffered, defer: false)
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        [.closeButton, .miniaturizeButton, .zoomButton].forEach {
            window.standardWindowButton($0)?.isHidden = true
        }
    }

    func makeUI() {
        guard let cv = window.contentView else { return }
        let panel = NSVisualEffectView(frame: cv.bounds)
        panel.material = .hudWindow
        panel.blendingMode = .behindWindow
        panel.state = .active
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 24
        panel.layer?.masksToBounds = true
        panel.layer?.backgroundColor = theme.glass.cgColor
        panel.layer?.borderWidth = 1
        panel.layer?.borderColor = theme.edge.cgColor
        panel.autoresizingMask = [.width, .height]
        cv.addSubview(panel)

        let topEdge = NSView(frame: NSRect(x: 20, y: 244, width: 520, height: 1))
        topEdge.wantsLayer = true
        topEdge.layer?.backgroundColor = theme.edgeTop.cgColor
        panel.addSubview(topEdge)

        let dot = DotView(frame: NSRect(x: 34, y: 188, width: 24, height: 24))
        dot.theme = theme
        panel.addSubview(dot)

        let heading = NSTextField(labelWithString: L("会议开始了", "Meeting started"))
        heading.frame = NSRect(x: 72, y: 188, width: 420, height: 26)
        heading.font = .systemFont(ofSize: 22, weight: .bold)
        heading.textColor = theme.text
        panel.addSubview(heading)

        let title = NSTextField(labelWithString: meetingTitle)
        title.frame = NSRect(x: 72, y: 150, width: 432, height: 28)
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = theme.text
        title.lineBreakMode = .byTruncatingTail
        panel.addSubview(title)

        let sub = NSTextField(labelWithString: L("是否开始录制音频？", "Start recording audio?"))
        sub.frame = NSRect(x: 72, y: 122, width: 400, height: 22)
        sub.font = .systemFont(ofSize: 14, weight: .regular)
        sub.textColor = theme.muted
        panel.addSubview(sub)

        actionMenu = NSPopUpButton(frame: NSRect(x: 72, y: 42, width: 208, height: 34))
        actionMenu.bezelStyle = .rounded
        actionMenu.addItem(withTitle: L("开始录制", "Start recording"))
        actionMenu.item(at: 0)?.representedObject = "record"
        if !meetingLink.isEmpty {
            actionMenu.addItem(withTitle: L("开始录制并加入会议", "Start recording and join"))
            actionMenu.item(at: 1)?.representedObject = "record_join"
        }
        actionMenu.target = self
        actionMenu.action = #selector(actionChanged)
        if selectedAction == "record_join" {
            actionMenu.selectItem(at: 1)
        } else {
            actionMenu.selectItem(at: 0)
        }
        panel.addSubview(actionMenu)

        let ignore = NSButton(title: L("忽略", "Ignore"), target: self, action: #selector(ignore))
        ignore.frame = NSRect(x: 304, y: 40, width: 92, height: 38)
        ignore.isBordered = false
        ignore.wantsLayer = true
        ignore.layer?.cornerRadius = 12
        ignore.layer?.backgroundColor = theme.edge.withAlphaComponent(0.26).cgColor
        ignore.contentTintColor = theme.text
        ignore.font = .systemFont(ofSize: 14, weight: .semibold)
        panel.addSubview(ignore)

        primaryButton = NSButton(title: titleForAction(selectedAction), target: self, action: #selector(confirm))
        primaryButton.frame = NSRect(x: 408, y: 40, width: 122, height: 38)
        primaryButton.isBordered = false
        primaryButton.wantsLayer = true
        primaryButton.layer?.cornerRadius = 12
        primaryButton.layer?.backgroundColor = theme.accent.cgColor
        primaryButton.contentTintColor = .white
        primaryButton.font = .systemFont(ofSize: 14, weight: .bold)
        panel.addSubview(primaryButton)
    }

    func titleForAction(_ action: String) -> String {
        return action == "record_join"
            ? L("录制并加入", "Record and Join")
            : L("开始录制", "Start Recording")
    }

    @objc func actionChanged() {
        selectedAction = (actionMenu.selectedItem?.representedObject as? String) ?? "record"
        primaryButton.title = titleForAction(selectedAction)
    }

    @objc func confirm() {
        finish(choice: selectedAction)
    }

    @objc func ignore() {
        finish(choice: "ignore")
    }

    func finish(choice: String) {
        let payload: [String: String] = [
            "choice": choice,
            "primary_action": selectedAction,
        ]
        if let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
           let line = String(data: data, encoding: .utf8) {
            print(line)
        }
        NSApp.terminate(nil)
    }
}

func runSelfTest() {
    let payload: [String: String] = ["choice": "record", "primary_action": "record"]
    let data = try! JSONSerialization.data(withJSONObject: payload, options: [])
    print(String(data: data, encoding: .utf8)!)
}

if CommandLine.arguments.contains("--self-test") {
    runSelfTest()
    exit(0)
}

let title = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : L("未命名会议", "Untitled Meeting")
let link = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : ""
let primaryAction = CommandLine.arguments.count > 3 ? CommandLine.arguments[3] : "record"
let app = NSApplication.shared
let delegate = PromptApp(title: title, link: link, primaryAction: primaryAction)
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
