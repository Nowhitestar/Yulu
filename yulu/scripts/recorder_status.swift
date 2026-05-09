import Cocoa
import Darwin

/// 右侧悬浮录制状态标签
/// 编译：swiftc -o recorder_status recorder_status.swift
/// 使用：./recorder_status <标题> [状态文件路径]

let COLLAPSED_W: CGFloat = 44
let EXPANDED_W: CGFloat = 280
let PANEL_H: CGFloat = 76
let ANIM_DUR: TimeInterval = 0.2

// MARK: - 红点图标
class RecordDotView: NSView {
    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let c = NSPoint(x: bounds.midX, y: bounds.midY), r: CGFloat = 5
        ctx.setStrokeColor(NSColor.red.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(2)
        ctx.addArc(center: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        ctx.setFillColor(NSColor.red.cgColor)
        ctx.addArc(center: c, radius: r - 2.5, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.fillPath()
        // 脉冲动画
        let a = CABasicAnimation(keyPath: "opacity")
        a.fromValue = 1.0; a.toValue = 0.3; a.duration = 1.0
        a.autoreverses = true; a.repeatCount = .infinity
        layer?.add(a, forKey: "pulse")
    }
}

// MARK: - 主控制器
class AppDel: NSObject, NSApplicationDelegate {
    var win: NSWindow!
    var panel: NSView!
    var dot: RecordDotView!
    var titleLbl: NSTextField!
    var timeLbl: NSTextField!
    var stopBtn: NSButton!
    var expanded = false

    let meetingTitle: String
    let startTime = Date()
    let statePath: String
    var checkTimer: Timer?
    var aliveCheck: Timer?
    var lastFileSize: UInt64 = 0
    var lastFileGrowthAt = Date()
    var unhealthySince: Date?
    var stopping = false

    init(title: String, path: String) {
        self.meetingTitle = title; self.statePath = path
        super.init()
    }

    // ─────────────── 窗口创建 ───────────────

    func applicationDidFinishLaunching(_ n: Notification) {
        makeWin()
        makeUI()
        setExpanded(true); DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
            guard let s = self, s.expanded else { return }; s.setExpanded(false)
        }
        startTimers()
    }

    func makeWin() {
        let r = NSRect(x: 0, y: 0, width: EXPANDED_W, height: PANEL_H)
        win = NSWindow(contentRect: r, styleMask: [.titled, .fullSizeContentView],
                       backing: .buffered, defer: false)
        win.title = ""; win.titlebarAppearsTransparent = true; win.titleVisibility = .hidden
        win.isMovableByWindowBackground = false; win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.isOpaque = false; win.backgroundColor = .clear
        [.closeButton, .miniaturizeButton, .zoomButton].forEach {
            win.standardWindowButton($0)?.isHidden = true
        }
        win.makeKeyAndOrderFront(nil)
        win.orderFrontRegardless()
        NSApp.activate(ignoringOtherApps: true)
        pos(expanded: true, anim: false)
    }

    func makeUI() {
        guard let cv = win.contentView else { return }
        // 背景
        panel = NSView(frame: cv.bounds); panel.wantsLayer = true
        panel.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.92).cgColor
        panel.layer?.cornerRadius = 12; panel.autoresizingMask = [.width, .height]
        cv.addSubview(panel)

        // 红点
        dot = RecordDotView(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        dot.wantsLayer = true; panel.addSubview(dot)

        // 标题
        titleLbl = NSTextField(labelWithString: meetingTitle)
        titleLbl.font = .systemFont(ofSize: 12, weight: .medium)
        titleLbl.textColor = .white; titleLbl.lineBreakMode = .byTruncatingTail
        panel.addSubview(titleLbl)

        // 时间
        timeLbl = NSTextField(labelWithString: "00:00:00")
        timeLbl.font = .monospacedDigitSystemFont(ofSize: 19, weight: .regular)
        timeLbl.textColor = NSColor(white: 0.8, alpha: 1)
        panel.addSubview(timeLbl)

        // Stop 按钮
        stopBtn = NSButton(title: "■", target: self, action: #selector(doStop))
        stopBtn.bezelStyle = .rounded
        stopBtn.font = .systemFont(ofSize: 13, weight: .bold)
        stopBtn.contentTintColor = .white
        stopBtn.toolTip = "Stop Recording"
        stopBtn.wantsLayer = true
        stopBtn.layer?.backgroundColor = NSColor(red: 0.85, green: 0.15, blue: 0.15, alpha: 1).cgColor
        stopBtn.layer?.cornerRadius = 6
        panel.addSubview(stopBtn)

        // 折叠/展开切换按钮（透明，覆盖红点区域）
        let toggleBtn = NSButton(title: "", target: self, action: #selector(toggle))
        toggleBtn.isBordered = false
        toggleBtn.wantsLayer = true
        toggleBtn.layer?.backgroundColor = NSColor.clear.cgColor
        toggleBtn.frame = NSRect(x: 0, y: 0, width: COLLAPSED_W, height: PANEL_H)
        toggleBtn.autoresizingMask = [.maxXMargin]
        panel.addSubview(toggleBtn, positioned: .above, relativeTo: dot)

        setExpanded(false)
    }

    // ─────────────── 布局 ───────────────

    func pos(expanded e: Bool, anim: Bool) {
        guard let s = NSScreen.main else { return }
        let v = s.visibleFrame
        let w: CGFloat = e ? EXPANDED_W : COLLAPSED_W
        let x: CGFloat = e ? v.maxX - EXPANDED_W + 4 : v.maxX - COLLAPSED_W
        let y = v.minY + (v.height - PANEL_H) / 2
        win.setFrame(NSRect(x: x, y: y, width: w, height: PANEL_H), display: true, animate: anim)
    }

    func setExpanded(_ e: Bool) {
        expanded = e
        pos(expanded: e, anim: true)
        let my = PANEL_H / 2
        dot.frame = NSRect(x: COLLAPSED_W / 2 - 10, y: my - 10, width: 20, height: 20)
        if e {
            titleLbl.isHidden = false; titleLbl.frame = NSRect(x: 40, y: my + 6, width: EXPANDED_W - 110, height: 18)
            timeLbl.isHidden = false; timeLbl.frame = NSRect(x: 40, y: my - 26, width: 120, height: 24)
            stopBtn.isHidden = false; stopBtn.frame = NSRect(x: EXPANDED_W - 52, y: my - 17, width: 38, height: 34)
        } else {
            titleLbl.isHidden = true; timeLbl.isHidden = true; stopBtn.isHidden = true
        }
    }

    @objc func toggle() { setExpanded(!expanded) }

    // ─────────────── 计时 ───────────────

    func startTimers() {
        Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(tick),
                             userInfo: nil, repeats: true)
            .common()
        // 状态检查：每 5 秒，宽松版
        checkTimer = Timer.scheduledTimer(timeInterval: 5, target: self,
                                          selector: #selector(check), userInfo: nil, repeats: true)
        checkTimer?.common()
        check()
    }

    @objc func tick() {
        let e = Date().timeIntervalSince(startTime)
        timeLbl.stringValue = String(format: "%02d:%02d:%02d", Int(e)/3600, (Int(e)%3600)/60, Int(e)%60)
    }

    @objc func check() {
        guard !statePath.isEmpty, FileManager.default.fileExists(atPath: statePath),
              let d = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }

        let info = parseState(j)
        guard Date().timeIntervalSince(startTime) > 8 else { return }

        if info.recording == false {
            if !stopping {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { NSApp.terminate(nil) }
            }
            return
        }

        let socket = audioDaemonStatus()
        let socketRecording = socket?["recording"] as? Bool
        let socketFile = socket?["file"] as? String
        let audioPath = socketFile?.isEmpty == false ? socketFile! : (info.audioPath ?? "")

        var fileGrowing = false
        if !audioPath.isEmpty,
           let attrs = try? FileManager.default.attributesOfItem(atPath: audioPath),
           let size = attrs[.size] as? UInt64 {
            if size > lastFileSize {
                lastFileSize = size
                lastFileGrowthAt = Date()
                fileGrowing = true
            } else {
                fileGrowing = Date().timeIntervalSince(lastFileGrowthAt) < 15
            }
        }

        let daemonLost = socket == nil
        let daemonNotRecording = socketRecording == false && info.recording == true
        let fileStalled = !audioPath.isEmpty && !fileGrowing && Date().timeIntervalSince(startTime) > 20
        let unhealthy = daemonLost || daemonNotRecording || fileStalled

        if unhealthy {
            if unhealthySince == nil { unhealthySince = Date() }
            showUnhealthy(daemonLost: daemonLost, fileStalled: fileStalled)
        } else {
            unhealthySince = nil
            showHealthy()
        }
    }

    func parseState(_ j: [String: Any]) -> (recording: Bool?, audioPath: String?) {
        if let b = j["recording"] as? Bool {
            return (b, j["file_path"] as? String)
        }
        if let r = j["recording"] as? [String: Any] {
            if r.isEmpty { return (false, nil) }
            return (true, r["audio_path"] as? String ?? r["file_path"] as? String)
        }
        return (nil, j["file_path"] as? String)
    }

    func showUnhealthy(daemonLost: Bool, fileStalled: Bool) {
        panel.layer?.backgroundColor = NSColor(red: 0.45, green: 0.08, blue: 0.06, alpha: 0.96).cgColor
        titleLbl.stringValue = daemonLost ? "⚠️ 录音后端失联" : (fileStalled ? "⚠️ 录音文件停止增长" : "⚠️ 录音状态异常")
        timeLbl.stringValue = "请点停止保存/恢复"
        setExpanded(true)
    }

    func showHealthy() {
        panel.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.92).cgColor
        titleLbl.stringValue = meetingTitle
    }

    func audioDaemonStatus() -> [String: Any]? {
        let sockPath = NSHomeDirectory() + "/.config/yulu/audio_daemon.sock"
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { Darwin.close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = sockPath.withCString { ptr in
            strncpy(&addr.sun_path.0, ptr, min(strlen(ptr), 103))
        }
        let ok = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if ok != 0 { return nil }
        let payload = Data("{\"action\":\"status\"}".utf8)
        _ = payload.withUnsafeBytes { ptr in Darwin.write(fd, ptr.baseAddress, payload.count) }
        shutdown(fd, SHUT_WR)
        var out = Data(); var buf = [UInt8](repeating: 0, count: 4096)
        while true {
            let n = Darwin.read(fd, &buf, buf.count)
            if n <= 0 { break }
            out.append(buf, count: n)
        }
        guard !out.isEmpty,
              let j = try? JSONSerialization.jsonObject(with: out) as? [String: Any] else { return nil }
        return j
    }

    @objc func doStop() {
        guard !stopping else { return }
        stopping = true
        setExpanded(true)
        panel.layer?.backgroundColor = NSColor(red: 0.10, green: 0.18, blue: 0.32, alpha: 0.96).cgColor
        titleLbl.stringValue = "⏳ 正在保存录音"
        timeLbl.stringValue = "转写/纪要处理中…"
        stopBtn.isEnabled = false
        stopBtn.title = "…"

        let dir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["python3", "\(dir)/meeting_daemon.py", "stop"]
        p.terminationHandler = { _ in
            DispatchQueue.main.async {
                self.titleLbl.stringValue = "✅ 已保存"
                self.timeLbl.stringValue = "处理完成"
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                    NSApp.terminate(nil)
                }
            }
        }
        do {
            try p.run()
        } catch {
            titleLbl.stringValue = "⚠️ 停止失败"
            timeLbl.stringValue = "请在终端/助手里停止"
            stopBtn.isEnabled = true
            stopBtn.title = "■"
            stopping = false
        }
    }
}

// MARK: - 入口
let args = CommandLine.arguments
guard args.count >= 2 else { print("Usage: recorder_status <title> [state_file]"); exit(1) }
let d = AppDel(title: args[1], path: args.count >= 3 ? args[2] : "")
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.delegate = d
app.run()

// MARK: - Timer 扩展
extension Timer {
    func common() { RunLoop.current.add(self, forMode: .common) }
}
