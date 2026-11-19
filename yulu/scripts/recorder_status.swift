import Cocoa
import Darwin
import Foundation
import WebKit

// Yulu's live notes panel during a meeting recording: a tall glass card on the
// right edge of the screen that shows the Host's /live page, and tucks away to
// Yulu's breathing icon.
// Build: swiftc -o recorder_status recorder_status.swift -framework Cocoa -framework WebKit
// Usage: ./recorder_status <title> [state_file]

let panelWidth: CGFloat = 380
let panelMaxHeight: CGFloat = 760
let panelMinHeight: CGFloat = 320
let panelCornerRadius: CGFloat = 14
let collapsedWindowSize: CGFloat = 92
let screenMargin: CGFloat = 16

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
let IPC_DIR = environmentDirectory(
    "YULU_IPC_DIR",
    fallback: "\(HOME_DIR)/Library/Caches/Yulu"
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

func hostPort() -> String {
    let port = ProcessInfo.processInfo.environment["YULU_UI_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    guard let value = Int(port), (1...65535).contains(value) else { return "7777" }
    return String(value)
}

extension NSColor {
    convenience init(hex: String, alpha: CGFloat = 1) {
        var value = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let raw = UInt64(value, radix: 16) else {
            self.init(calibratedWhite: 0, alpha: alpha)
            return
        }
        self.init(
            calibratedRed: CGFloat((raw >> 16) & 0xff) / 255,
            green: CGFloat((raw >> 8) & 0xff) / 255,
            blue: CGFloat(raw & 0xff) / 255,
            alpha: alpha
        )
    }
}

func nativeIPCRequest(socketPath: String, payload: Data, timeoutSeconds: Int = 1) -> [String: Any]? {
    guard socketPath.utf8.count < 104 else { return nil }
    let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return nil }
    defer { Darwin.close(fd) }
    var timeout = timeval(tv_sec: timeoutSeconds, tv_usec: 0)
    setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var noSigpipe: Int32 = 1
    setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &noSigpipe, socklen_t(MemoryLayout<Int32>.size))
    var address = sockaddr_un()
    address.sun_family = sa_family_t(AF_UNIX)
    _ = socketPath.withCString { strncpy(&address.sun_path.0, $0, 103) }
    let connected = withUnsafePointer(to: &address) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
            Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
        }
    }
    guard connected == 0 else { return nil }
    let wrote = payload.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, payload.count) }
    guard wrote == payload.count else { return nil }
    shutdown(fd, SHUT_WR)
    var output = Data()
    var buffer = [UInt8](repeating: 0, count: 4096)
    while output.count < 64 * 1024 {
        let count = Darwin.read(fd, &buffer, buffer.count)
        if count <= 0 { break }
        output.append(buffer, count: count)
        if output.contains(0x0A) { break }
    }
    return try? JSONSerialization.jsonObject(with: output) as? [String: Any]
}

func requestRecordingStop() -> [String: Any] {
    nativeIPCRequest(
        socketPath: "\(IPC_DIR)/status_agent.sock",
        payload: Data("{\"action\":\"stop\"}\n".utf8),
        timeoutSeconds: 4
    ) ?? ["ok": false, "error": "controls_unavailable"]
}

/// Only Yulu's own Settings and Inbox pages may be opened from the panel.
func isAllowedPanelRoute(_ route: String) -> Bool {
    route.count <= 120 &&
        route.range(of: "^/(settings|inbox)(/[a-z0-9-]+)*(#[a-z0-9-]+)?$", options: .regularExpression) != nil
}

/// Ask the menu-bar companion to show a page in Yulu's own window.
func requestOpenRoute(_ route: String) -> Bool {
    guard isAllowedPanelRoute(route),
          let payload = try? JSONSerialization.data(withJSONObject: ["action": "open_route", "route": route]) else {
        return false
    }
    let response = nativeIPCRequest(
        socketPath: "\(IPC_DIR)/status_agent.sock",
        payload: payload + Data("\n".utf8)
    )
    return response?["ok"] as? Bool == true
}

/// What the /live page may ask of its panel. Anything else is ignored.
enum PanelAction: Equatable {
    case collapse
    case drag
    case stop
    case open(String)
    case appearance(dark: Bool)

    static func parse(_ body: Any) -> PanelAction? {
        guard let message = body as? [String: Any], let action = message["action"] as? String else { return nil }
        switch action {
        case "collapse": return .collapse
        case "drag": return .drag
        case "stop": return .stop
        case "open":
            guard let route = message["route"] as? String, isAllowedPanelRoute(route) else { return nil }
            return .open(route)
        case "appearance":
            guard let dark = message["dark"] as? Bool else { return nil }
            return .appearance(dark: dark)
        default:
            return nil
        }
    }
}

/// The recording state the page shows: stopping, or a problem with capture.
func panelStateScript(stopping: Bool, warning: String) -> String {
    let state: [String: Any] = ["stopping": stopping, "warning": warning.isEmpty ? NSNull() as Any : warning as Any]
    let data = (try? JSONSerialization.data(withJSONObject: state)) ?? Data("{}".utf8)
    let json = String(decoding: data, as: UTF8.self)
    return "window.__yuluPanelState = \(json); window.dispatchEvent(new CustomEvent('yulu-panel', { detail: window.__yuluPanelState }));"
}

/// The panel's place: the right edge of the screen, from the top, as tall as
/// the screen allows up to a comfortable reading height.
func defaultPanelFrame(in visible: NSRect) -> NSRect {
    let height = max(min(panelMaxHeight, visible.height - screenMargin * 2), min(panelMinHeight, visible.height))
    let width = min(panelWidth, visible.width - screenMargin * 2)
    return NSRect(
        x: visible.maxX - width - screenMargin,
        y: visible.maxY - height - screenMargin,
        width: width,
        height: height
    )
}

func clampedOrigin(_ origin: NSPoint, size: NSSize, in visible: NSRect) -> NSPoint {
    let area = visible.insetBy(dx: screenMargin, dy: screenMargin)
    return NSPoint(
        x: min(max(origin.x, area.minX), max(area.minX, area.maxX - size.width)),
        y: min(max(origin.y, area.minY), max(area.minY, area.maxY - size.height))
    )
}

/// The icon sits where the panel's top-right corner was, and the panel opens
/// back from the icon's top-right corner, so neither jumps across the screen.
func collapsedOrigin(fromPanel frame: NSRect) -> NSPoint {
    NSPoint(x: frame.maxX - collapsedWindowSize, y: frame.maxY - collapsedWindowSize)
}

func expandedOrigin(fromIcon frame: NSRect, panelSize: NSSize) -> NSPoint {
    NSPoint(x: frame.maxX - panelSize.width, y: frame.maxY - panelSize.height)
}

/// A borderless panel that can take typing for notes without activating Yulu,
/// so the meeting app stays in front.
final class NotesPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// This helper has no Edit menu, so give the note field the usual editing
    /// shortcuts directly.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
        if event.type == .keyDown, modifiers == .command,
           let key = event.charactersIgnoringModifiers?.lowercased() {
            let action: Selector?
            switch key {
            case "x": action = #selector(NSText.cut(_:))
            case "c": action = #selector(NSText.copy(_:))
            case "v": action = #selector(NSText.paste(_:))
            case "a": action = #selector(NSText.selectAll(_:))
            default: action = nil
            }
            if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
        }
        return super.performKeyEquivalent(with: event)
    }
}

/// A stretchable rounded mask, so the glass and the panel's shadow share the
/// card's rounded corners.
func roundedMask(radius: CGFloat) -> NSImage {
    let edge = radius * 2 + 1
    let image = NSImage(size: NSSize(width: edge, height: edge), flipped: false) { rect in
        NSColor.black.setFill()
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
        return true
    }
    image.capInsets = NSEdgeInsets(top: radius, left: radius, bottom: radius, right: radius)
    image.resizingMode = .stretch
    return image
}

/// WebKit keeps its message handlers alive; this forwards to the delegate
/// without keeping it alive in return.
final class PanelMessages: NSObject, WKScriptMessageHandler {
    weak var owner: AppDel?
    let port: Int

    init(owner: AppDel, port: Int) {
        self.owner = owner
        self.port = port
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http",
              origin.host == "127.0.0.1", origin.port == port,
              let action = PanelAction.parse(message.body) else { return }
        owner?.handle(action)
    }
}

final class LogoView: NSView {
    var onClick: (() -> Void)?
    var onMove: ((NSPoint) -> Void)?
    private let haloOne = NSImageView()
    private let haloTwo = NSImageView()
    private let artwork = NSImageView()
    private var panOrigin = NSPoint.zero
    private var panMouseOrigin = NSPoint.zero
    private var imageLoaded = false

    init(frame frameRect: NSRect, image: NSImage?) {
        super.init(frame: frameRect)
        wantsLayer = true
        layer?.masksToBounds = false
        imageLoaded = image != nil
        for view in [haloOne, haloTwo, artwork] {
            view.image = image
            view.imageScaling = .scaleProportionallyUpOrDown
            view.wantsLayer = true
            addSubview(view)
        }
        haloOne.alphaValue = 0.32
        haloTwo.alphaValue = 0.24
        artwork.layer?.shadowColor = NSColor(hex: "#20509A").cgColor
        artwork.layer?.shadowOpacity = 0.35
        artwork.layer?.shadowRadius = 12
        artwork.layer?.shadowOffset = NSSize(width: 0, height: -6)
        toolTip = L("正在录制 · 点击展开实时笔记", "Recording · Click to open live notes")
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(L("展开实时笔记", "Open live notes"))

        let click = NSClickGestureRecognizer(target: self, action: #selector(clicked))
        addGestureRecognizer(click)
        let pan = NSPanGestureRecognizer(target: self, action: #selector(panned(_:)))
        addGestureRecognizer(pan)
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layout() {
        super.layout()
        let size: CGFloat = 62
        let rect = NSRect(x: (bounds.width - size) / 2, y: (bounds.height - size) / 2, width: size, height: size)
        haloOne.frame = rect
        haloTwo.frame = rect
        artwork.frame = rect
    }

    override func draw(_ dirtyRect: NSRect) {
        guard !imageLoaded else { return }
        let rect = NSRect(x: bounds.midX - 29, y: bounds.midY - 24, width: 58, height: 48)
        NSColor(hex: "#3674D3").setFill()
        NSBezierPath(roundedRect: rect, xRadius: 22, yRadius: 22).fill()
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 30, weight: .bold),
            .foregroundColor: NSColor.white.withAlphaComponent(0.9),
        ]
        "“".draw(in: NSRect(x: rect.minX + 10, y: rect.minY + 7, width: 38, height: 35), withAttributes: attributes)
    }

    func setBreathing(_ enabled: Bool) {
        [haloOne, haloTwo].forEach { $0.layer?.removeAnimation(forKey: "breathe") }
        guard enabled else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            haloOne.alphaValue = 0.18
            haloTwo.alphaValue = 0
            return
        }
        for (index, view) in [haloOne, haloTwo].enumerated() {
            let scale = CABasicAnimation(keyPath: "transform.scale")
            scale.fromValue = 0.98
            scale.toValue = 1.38
            let opacity = CABasicAnimation(keyPath: "opacity")
            opacity.fromValue = index == 0 ? 0.34 : 0.25
            opacity.toValue = 0
            let group = CAAnimationGroup()
            group.animations = [scale, opacity]
            group.duration = 1.9
            group.beginTime = CACurrentMediaTime() + Double(index) * 0.48
            group.repeatCount = .infinity
            group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
            view.layer?.add(group, forKey: "breathe")
        }
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    @objc private func clicked() { onClick?() }

    override func accessibilityPerformPress() -> Bool {
        onClick?()
        return true
    }

    @objc private func panned(_ sender: NSPanGestureRecognizer) {
        guard let window else { return }
        switch sender.state {
        case .began:
            panOrigin = window.frame.origin
            panMouseOrigin = NSEvent.mouseLocation
            NSCursor.closedHand.set()
        case .changed:
            let mouse = NSEvent.mouseLocation
            onMove?(NSPoint(
                x: panOrigin.x + mouse.x - panMouseOrigin.x,
                y: panOrigin.y + mouse.y - panMouseOrigin.y
            ))
        default:
            NSCursor.pointingHand.set()
        }
    }
}

final class AppDel: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    let meetingTitle: String
    let statePath: String
    let startTime = Date()
    let port = Int(hostPort()) ?? 7777

    var win: NotesPanel!
    var root: NSView!
    var glass: NSVisualEffectView!
    var webView: WKWebView?
    var logoView: LogoView!

    var activeScreen: NSScreen!
    var expanded = true
    var panelSize = NSSize(width: panelWidth, height: panelMaxHeight)
    var currentAudioPath = ""
    var lastFileSize: UInt64 = 0
    var lastFileGrowthAt = Date()
    var unhealthy = false
    var stopping = false
    var closing = false
    var adjustingFrame = false
    var warningText = ""

    var stateTimer: Timer?
    var reloadWorkItem: DispatchWorkItem?

    init(title: String, path: String) {
        meetingTitle = title
        statePath = path
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        activeScreen = initialScreen()
        makeWindow()
        makeUI()
        startTimers()
    }

    func applicationWillTerminate(_ notification: Notification) {
        stateTimer?.invalidate()
        reloadWorkItem?.cancel()
        webView?.stopLoading()
    }

    func initialScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func makeWindow() {
        let frame = defaultPanelFrame(in: activeScreen.visibleFrame)
        panelSize = frame.size
        win = NotesPanel(
            contentRect: frame,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        win.level = .statusBar
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = true
        win.hidesOnDeactivate = false
        // Any click in the panel lets it take typing; it never activates Yulu.
        win.becomesKeyOnlyIfNeeded = false
        win.isMovableByWindowBackground = false
        win.isReleasedWhenClosed = false
        win.title = L("实时笔记", "Live notes")
        win.delegate = self
        win.orderFrontRegardless()
    }

    func makeUI() {
        root = NSView(frame: win.contentView?.bounds ?? .zero)
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor
        win.contentView = root

        glass = NSVisualEffectView(frame: root.bounds)
        glass.autoresizingMask = [.width, .height]
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.maskImage = roundedMask(radius: panelCornerRadius)
        root.addSubview(glass)

        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.userContentController.add(PanelMessages(owner: self, port: port), name: "yuluPanel")
        configuration.userContentController.addUserScript(WKUserScript(source: """
            if (location.origin === 'http://127.0.0.1:\(port)') {
              const markPanel = () => { document.documentElement.dataset.yuluPanel = 'true'; };
              if (document.documentElement) markPanel();
              else document.addEventListener('DOMContentLoaded', markPanel, { once: true });
            }
            """, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let page = WKWebView(frame: glass.bounds, configuration: configuration)
        page.autoresizingMask = [.width, .height]
        // The glass shows through; the page paints only a light tint.
        page.setValue(false, forKey: "drawsBackground")
        page.wantsLayer = true
        page.layer?.cornerRadius = panelCornerRadius
        page.layer?.masksToBounds = true
        page.navigationDelegate = self
        page.uiDelegate = self
        page.setAccessibilityLabel(L("实时笔记", "Live notes"))
        glass.addSubview(page)
        webView = page
        loadPage()

        let logo = NSImage(contentsOf: logoURL())
        logoView = LogoView(frame: .zero, image: logo)
        logoView.onClick = { [weak self] in self?.setExpanded(true) }
        logoView.onMove = { [weak self] origin in self?.moveWindow(to: origin) }
        logoView.isHidden = true
        root.addSubview(logoView)
    }

    func loadPage() {
        guard !closing, let webView, let url = URL(string: "http://127.0.0.1:\(port)/live") else { return }
        reloadWorkItem?.cancel()
        webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 10))
    }

    /// The Host may be restarting; try again shortly instead of showing an error.
    func scheduleReload() {
        guard !closing else { return }
        reloadWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.loadPage() }
        reloadWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: item)
    }

    func handle(_ action: PanelAction) {
        guard !closing else { return }
        switch action {
        case .collapse:
            setExpanded(false)
        case .drag:
            dragPanel()
        case .stop:
            doStop()
        case .open(let route):
            openRoute(route)
        case .appearance(let dark):
            let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
            win.appearance = appearance
            glass.appearance = appearance
        }
    }

    /// WebKit delivers the message after the mouse went down; drag only while
    /// the left button is still held.
    func dragPanel() {
        guard expanded, NSEvent.pressedMouseButtons & 1 != 0,
              let event = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: win.convertPoint(fromScreen: NSEvent.mouseLocation),
                modifierFlags: NSApp.currentEvent?.modifierFlags ?? [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: win.windowNumber, context: nil,
                eventNumber: 0, clickCount: 1, pressure: 1
              ) else { return }
        win.performDrag(with: event)
    }

    func openRoute(_ route: String) {
        guard isAllowedPanelRoute(route) else { return }
        let port = self.port
        DispatchQueue.global(qos: .userInitiated).async {
            guard !requestOpenRoute(route) else { return }
            // Without the menu-bar companion, open the page in the browser.
            DispatchQueue.main.async {
                if let url = URL(string: "http://127.0.0.1:\(port)\(route)") { NSWorkspace.shared.open(url) }
            }
        }
    }

    func pushPanelState() {
        guard let webView, !closing else { return }
        webView.evaluateJavaScript(panelStateScript(stopping: stopping, warning: warningText), completionHandler: nil)
    }

    func setExpanded(_ value: Bool) {
        guard expanded != value, !closing else { return }
        let current = win.frame
        expanded = value
        let frame: NSRect
        if value {
            let origin = clampedOrigin(
                expandedOrigin(fromIcon: current, panelSize: panelSize),
                size: panelSize,
                in: activeScreen.visibleFrame
            )
            frame = NSRect(origin: origin, size: panelSize)
        } else {
            panelSize = current.size
            let size = NSSize(width: collapsedWindowSize, height: collapsedWindowSize)
            frame = NSRect(origin: clampedOrigin(collapsedOrigin(fromPanel: current), size: size, in: activeScreen.visibleFrame), size: size)
        }
        glass.isHidden = !value
        logoView.isHidden = value
        logoView.frame = root.bounds
        win.hasShadow = value
        win.setFrame(frame, display: true, animate: !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        logoView.frame = root.bounds
        logoView.setBreathing(!value)
        // Nothing typed reaches the hidden notes while only the icon shows.
        if !value { win.makeFirstResponder(nil) }
        win.invalidateShadow()
    }

    func moveWindow(to origin: NSPoint) {
        win.setFrameOrigin(clampedOrigin(origin, size: win.frame.size, in: activeScreen.visibleFrame))
    }

    func windowDidMove(_ notification: Notification) {
        guard !adjustingFrame, let win else { return }
        if let screen = win.screen { activeScreen = screen }
        let clamped = clampedOrigin(win.frame.origin, size: win.frame.size, in: activeScreen.visibleFrame)
        guard clamped != win.frame.origin else { return }
        adjustingFrame = true
        win.setFrameOrigin(clamped)
        adjustingFrame = false
    }

    func startTimers() {
        let timer = Timer(timeInterval: 2, target: self, selector: #selector(checkState), userInfo: nil, repeats: true)
        RunLoop.current.add(timer, forMode: .common)
        stateTimer = timer
        checkState()
    }

    @objc func checkState() {
        guard !closing, !statePath.isEmpty,
              FileManager.default.fileExists(atPath: statePath),
              let data = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

        let info = parseState(json)
        if let audioPath = info.audioPath { setCurrentAudioPath(audioPath) }
        if info.recording == false {
            finishAndExit()
            return
        }
        guard Date().timeIntervalSince(startTime) > 8 else { return }

        let socket = audioDaemonStatus()
        let socketRecording = socket?["recording"] as? Bool
        let socketFile = socket?["file"] as? String
        let audioPath = socketFile?.isEmpty == false ? socketFile! : (info.audioPath ?? "")
        setCurrentAudioPath(audioPath)

        var growing = false
        if !audioPath.isEmpty,
           let attrs = try? FileManager.default.attributesOfItem(atPath: audioPath),
           let size = attrs[.size] as? UInt64 {
            if size > lastFileSize {
                lastFileSize = size
                lastFileGrowthAt = Date()
                growing = true
            } else {
                growing = Date().timeIntervalSince(lastFileGrowthAt) < 15
            }
        }
        let problem = socket == nil || (socketRecording == false && info.recording == true) || (!audioPath.isEmpty && !growing && Date().timeIntervalSince(startTime) > 20)
        if problem && !stopping {
            if !unhealthy || warningText.isEmpty {
                unhealthy = true
                warningText = L("录音连接异常，请检查录音状态", "Recording connection issue — check recording status")
                pushPanelState()
            }
        } else if unhealthy {
            unhealthy = false
            warningText = ""
            pushPanelState()
        }
    }

    func parseState(_ json: [String: Any]) -> (recording: Bool?, audioPath: String?) {
        if let recording = json["recording"] as? Bool {
            return (recording, json["audio_path"] as? String ?? json["file_path"] as? String)
        }
        if let recording = json["recording"] as? [String: Any] {
            if recording.isEmpty { return (false, nil) }
            return (true, recording["audio_path"] as? String ?? recording["file_path"] as? String)
        }
        return (nil, json["file_path"] as? String)
    }

    func setCurrentAudioPath(_ path: String) {
        guard !path.isEmpty, path != currentAudioPath else { return }
        currentAudioPath = path
        lastFileSize = 0
        lastFileGrowthAt = Date()
    }

    func audioDaemonStatus() -> [String: Any]? {
        let socketPath = "\(IPC_DIR)/audio_daemon.sock"
        return nativeIPCRequest(socketPath: socketPath, payload: Data("{\"action\":\"status\"}\n".utf8))
    }

    @objc func doStop() {
        guard !stopping, !closing else { return }
        stopping = true
        warningText = ""
        pushPanelState()
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let response = requestRecordingStop()
            DispatchQueue.main.async {
                guard let self, !self.closing else { return }
                if response["ok"] as? Bool == true, let pid = response["launcher_pid"] as? Int {
                    self.checkState()
                    self.observeStopCompletion(pid: pid)
                } else {
                    self.applyStopCompletion(response)
                }
            }
        }
    }

    func applyStopCompletion(_ response: [String: Any]) {
        stopping = false
        if response["ok"] as? Bool == true, response["state"] as? String == "completed" {
            warningText = ""
        } else if response["state"] as? String == "failed" {
            warningText = L("停止录制失败，请重试", "Could not stop recording — try again")
        } else {
            warningText = L("无法确认停止状态，请检查录音后重试", "Stop could not be confirmed — check recording and retry")
        }
        pushPanelState()
    }

    private func observeStopCompletion(pid: Int) {
        guard stopping, !closing else { return }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let request = try! JSONSerialization.data(withJSONObject: ["action": "stop_status", "launcher_pid": pid])
            let response = nativeIPCRequest(socketPath: "\(IPC_DIR)/status_agent.sock", payload: request)
                ?? ["ok": false, "error": "controls_unavailable"]
            DispatchQueue.main.async {
                guard let self, self.stopping, !self.closing else { return }
                if response["ok"] as? Bool == true, response["state"] as? String == "running" {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                        self?.observeStopCompletion(pid: pid)
                    }
                    return
                }
                self.applyStopCompletion(response)
                self.checkState()
            }
        }
    }

    func finishAndExit() {
        guard !closing else { return }
        closing = true
        stateTimer?.invalidate()
        reloadWorkItem?.cancel()
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.12
            win.animator().alphaValue = 0
        }, completionHandler: {
            NSApp.terminate(nil)
        })
    }

    func logoURL() -> URL {
        let directory = URL(fileURLWithPath: (CommandLine.arguments[0] as NSString).deletingLastPathComponent)
        return directory.appendingPathComponent("yulu_ui/web/public/favicon.svg")
    }

    // MARK: - The page

    func isPanelPage(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "http" && url.host == "127.0.0.1" && url.port == port && url.path == "/live"
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        if navigationAction.targetFrame?.isMainFrame != false, isPanelPage(url) {
            decisionHandler(.allow)
            return
        }
        // The panel only ever shows /live. A link in the notes opens in the
        // browser, and only when the person clicked it.
        if navigationAction.navigationType == .linkActivated, let url, url.scheme?.lowercased() == "https" {
            NSWorkspace.shared.open(url)
        }
        decisionHandler(.cancel)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme?.lowercased() == "https",
           url.user == nil, url.password == nil {
            NSWorkspace.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pushPanelState()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        scheduleReload()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        guard (error as NSError).code != NSURLErrorCancelled else { return }
        scheduleReload()
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        scheduleReload()
    }
}

let arguments = CommandLine.arguments
if arguments.contains("--stop") {
    let response = requestRecordingStop()
    let data = try JSONSerialization.data(withJSONObject: response)
    print(String(decoding: data, as: UTF8.self))
    exit(response["ok"] as? Bool == true ? 0 : 1)
}
if arguments.contains("--self-test") {
    // Logic only: no window, WebView, Host or capture is touched.
    let app = AppDel(title: "test", path: "")
    app.stopping = true
    app.applyStopCompletion(["ok": true, "state": "failed", "exit_status": 1])
    assert(!app.stopping && !app.warningText.isEmpty)
    app.stopping = true
    app.applyStopCompletion(["ok": false, "error": "controls_unavailable"])
    assert(!app.stopping && !app.warningText.isEmpty)
    app.applyStopCompletion(["ok": true, "state": "completed", "exit_status": 0])
    assert(app.warningText.isEmpty)
    assert(app.parseState(["recording": ["audio_path": "/tmp/a.wav"]]).recording == true)
    assert(app.parseState(["recording": [String: Any]()]).recording == false)
    assert(app.parseState(["recording": false]).recording == false)

    assert(PanelAction.parse(["action": "collapse"]) == .collapse)
    assert(PanelAction.parse(["action": "drag"]) == .drag)
    assert(PanelAction.parse(["action": "stop"]) == .stop)
    assert(PanelAction.parse(["action": "appearance", "dark": true] as [String: Any]) == .appearance(dark: true))
    assert(PanelAction.parse(["action": "appearance"]) == nil)
    assert(PanelAction.parse(["action": "open", "route": "/settings/recording#live-notes"]) == .open("/settings/recording#live-notes"))
    assert(PanelAction.parse(["action": "open", "route": "https://example.com"]) == nil)
    assert(PanelAction.parse(["action": "open", "route": "/settings/../../etc"]) == nil)
    assert(PanelAction.parse(["action": "open", "route": "//example.com/settings"]) == nil)
    assert(PanelAction.parse(["action": "resize"]) == nil)
    assert(PanelAction.parse("collapse") == nil)
    assert(isAllowedPanelRoute("/inbox"))
    assert(isAllowedPanelRoute("/settings/connections#ai-connections"))
    assert(!isAllowedPanelRoute("/live"))
    assert(!isAllowedPanelRoute("/settings?x=1"))

    let script = panelStateScript(stopping: true, warning: "录音连接异常</script>'")
    assert(script.hasPrefix("window.__yuluPanelState = {"))
    assert(script.contains("\"stopping\":true"))
    assert(script.contains("CustomEvent('yulu-panel'"))
    assert(panelStateScript(stopping: false, warning: "").contains("\"warning\":null"))

    let screen = NSRect(x: 0, y: 0, width: 1440, height: 875)
    let frame = defaultPanelFrame(in: screen)
    assert(frame.width == panelWidth && frame.height == panelMaxHeight)
    assert(frame.maxX == screen.maxX - screenMargin && frame.maxY == screen.maxY - screenMargin)
    let short = defaultPanelFrame(in: NSRect(x: 0, y: 0, width: 1280, height: 500))
    assert(short.height == 500 - screenMargin * 2 && short.minY == screenMargin)
    let icon = collapsedOrigin(fromPanel: frame)
    assert(icon.x == frame.maxX - collapsedWindowSize && icon.y == frame.maxY - collapsedWindowSize)
    let iconFrame = NSRect(origin: icon, size: NSSize(width: collapsedWindowSize, height: collapsedWindowSize))
    assert(expandedOrigin(fromIcon: iconFrame, panelSize: frame.size) == frame.origin)
    let clamped = clampedOrigin(NSPoint(x: 5_000, y: -50), size: frame.size, in: screen)
    assert(clamped.x == screen.maxX - screenMargin - frame.width && clamped.y == screenMargin)
    print("recorder_status self-test ok")
    exit(0)
}

guard arguments.count >= 2 else {
    print("Usage: recorder_status <title> [state_file]")
    exit(1)
}

let delegate = AppDel(title: arguments[1], path: arguments.count >= 3 ? arguments[2] : "")
let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.delegate = delegate
application.run()
