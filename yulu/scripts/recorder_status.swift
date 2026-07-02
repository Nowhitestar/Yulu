import Cocoa
import Darwin

/// 右侧悬浮录制状态标签
/// 编译：swiftc -o recorder_status recorder_status.swift
/// 使用：./recorder_status <标题> [状态文件路径]

let COLLAPSED_W: CGFloat = 44
let EXPANDED_W: CGFloat = 360
let COLLAPSED_H: CGFloat = 76
let EXPANDED_H: CGFloat = 190
let ANIM_DUR: TimeInterval = 0.2
let CAPTION_TAIL_BYTES: UInt64 = 64 * 1024
let CAPTION_MAX_LINES = 5

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

struct RecorderTheme {
    let glass: NSColor
    let surface: NSColor
    let edge: NSColor
    let edgeTop: NSColor
    let text: NSColor
    let muted: NSColor
    let accent: NSColor
    let red: NSColor

    static func load() -> RecorderTheme {
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/yulu/config.json")
        guard let data = try? Data(contentsOf: url),
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

    static func customTheme(tokens: [String: Any], dark: Bool) -> RecorderTheme {
        let surface = str(tokens["surface"], fallback: dark ? "#1c2534" : "#ffffff")
        let edge = str(tokens["edge"], fallback: dark ? "#5c6678" : "#9aa9bc")
        let text = str(tokens["text"], fallback: dark ? "#f4f7fb" : "#172033")
        let muted = str(tokens["muted"], fallback: dark ? "#a7b1c2" : "#687488")
        let accent = str(tokens["accent"], fallback: dark ? "#69a7ff" : "#1473e6")
        let red = str(tokens["red"], fallback: dark ? "#ff6961" : "#d70015")
        return RecorderTheme(
            glass: NSColor(hex: surface, alpha: dark ? 0.62 : 0.74),
            surface: NSColor(hex: surface, alpha: dark ? 0.78 : 0.9),
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

    static func preset(family: String, mode: String) -> RecorderTheme {
        let dark = mode == "dark"
        switch (family, mode) {
        case ("ayu", "light"):
            return make("#fcfcfc", "#fcfcfc", "#6b7d8f", "#5c6166", "#828e9f", "#f29718", "#e65050", false)
        case ("ayu", "dark"):
            return make("#10141c", "#ffffff", "#ffffff", "#bfbdb6", "#5a6378", "#e6b450", "#d95757", true)
        case ("paper", "light"):
            return make("#f7f7f7", "#f7f7f7", "#444444", "#444444", "#6e6e6e", "#005f87", "#af0000", false)
        case ("paper", "dark"):
            return make("#262626", "#404040", "#d0d0d0", "#d0d0d0", "#a8a8a8", "#5f8787", "#af005f", true)
        default:
            return dark
                ? make("#10151e", "#121924", "#ffffff", "#f4f7fb", "#a7b1c2", "#69a7ff", "#ff6961", true)
                : make("#ffffff", "#ffffff", "#e7f1ff", "#172033", "#687488", "#1473e6", "#d70015", false)
        }
    }

    static func make(_ glassHex: String, _ surfaceHex: String, _ edgeHex: String,
                     _ textHex: String, _ mutedHex: String, _ accentHex: String,
                     _ redHex: String, _ dark: Bool) -> RecorderTheme {
        return RecorderTheme(
            glass: NSColor(hex: glassHex, alpha: dark ? 0.62 : 0.74),
            surface: NSColor(hex: surfaceHex, alpha: dark ? 0.78 : 0.90),
            edge: NSColor(hex: edgeHex, alpha: dark ? 0.10 : 0.28),
            edgeTop: NSColor.white.withAlphaComponent(dark ? 0.10 : 0.78),
            text: NSColor(hex: textHex),
            muted: NSColor(hex: mutedHex),
            accent: NSColor(hex: accentHex),
            red: NSColor(hex: redHex)
        )
    }
}

// MARK: - 红点图标
class RecordDotView: NSView {
    var color = NSColor.red { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let c = NSPoint(x: bounds.midX, y: bounds.midY), r: CGFloat = 5
        ctx.setStrokeColor(color.withAlphaComponent(0.6).cgColor)
        ctx.setLineWidth(2)
        ctx.addArc(center: c, radius: r, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.strokePath()
        ctx.setFillColor(color.cgColor)
        ctx.addArc(center: c, radius: r - 2.5, startAngle: 0, endAngle: .pi * 2, clockwise: false)
        ctx.fillPath()
        // 脉冲动画
        if layer?.animation(forKey: "pulse") == nil {
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 1.0; a.toValue = 0.3; a.duration = 1.0
            a.autoreverses = true; a.repeatCount = .infinity
            layer?.add(a, forKey: "pulse")
        }
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
    var captionBox: NSView!
    var captionLbl: NSTextField!
    var toggleBtn: NSButton!
    var expanded = false

    let meetingTitle: String
    let startTime = Date()
    let statePath: String
    var checkTimer: Timer?
    var captionTimer: Timer?
    var lastFileSize: UInt64 = 0
    var lastFileGrowthAt = Date()
    var unhealthySince: Date?
    var currentAudioPath = ""
    var captionsSuppressed = false
    var stopping = false
    var theme = RecorderTheme.load()

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
        let r = NSRect(x: 0, y: 0, width: EXPANDED_W, height: EXPANDED_H)
        win = NSWindow(contentRect: r, styleMask: [.titled, .fullSizeContentView],
                       backing: .buffered, defer: false)
        win.title = ""; win.titlebarAppearsTransparent = true; win.titleVisibility = .hidden
        win.isMovableByWindowBackground = false; win.level = .floating
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.isOpaque = false; win.backgroundColor = .clear
        win.hasShadow = true
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
        panel = NSView(frame: cv.bounds); panel.wantsLayer = true
        panel.layer?.cornerRadius = 18
        panel.layer?.borderWidth = 1
        panel.layer?.shadowOpacity = 0.16
        panel.layer?.shadowRadius = 18
        panel.layer?.shadowOffset = NSSize(width: 0, height: -4)
        panel.autoresizingMask = [.width, .height]
        cv.addSubview(panel)

        // 红点
        dot = RecordDotView(frame: NSRect(x: 0, y: 0, width: 20, height: 20))
        dot.wantsLayer = true; panel.addSubview(dot)

        // 标题
        titleLbl = NSTextField(labelWithString: meetingTitle)
        titleLbl.font = .systemFont(ofSize: 15, weight: .semibold)
        titleLbl.lineBreakMode = .byTruncatingTail
        panel.addSubview(titleLbl)

        // 时间
        timeLbl = NSTextField(labelWithString: "00:00:00")
        timeLbl.font = .monospacedDigitSystemFont(ofSize: 25, weight: .regular)
        panel.addSubview(timeLbl)

        // Stop 按钮
        stopBtn = NSButton(title: "■", target: self, action: #selector(doStop))
        stopBtn.bezelStyle = .rounded
        stopBtn.font = .systemFont(ofSize: 13, weight: .bold)
        stopBtn.contentTintColor = .white
        stopBtn.toolTip = "Stop Recording"
        stopBtn.wantsLayer = true
        stopBtn.layer?.cornerRadius = 12
        panel.addSubview(stopBtn)

        captionBox = NSView(frame: .zero)
        captionBox.wantsLayer = true
        captionBox.layer?.cornerRadius = 14
        captionBox.layer?.borderWidth = 1
        panel.addSubview(captionBox)

        captionLbl = NSTextField(labelWithString: "正在聆听...")
        captionLbl.font = .systemFont(ofSize: 12, weight: .regular)
        captionLbl.maximumNumberOfLines = CAPTION_MAX_LINES
        captionLbl.lineBreakMode = .byTruncatingTail
        captionLbl.cell?.wraps = true
        captionLbl.cell?.isScrollable = false
        captionBox.addSubview(captionLbl)

        // 折叠/展开切换按钮（透明，覆盖红点区域）
        toggleBtn = NSButton(title: "", target: self, action: #selector(toggle))
        toggleBtn.isBordered = false
        toggleBtn.wantsLayer = true
        toggleBtn.layer?.backgroundColor = NSColor.clear.cgColor
        toggleBtn.autoresizingMask = [.maxXMargin]
        panel.addSubview(toggleBtn, positioned: .above, relativeTo: dot)

        applyTheme()
        setExpanded(false)
    }

    // ─────────────── 布局 ───────────────

    func pos(expanded e: Bool, anim: Bool) {
        guard let s = NSScreen.main else { return }
        let v = s.visibleFrame
        let w: CGFloat = e ? EXPANDED_W : COLLAPSED_W
        let h: CGFloat = e ? EXPANDED_H : COLLAPSED_H
        let x: CGFloat = e ? v.maxX - EXPANDED_W + 4 : v.maxX - COLLAPSED_W
        let y = v.minY + (v.height - h) / 2
        win.setFrame(NSRect(x: x, y: y, width: w, height: h), display: true, animate: anim)
    }

    func setExpanded(_ e: Bool) {
        expanded = e
        pos(expanded: e, anim: true)
        let h: CGFloat = e ? EXPANDED_H : COLLAPSED_H
        let dotY: CGFloat = e ? h - 52 : h / 2 - 10
        dot.frame = NSRect(x: COLLAPSED_W / 2 - 10, y: dotY, width: 20, height: 20)
        toggleBtn.frame = NSRect(x: 0, y: 0, width: COLLAPSED_W, height: h)
        if e {
            titleLbl.isHidden = false; titleLbl.frame = NSRect(x: 54, y: h - 48, width: EXPANDED_W - 132, height: 22)
            timeLbl.isHidden = false; timeLbl.frame = NSRect(x: 54, y: h - 86, width: 142, height: 32)
            stopBtn.isHidden = false; stopBtn.frame = NSRect(x: EXPANDED_W - 74, y: h - 78, width: 52, height: 52)
            captionBox.isHidden = captionsSuppressed
            captionBox.frame = NSRect(x: 16, y: 16, width: EXPANDED_W - 32, height: 76)
            captionLbl.frame = NSRect(x: 12, y: 8, width: EXPANDED_W - 56, height: 60)
        } else {
            titleLbl.isHidden = true; timeLbl.isHidden = true; stopBtn.isHidden = true
            captionBox.isHidden = true
        }
    }

    @objc func toggle() { setExpanded(!expanded) }

    // ─────────────── 计时 ───────────────

    func startTimers() {
        Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(tick),
                             userInfo: nil, repeats: true)
            .common()
        captionTimer = Timer.scheduledTimer(timeInterval: 1.5, target: self,
                                            selector: #selector(updateCaption), userInfo: nil, repeats: true)
        captionTimer?.common()
        // 状态检查：每 5 秒，宽松版
        checkTimer = Timer.scheduledTimer(timeInterval: 5, target: self,
                                          selector: #selector(check), userInfo: nil, repeats: true)
        checkTimer?.common()
        check()
        updateCaption()
    }

    @objc func tick() {
        if stopping { return }
        let e = Date().timeIntervalSince(startTime)
        timeLbl.stringValue = String(format: "%02d:%02d:%02d", Int(e)/3600, (Int(e)%3600)/60, Int(e)%60)
    }

    @objc func check() {
        guard !statePath.isEmpty, FileManager.default.fileExists(atPath: statePath),
              let d = try? Data(contentsOf: URL(fileURLWithPath: statePath)),
              let j = try? JSONSerialization.jsonObject(with: d) as? [String: Any] else { return }

        let info = parseState(j)
        if let audioPath = info.audioPath { setCurrentAudioPath(audioPath) }
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
        setCurrentAudioPath(audioPath)

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
            theme = RecorderTheme.load()
            showHealthy()
        }
    }

    func parseState(_ j: [String: Any]) -> (recording: Bool?, audioPath: String?) {
        if let b = j["recording"] as? Bool {
            return (b, j["audio_path"] as? String ?? j["file_path"] as? String)
        }
        if let r = j["recording"] as? [String: Any] {
            if r.isEmpty { return (false, nil) }
            return (true, r["audio_path"] as? String ?? r["file_path"] as? String)
        }
        return (nil, j["file_path"] as? String)
    }

    func setCurrentAudioPath(_ path: String) {
        guard !path.isEmpty else { return }
        if path != currentAudioPath {
            let hadPath = !currentAudioPath.isEmpty
            currentAudioPath = path
            lastFileSize = 0
            lastFileGrowthAt = Date()
            if hadPath { restartRealtimeTranscriber(audioPath: path) }
        }
    }

    func restartRealtimeTranscriber(audioPath: String) {
        let dir = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        let script = "\(dir)/record_audio.py"
        guard FileManager.default.fileExists(atPath: script) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        p.arguments = ["python3", script, "restart-realtime", audioPath, meetingTitle]
        try? p.run()
    }

    func showUnhealthy(daemonLost: Bool, fileStalled: Bool) {
        captionsSuppressed = true
        captionBox.isHidden = true
        panel.layer?.backgroundColor = NSColor(red: 0.45, green: 0.08, blue: 0.06, alpha: 0.96).cgColor
        titleLbl.stringValue = daemonLost ? "⚠️ 录音后端失联" : (fileStalled ? "⚠️ 录音文件停止增长" : "⚠️ 录音状态异常")
        timeLbl.stringValue = "请点停止保存/恢复"
        setExpanded(true)
    }

    func showHealthy() {
        captionsSuppressed = false
        applyTheme()
        titleLbl.stringValue = meetingTitle
        captionBox.isHidden = !expanded
    }

    func applyTheme() {
        panel.layer?.backgroundColor = theme.glass.cgColor
        panel.layer?.borderColor = theme.edge.cgColor
        panel.layer?.shadowColor = NSColor.black.cgColor
        titleLbl.textColor = theme.text
        timeLbl.textColor = theme.muted
        dot.color = theme.red
        stopBtn.layer?.backgroundColor = theme.red.cgColor
        captionBox.layer?.backgroundColor = theme.surface.cgColor
        captionBox.layer?.borderColor = theme.edge.cgColor
        captionLbl.textColor = theme.text
    }

    @objc func updateCaption() {
        guard !captionsSuppressed, !currentAudioPath.isEmpty else { return }
        let path = realtimeTranscriptPath(audioPath: currentAudioPath)
        guard FileManager.default.fileExists(atPath: path) else {
            captionLbl.stringValue = "正在聆听..."
            return
        }
        let text = readTail(path: path)
        let lines = captionLines(text).suffix(CAPTION_MAX_LINES)
        captionLbl.stringValue = lines.isEmpty ? "正在聆听..." : lines.joined(separator: "\n")
    }

    func realtimeTranscriptPath(audioPath: String) -> String {
        return (audioPath as NSString).deletingPathExtension + ".realtime.transcript.txt"
    }

    func readTail(path: String) -> String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attrs[.size] as? UInt64,
              let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return "" }
        defer { try? handle.close() }
        let offset = size > CAPTION_TAIL_BYTES ? size - CAPTION_TAIL_BYTES : 0
        do {
            try handle.seek(toOffset: offset)
            let data = try handle.readToEnd() ?? Data()
            var text = String(data: data, encoding: .utf8) ?? ""
            if offset > 0, let nl = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: nl)...])
            }
            return text
        } catch {
            return ""
        }
    }

    func captionLines(_ raw: String) -> [String] {
        return raw.split(separator: "\n").compactMap { line in
            let s = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if s.isEmpty { return nil }
            if s.hasPrefix("[Me]") {
                return "你  " + s.dropFirst(4).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            if s.hasPrefix("[Them]") {
                return "对方  " + s.dropFirst(6).trimmingCharacters(in: .whitespacesAndNewlines)
            }
            return s
        }
    }

    func audioDaemonStatus() -> [String: Any]? {
        let sockPath = NSHomeDirectory() + "/.config/yulu/audio_daemon.sock"
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { Darwin.close(fd) }

        // Never let a stale/unresponsive daemon freeze the floating window.
        var tv = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))

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
        let wrote = payload.withUnsafeBytes { ptr in Darwin.write(fd, ptr.baseAddress, payload.count) }
        if wrote <= 0 { return nil }
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
        captionsSuppressed = true
        setExpanded(true)
        captionBox.isHidden = true
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
if args.contains("--self-test") {
    let d = AppDel(title: "test", path: "")
    assert(d.realtimeTranscriptPath(audioPath: "/tmp/Memo_20260630_120000.wav") == "/tmp/Memo_20260630_120000.realtime.transcript.txt")
    assert(d.captionLines("[Me] hello\n\n[Them] world\nplain\n") == ["你  hello", "对方  world", "plain"])
    d.lastFileSize = 100
    d.setCurrentAudioPath("/tmp/old.wav")
    d.lastFileSize = 200
    d.setCurrentAudioPath("/tmp/new.wav")
    assert(d.currentAudioPath == "/tmp/new.wav")
    assert(d.lastFileSize == 0)
    print("recorder_status self-test ok")
    exit(0)
}
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
