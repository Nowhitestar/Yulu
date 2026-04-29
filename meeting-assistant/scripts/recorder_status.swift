import Cocoa

/// 右侧悬浮录制状态标签
/// 编译：swiftc -o recorder_status recorder_status.swift
/// 使用：./recorder_status <标题> [状态文件路径]

let PILL_WIDTH: CGFloat = 36       // 折叠时宽度
let PANEL_WIDTH: CGFloat = 280     // 展开时宽度
let PANEL_HEIGHT: CGFloat = 76     // 面板高度
let ANIM_DURATION: TimeInterval = 0.2

// MARK: - 自定义红点图标（线性风格）
class RecordDotView: NSView {
    var isPulsing: Bool = false {
        didSet {
            if isPulsing { startPulse() } else { stopPulse() }
        }
    }
    private var pulseLayer: CALayer?

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius: CGFloat = 5
        // 外圈
        ctx.setStrokeColor(NSColor.red.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(2)
        ctx.addArc(center: center, radius: radius, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        // 实心圆
        ctx.setFillColor(NSColor.red.cgColor)
        ctx.addArc(center: center, radius: radius - 2.5, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.fillPath()
    }

    private func startPulse() {
        let anim = CABasicAnimation(keyPath: "opacity")
        anim.fromValue = 1.0
        anim.toValue = 0.3
        anim.duration = 1.0
        anim.autoreverses = true
        anim.repeatCount = .infinity
        layer?.add(anim, forKey: "pulse")
    }

    private func stopPulse() {
        layer?.removeAnimation(forKey: "pulse")
        layer?.opacity = 1.0
    }
}

// MARK: - 主控制器
class StatusWindowController: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var panelView: NSView!
    var recordDot: RecordDotView!
    var titleField: NSTextField!
    var elapsedField: NSTextField!
    var stopButton: NSButton!
    var timer: Timer?
    var checkTimer: Timer?

    let meetingTitle: String
    let startTime: Date
    let stateFilePath: String
    var startupTime: Date = Date()
    let checkGracePeriod: TimeInterval = 10
    var isExpanded: Bool = false

    init(title: String, statePath: String) {
        self.meetingTitle = title
        self.startTime = Date()
        self.stateFilePath = statePath
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        createWindow()
        createUI()
        // 启动展开 3s → 自动折叠
        setPanelExpanded(true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
            guard let self = self, self.isExpanded else { return }
            self.setPanelExpanded(false)
        }
        startTimers()
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
    }

    func createWindow() {
        let rect = NSRect(x: 0, y: 0, width: PANEL_WIDTH, height: PANEL_HEIGHT)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.isMovableByWindowBackground = false
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        window.isOpaque = false
        window.backgroundColor = .clear
        // 隐藏关闭/最小化/缩放按钮
        [.closeButton, .miniaturizeButton, .zoomButton].forEach {
            window.standardWindowButton($0)?.isHidden = true
        }
        // 初始位置
        positionPanel(expanded: true, animated: false)
        // 点击切换
        let click = NSClickGestureRecognizer(target: self, action: #selector(onClick))
        window.contentView?.addGestureRecognizer(click)
    }

    func createUI() {
        guard let content = window.contentView else { return }

        // ── 背景面板 ──
        panelView = NSView(frame: content.bounds)
        panelView.wantsLayer = true
        panelView.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.92).cgColor
        panelView.layer?.cornerRadius = 12
        panelView.autoresizingMask = [.width, .height]
        content.addSubview(panelView)

        // ── 红点图标（自定义绘制） ──
        recordDot = RecordDotView(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        recordDot.wantsLayer = true
        recordDot.isPulsing = false
        panelView.addSubview(recordDot)

        // ── 标题 ──
        titleField = NSTextField(labelWithString: meetingTitle)
        titleField.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        titleField.textColor = .white
        titleField.lineBreakMode = .byTruncatingTail
        panelView.addSubview(titleField)

        // ── 已录制时间 ──
        elapsedField = NSTextField(labelWithString: "00:00:00")
        elapsedField.font = NSFont.monospacedDigitSystemFont(ofSize: 19, weight: .regular)
        elapsedField.textColor = NSColor(white: 0.8, alpha: 1)
        panelView.addSubview(elapsedField)

        // ── Stop 按钮 ──
        stopButton = NSButton(title: "■", target: self, action: #selector(stopClicked))
        stopButton.bezelStyle = .rounded
        stopButton.setButtonType(.momentaryPushIn)
        stopButton.font = NSFont.systemFont(ofSize: 16, weight: .bold)
        stopButton.contentTintColor = NSColor(red: 0.9, green: 0.2, blue: 0.2, alpha: 1)
        stopButton.toolTip = "Stop Recording"
        stopButton.action = #selector(stopClicked)
        stopButton.target = self
        panelView.addSubview(stopButton)

        // ── 布局（竖向居中） ──
        layoutContent(expanded: false)

        // 初始折叠
        setPanelExpanded(false)
    }

    // MARK: - 布局

    func layoutContent(expanded: Bool) {
        let pw = panelView.bounds.width
        let midY = PANEL_HEIGHT / 2

        // 红点：左边缘居中
        recordDot.frame = NSRect(x: 7, y: midY - 12, width: 24, height: 24)

        if expanded {
            // 标题在上
            titleField.frame = NSRect(x: 40, y: midY + 6, width: pw - 110, height: 18)
            titleField.isHidden = false
            // 时间在下
            elapsedField.frame = NSRect(x: 40, y: midY - 26, width: 120, height: 24)
            elapsedField.isHidden = false
            // Stop 按钮在最右侧
            stopButton.frame = NSRect(x: pw - 56, y: midY - 17, width: 44, height: 34)
            stopButton.isHidden = false
        } else {
            // 折叠：只留红点，其余隐藏
            titleField.isHidden = true
            elapsedField.isHidden = true
            stopButton.isHidden = true
        }
    }

    func positionPanel(expanded: Bool, animated: Bool) {
        guard let screen = NSScreen.main else { return }
        let visible = screen.visibleFrame
        let width: CGFloat = expanded ? PANEL_WIDTH : PILL_WIDTH
        let x: CGFloat = expanded ? visible.maxX - PANEL_WIDTH + 4 : visible.maxX - PILL_WIDTH
        let y = visible.minY + (visible.height - PANEL_HEIGHT) / 2
        window.setFrame(NSRect(x: x, y: y, width: width, height: PANEL_HEIGHT),
                        display: true, animate: animated)
    }

    func setPanelExpanded(_ expanded: Bool) {
        isExpanded = expanded
        positionPanel(expanded: expanded, animated: true)
        layoutContent(expanded: expanded)
    }

    @objc func onClick() {
        setPanelExpanded(!isExpanded)
    }

    // MARK: - 计时 & 状态检查

    func startTimers() {
        timer = Timer.scheduledTimer(
            timeInterval: 1.0, target: self, selector: #selector(updateElapsed),
            userInfo: nil, repeats: true
        )
        RunLoop.current.add(timer!, forMode: .common)

        checkTimer = Timer.scheduledTimer(
            timeInterval: 3.0, target: self, selector: #selector(checkState),
            userInfo: nil, repeats: true
        )
        RunLoop.current.add(checkTimer!, forMode: .common)
    }

    @objc func updateElapsed() {
        let elapsed = Date().timeIntervalSince(startTime)
        let h = Int(elapsed) / 3600
        let m = (Int(elapsed) % 3600) / 60
        let s = Int(elapsed) % 60
        elapsedField.stringValue = String(format: "%02d:%02d:%02d", h, m, s)
    }

    @objc func checkState() {
        guard !stateFilePath.isEmpty else { return }
        guard Date().timeIntervalSince(startupTime) > checkGracePeriod else { return }
        guard FileManager.default.fileExists(atPath: stateFilePath) else { return }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: stateFilePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return
        }
        let recording = json["recording"] as? [String: Any]
        if recording == nil || (recording?.isEmpty ?? false) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { NSApp.terminate(nil) }
        }
    }

    @objc func stopClicked() {
        let scriptDir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        let daemonPath = "\(scriptDir)/meeting_daemon.py"
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        proc.arguments = ["python3", daemonPath, "stop"]
        try? proc.run()
        NSApp.terminate(nil)
    }
}

// MARK: - Entry
let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Usage: recorder_status <title> [state_file_path]")
    exit(1)
}
let delegate = StatusWindowController(title: args[1], statePath: args.count >= 3 ? args[2] : "")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = delegate
app.run()
