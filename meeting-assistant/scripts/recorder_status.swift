import Cocoa

/// 录制状态浮窗：悬浮在屏幕上的小窗口
/// 使用：swiftc -o recorder_status recorder_status.swift
///        ./recorder_status <标题> [状态文件路径]

let SCRIPT_DIR = FileManager.default.currentDirectoryPath

class StatusWindowController: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    var titleField: NSTextField!
    var elapsedField: NSTextField!
    var stopButton: NSButton!
    var timer: Timer?
    
    let meetingTitle: String
    let startTime: Date
    let stateFilePath: String
    var checkTimer: Timer?
    
    init(title: String, statePath: String) {
        self.meetingTitle = title
        self.startTime = Date()
        self.stateFilePath = statePath
        super.init()
    }
    
    func applicationDidFinishLaunching(_ notification: Notification) {
        createWindow()
        createUI()
        startTimers()
    }
    
    func createWindow() {
        let rect = NSRect(x: 0, y: 0, width: 300, height: 100)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = ""
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.level = .floating
        window.center()
        
        // 屏幕右上角
        if let screen = NSScreen.main {
            let screenRect = screen.visibleFrame
            let x = screenRect.maxX - rect.width - 20
            let y = screenRect.maxY - rect.height - 20
            window.setFrameOrigin(NSPoint(x: x, y: y))
        }
    }
    
    func createUI() {
        let content = window.contentView!
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor(white: 0.12, alpha: 0.95).cgColor
        content.layer?.cornerRadius = 12
        
        // 🔴 图标
        let iconField = NSTextField(labelWithString: "🔴")
        iconField.font = NSFont.systemFont(ofSize: 20)
        iconField.frame = NSRect(x: 16, y: 58, width: 28, height: 28)
        content.addSubview(iconField)
        
        // 标题
        titleField = NSTextField(labelWithString: "Recording: \(meetingTitle)")
        titleField.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        titleField.textColor = .white
        titleField.frame = NSRect(x: 48, y: 58, width: 230, height: 22)
        content.addSubview(titleField)
        
        // 已录制时间
        elapsedField = NSTextField(labelWithString: "00:00:00")
        elapsedField.font = NSFont.monospacedDigitSystemFont(ofSize: 22, weight: .regular)
        elapsedField.textColor = NSColor(white: 0.8, alpha: 1)
        elapsedField.frame = NSRect(x: 48, y: 22, width: 140, height: 30)
        content.addSubview(elapsedField)
        
        // 停止按钮
        stopButton = NSButton(title: "■  Stop", target: self, action: #selector(stopClicked))
        stopButton.bezelStyle = .rounded
        stopButton.setButtonType(.momentaryPushIn)
        stopButton.font = NSFont.systemFont(ofSize: 13, weight: .medium)
        stopButton.frame = NSRect(x: 200, y: 20, width: 84, height: 30)
        stopButton.contentTintColor = .white
        // Red tint
        if let cell = stopButton.cell as? NSButtonCell {
            cell.backgroundColor = NSColor(red: 0.8, green: 0.15, blue: 0.15, alpha: 1)
            cell.isBordered = false
        }
        content.addSubview(stopButton)
        
        window.makeKeyAndOrderFront(nil)
        // Keep it always on top even when app loses focus
        window.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    }
    
    func startTimers() {
        // 每秒更新已录制时间
        timer = Timer.scheduledTimer(
            timeInterval: 1.0,
            target: self,
            selector: #selector(updateElapsed),
            userInfo: nil,
            repeats: true
        )
        RunLoop.current.add(timer!, forMode: .common)
        
        // 每 3 秒检查状态文件，如果录制已结束则自动关闭
        checkTimer = Timer.scheduledTimer(
            timeInterval: 3.0,
            target: self,
            selector: #selector(checkState),
            userInfo: nil,
            repeats: true
        )
        RunLoop.current.add(checkTimer!, forMode: .common)
    }
    
    @objc func updateElapsed() {
        let elapsed = Date().timeIntervalSince(startTime)
        let hours = Int(elapsed) / 3600
        let minutes = (Int(elapsed) % 3600) / 60
        let seconds = Int(elapsed) % 60
        elapsedField.stringValue = String(format: "%02d:%02d:%02d", hours, minutes, seconds)
    }
    
    @objc func checkState() {
        guard !stateFilePath.isEmpty else { return }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: stateFilePath)),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let recording = json["recording"] as? [String: Any] else {
            // 状态文件不存在或格式不对 → 关闭窗口
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.terminate(nil)
            }
            return
        }
        if recording.isEmpty {
            // 录制已结束
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                NSApp.terminate(nil)
            }
        }
    }
    
    @objc func stopClicked() {
        // 调用 meeting_daemon.py stop
        let daemonPath = "\(SCRIPT_DIR)/meeting_daemon.py"
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["python3", daemonPath, "stop"]
        try? process.run()
        
        // 关闭窗口
        NSApp.terminate(nil)
    }
}

// MARK: - Entry point

let args = CommandLine.arguments
guard args.count >= 2 else {
    print("Usage: recorder_status <title> [state_file_path]")
    exit(1)
}

let title = args[1]
let statePath = args.count >= 3 ? args[2] : ""

let delegate = StatusWindowController(title: title, statePath: statePath)
let app = NSApplication.shared
app.setActivationPolicy(.accessory)  // 不显示 Dock 图标
app.delegate = delegate
app.activate(ignoringOtherApps: true)
app.run()
