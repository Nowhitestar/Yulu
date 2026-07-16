import Cocoa
import Darwin
import Foundation

// Yulu's system-wide live-caption overlay.
// Build: swiftc -o recorder_status recorder_status.swift
// Usage: ./recorder_status <title> [state_file]

let expandedMaxWidth: CGFloat = 900
let expandedHeight: CGFloat = 176
let collapsedWindowSize: CGFloat = 92
let toolbarWidth: CGFloat = 420
let compactToolbarWidth: CGFloat = 84
let toolbarHeight: CGFloat = 30
let screenMargin: CGFloat = 16
let defaultBottomOffset: CGFloat = 72
let transcriptTailBytes: UInt64 = 64 * 1024

enum CaptionDisplayMode: Int {
    case bilingual = 0
    case translation = 1
    case source = 2

    var translationEnabled: Bool { self != .source }
}

struct TargetLanguage {
    let title: String
    let value: String
}

let targetLanguages = [
    TargetLanguage(title: "English", value: "English"),
    TargetLanguage(title: "日本語", value: "日本語"),
    TargetLanguage(title: "한국어", value: "한국어"),
    TargetLanguage(title: "Français", value: "Français"),
    TargetLanguage(title: "Español", value: "Español"),
    TargetLanguage(title: "Deutsch", value: "Deutsch"),
    TargetLanguage(title: "繁體中文", value: "繁體中文"),
]

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

func yuluPythonExecutable() -> URL {
    let candidates = [
        "/opt/homebrew/bin/python3",
        "/usr/local/bin/python3",
        "/usr/bin/python3",
    ]
    let path = candidates.first(where: FileManager.default.isExecutableFile(atPath:))
        ?? "/usr/bin/python3"
    return URL(fileURLWithPath: path)
}

final class HoverRootView: NSView {
    var onEnter: (() -> Void)?
    var onExit: (() -> Void)?
    private var tracking: NSTrackingArea?

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) { onEnter?() }
    override func mouseExited(with event: NSEvent) { onExit?() }
}

final class DraggableEffectView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }
}

final class GripView: NSView {
    override var mouseDownCanMoveWindow: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.white.withAlphaComponent(0.24).setFill()
        for row in 0..<3 {
            for column in 0..<2 {
                let rect = NSRect(x: CGFloat(column) * 4 + 1, y: CGFloat(row) * 4 + 1, width: 2, height: 2)
                NSBezierPath(ovalIn: rect).fill()
            }
        }
    }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .openHand)
    }
}

final class RecordingButton: NSButton {
    var stoppingState = false { didSet { needsDisplay = true } }
    var centersContent = false { didSet { needsDisplay = true } }
    private var hovered = false
    private var tracking: NSTrackingArea?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        setAccessibilityLabel("停止录制")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func draw(_ dirtyRect: NSRect) {
        let active = hovered || stoppingState || window?.firstResponder === self
        if active {
            NSColor(hex: "#E64C43", alpha: 0.12).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        }

        let label = stoppingState ? "停止中…" : (active ? "点击停止" : "录制中")
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .semibold),
            .foregroundColor: NSColor.white.withAlphaComponent(isEnabled ? 0.90 : 0.52),
        ]
        let frames = contentFrames(label: label, attributes: attributes)
        NSColor(hex: "#E64C43").setFill()
        if active {
            NSBezierPath(roundedRect: frames.indicator, xRadius: 1.4, yRadius: 1.4).fill()
        } else {
            NSBezierPath(ovalIn: frames.indicator).fill()
        }
        label.draw(in: frames.label, withAttributes: attributes)
    }

    func contentFrames(label: String, attributes: [NSAttributedString.Key: Any]) -> (indicator: NSRect, label: NSRect) {
        guard centersContent else {
            return (
                NSRect(x: 7, y: bounds.midY - 3.5, width: 7, height: 7),
                NSRect(x: 20, y: bounds.midY - 7, width: 44, height: 14)
            )
        }
        let labelWidth = ceil((label as NSString).size(withAttributes: attributes).width)
        let contentWidth: CGFloat = 7 + 6 + labelWidth
        let x = (bounds.width - contentWidth) / 2
        return (
            NSRect(x: x, y: bounds.midY - 3.5, width: 7, height: 7),
            NSRect(x: x + 13, y: bounds.midY - 7, width: labelWidth, height: 14)
        )
    }
}

final class CollapseButton: NSButton {
    private var hovered = false
    private var tracking: NSTrackingArea?

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        isBordered = false
        setButtonType(.momentaryChange)
        setAccessibilityLabel("收起字幕")
    }

    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func updateTrackingAreas() {
        if let tracking { removeTrackingArea(tracking) }
        let area = NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        addTrackingArea(area)
        tracking = area
        super.updateTrackingAreas()
    }

    override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }

    override func resetCursorRects() {
        addCursorRect(bounds, cursor: .pointingHand)
    }

    override func draw(_ dirtyRect: NSRect) {
        if hovered {
            NSColor.white.withAlphaComponent(0.10).setFill()
            NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
        }
        let path = NSBezierPath()
        path.move(to: NSPoint(x: bounds.midX - 4, y: bounds.midY + 2))
        path.line(to: NSPoint(x: bounds.midX, y: bounds.midY - 2))
        path.line(to: NSPoint(x: bounds.midX + 4, y: bounds.midY + 2))
        path.lineWidth = 1.4
        path.lineCapStyle = .round
        path.lineJoinStyle = .round
        NSColor.white.withAlphaComponent(0.66).setStroke()
        path.stroke()
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
        toolTip = "正在录制 · 点击展开字幕"
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel("展开实时字幕")

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

final class OutlinedCaptionLabel: NSView {
    private let outlineLabel = NSTextField(wrappingLabelWithString: "")
    private let fillLabel = NSTextField(wrappingLabelWithString: "")

    var attributedStringValue: NSAttributedString {
        get { fillLabel.attributedStringValue }
        set {
            fillLabel.attributedStringValue = newValue
            let outlined = NSMutableAttributedString(attributedString: newValue)
            outlined.addAttributes(
                [.strokeColor: NSColor.black, .strokeWidth: 9.0],
                range: NSRange(location: 0, length: outlined.length)
            )
            outlineLabel.attributedStringValue = outlined
        }
    }

    var outlineAttributedStringValue: NSAttributedString { outlineLabel.attributedStringValue }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        [outlineLabel, fillLabel].forEach { label in
            label.frame = bounds
            label.autoresizingMask = [.width, .height]
            label.alignment = .center
            label.maximumNumberOfLines = 2
            label.lineBreakMode = .byTruncatingTail
            label.isSelectable = false
            label.drawsBackground = false
            addSubview(label)
        }
    }

    required init?(coder: NSCoder) { nil }
}

final class AppDel: NSObject, NSApplicationDelegate, NSWindowDelegate {
    let meetingTitle: String
    let statePath: String
    let startTime = Date()

    var win: NSPanel!
    var root: HoverRootView!
    var toolbar: DraggableEffectView!
    var grip: GripView!
    var recordingButton: RecordingButton!
    var timeLabel: NSTextField!
    var sourceLanguageLabel: NSTextField!
    var targetPopup: NSPopUpButton!
    var displayPopup: NSPopUpButton!
    var collapseButton: CollapseButton!
    var sourceLabel: OutlinedCaptionLabel!
    var translationLabel: OutlinedCaptionLabel!
    var logoView: LogoView!

    var activeScreen: NSScreen!
    var expanded = true
    var displayMode = CaptionDisplayMode.source
    var toolbarCompact = false
    var currentAudioPath = ""
    var sourceText = ""
    var translationText = ""
    var translationFailed = false
    var warningText = ""
    var sourceLanguage = "zh"
    var lastSequence = -1
    var lastWebSocketEventAt = Date.distantPast
    var lastCaptionAt = Date.distantPast
    var lastFileSize: UInt64 = 0
    var lastFileGrowthAt = Date()
    var unhealthy = false
    var stopping = false
    var closing = false
    var adjustingFrame = false

    var timeTimer: Timer?
    var stateTimer: Timer?
    var captionTimer: Timer?
    var toolbarHideWorkItem: DispatchWorkItem?
    var reconnectWorkItem: DispatchWorkItem?
    var stopProcess: Process?
    let webSocketSession = URLSession(configuration: .default)
    var webSocketTask: URLSessionWebSocketTask?

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
        connectWebSocket()
        showToolbar()
        scheduleToolbarHide()
    }

    func applicationWillTerminate(_ notification: Notification) {
        [timeTimer, stateTimer, captionTimer].forEach { $0?.invalidate() }
        toolbarHideWorkItem?.cancel()
        reconnectWorkItem?.cancel()
        webSocketTask?.cancel(with: .goingAway, reason: nil)
        webSocketSession.invalidateAndCancel()
    }

    func initialScreen() -> NSScreen {
        let mouse = NSEvent.mouseLocation
        return NSScreen.screens.first(where: { NSMouseInRect(mouse, $0.frame, false) }) ?? NSScreen.main ?? NSScreen.screens[0]
    }

    func defaultExpandedFrame() -> NSRect {
        let visible = activeScreen.visibleFrame
        let width = min(expandedMaxWidth, visible.width - 72)
        return NSRect(
            x: visible.midX - width / 2,
            y: visible.minY + defaultBottomOffset,
            width: width,
            height: expandedHeight
        )
    }

    func makeWindow() {
        win = NSPanel(
            contentRect: defaultExpandedFrame(),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        win.level = .statusBar
        win.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        win.isOpaque = false
        win.backgroundColor = .clear
        win.hasShadow = false
        win.hidesOnDeactivate = false
        win.becomesKeyOnlyIfNeeded = true
        win.isMovableByWindowBackground = true
        win.isReleasedWhenClosed = false
        win.delegate = self
        win.orderFrontRegardless()
    }

    func makeUI() {
        root = HoverRootView(frame: win.contentView?.bounds ?? .zero)
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.backgroundColor = NSColor.clear.cgColor
        root.onEnter = { [weak self] in self?.showToolbar() }
        root.onExit = { [weak self] in self?.scheduleToolbarHide() }
        win.contentView = root

        toolbar = DraggableEffectView(frame: .zero)
        toolbar.wantsLayer = true
        toolbar.layer?.cornerRadius = toolbarHeight / 2
        toolbar.layer?.borderWidth = 1
        toolbar.layer?.borderColor = NSColor.white.withAlphaComponent(0.16).cgColor
        toolbar.layer?.backgroundColor = NSColor(hex: "#17191D", alpha: 0.92).cgColor
        root.addSubview(toolbar)

        grip = GripView(frame: .zero)
        toolbar.addSubview(grip)

        recordingButton = RecordingButton(frame: .zero)
        recordingButton.target = self
        recordingButton.action = #selector(doStop)
        recordingButton.toolTip = "点击停止录制"
        toolbar.addSubview(recordingButton)

        timeLabel = makeToolbarLabel("00:00")
        timeLabel.font = .monospacedDigitSystemFont(ofSize: 10, weight: .semibold)
        toolbar.addSubview(timeLabel)

        sourceLanguageLabel = makeToolbarLabel("中文 →")
        toolbar.addSubview(sourceLanguageLabel)

        targetPopup = makePopup(targetLanguages.map(\.title))
        targetPopup.target = self
        targetPopup.action = #selector(targetLanguageChanged)
        targetPopup.selectItem(withTitle: normalizedTargetLanguage(loadTargetLanguage()))
        toolbar.addSubview(targetPopup)

        displayPopup = makePopup(["双语", "仅翻译", "仅原文"])
        displayPopup.target = self
        displayPopup.action = #selector(displayModeChanged)
        displayPopup.selectItem(at: displayMode.rawValue)
        toolbar.addSubview(displayPopup)

        collapseButton = CollapseButton(frame: .zero)
        collapseButton.target = self
        collapseButton.action = #selector(collapse)
        toolbar.addSubview(collapseButton)

        sourceLabel = makeCaptionLabel()
        translationLabel = makeCaptionLabel()
        root.addSubview(sourceLabel)
        root.addSubview(translationLabel)

        let logo = NSImage(contentsOf: logoURL())
        logoView = LogoView(frame: .zero, image: logo)
        logoView.onClick = { [weak self] in self?.setExpanded(true) }
        logoView.onMove = { [weak self] origin in self?.moveWindow(to: origin) }
        logoView.isHidden = true
        root.addSubview(logoView)

        layoutViews()
        renderCaptions(animated: false)
    }

    func makeToolbarLabel(_ value: String) -> NSTextField {
        let label = NSTextField(labelWithString: value)
        label.font = .systemFont(ofSize: 10, weight: .semibold)
        label.textColor = NSColor.white.withAlphaComponent(0.76)
        label.alignment = .center
        return label
    }

    func makePopup(_ values: [String]) -> NSPopUpButton {
        let popup = NSPopUpButton(frame: .zero, pullsDown: false)
        popup.addItems(withTitles: values)
        popup.isBordered = false
        popup.controlSize = .small
        popup.font = .systemFont(ofSize: 10, weight: .semibold)
        popup.contentTintColor = NSColor.white.withAlphaComponent(0.78)
        return popup
    }

    func makeCaptionLabel() -> OutlinedCaptionLabel {
        OutlinedCaptionLabel(frame: .zero)
    }

    func layoutViews() {
        root.frame = win.contentView?.bounds ?? root.frame
        if expanded {
            logoView.isHidden = true
            toolbar.isHidden = false
            toolbar.frame = toolbarFrame(compact: toolbarCompact, in: root.bounds)
            let fullControls = [grip, timeLabel, sourceLanguageLabel, targetPopup, displayPopup, collapseButton]
            fullControls.forEach { $0?.isHidden = toolbarCompact }
            if toolbarCompact {
                recordingButton.frame = compactRecordingButtonFrame(in: toolbar.bounds)
                recordingButton.centersContent = true
                sourceLabel.frame = NSRect(x: 18, y: 62, width: root.bounds.width - 36, height: 66)
                translationLabel.frame = NSRect(x: 24, y: 20, width: root.bounds.width - 48, height: 42)
                return
            }
            recordingButton.centersContent = false
            var x: CGFloat = 10
            grip.frame = NSRect(x: x, y: 9, width: 8, height: 12); x += 16
            recordingButton.frame = NSRect(x: x, y: 3, width: 68, height: 24); x += 74
            timeLabel.frame = NSRect(x: x, y: 7, width: 38, height: 16); x += 47
            sourceLanguageLabel.frame = NSRect(x: x, y: 7, width: 50, height: 16); x += 52
            targetPopup.frame = NSRect(x: x, y: 3, width: 88, height: 24); x += 90
            displayPopup.frame = NSRect(x: x, y: 3, width: 66, height: 24)
            collapseButton.frame = NSRect(x: toolbar.bounds.width - 30, y: 3, width: 24, height: 24)
            sourceLabel.frame = NSRect(x: 18, y: 62, width: root.bounds.width - 36, height: 66)
            translationLabel.frame = NSRect(x: 24, y: 20, width: root.bounds.width - 48, height: 42)
        } else {
            toolbar.isHidden = true
            sourceLabel.isHidden = true
            translationLabel.isHidden = true
            logoView.isHidden = false
            logoView.frame = root.bounds
            logoView.setBreathing(true)
        }
    }

    func setExpanded(_ value: Bool) {
        guard expanded != value, !closing else { return }
        let anchorX = win.frame.midX
        let anchorY = win.frame.minY
        expanded = value
        let size: NSSize
        if value {
            size = defaultExpandedFrame().size
        } else {
            size = NSSize(width: collapsedWindowSize, height: collapsedWindowSize)
        }
        let origin = clampedOrigin(NSPoint(x: anchorX - size.width / 2, y: anchorY), size: size)
        win.setFrame(NSRect(origin: origin, size: size), display: true, animate: true)
        root.frame = win.contentView?.bounds ?? root.frame
        logoView.setBreathing(!value)
        layoutViews()
        if value {
            renderCaptions(animated: false)
            showToolbar()
            scheduleToolbarHide()
        }
    }

    @objc func collapse() { setExpanded(false) }

    func toolbarFrame(compact: Bool, in bounds: NSRect) -> NSRect {
        let width = compact ? compactToolbarWidth : toolbarWidth
        return NSRect(
            x: (bounds.width - width) / 2,
            y: bounds.height - toolbarHeight - 3,
            width: width,
            height: toolbarHeight
        )
    }

    func compactRecordingButtonFrame(in bounds: NSRect) -> NSRect {
        NSRect(x: bounds.midX - 34, y: bounds.midY - 12, width: 68, height: 24)
    }

    func setToolbarCompact(_ compact: Bool) {
        guard toolbarCompact != compact, expanded, !closing else { return }
        toolbarCompact = compact
        layoutViews()
    }

    func moveWindow(to origin: NSPoint) {
        win.setFrameOrigin(clampedOrigin(origin, size: win.frame.size))
    }

    func clampedOrigin(_ origin: NSPoint, size: NSSize) -> NSPoint {
        let visible = activeScreen.visibleFrame.insetBy(dx: screenMargin, dy: screenMargin)
        return NSPoint(
            x: min(max(origin.x, visible.minX), visible.maxX - size.width),
            y: min(max(origin.y, visible.minY), visible.maxY - size.height)
        )
    }

    func windowDidMove(_ notification: Notification) {
        guard !adjustingFrame, let win else { return }
        let clamped = clampedOrigin(win.frame.origin, size: win.frame.size)
        guard clamped != win.frame.origin else { return }
        adjustingFrame = true
        win.setFrameOrigin(clamped)
        adjustingFrame = false
    }

    func showToolbar() {
        guard expanded, !closing else { return }
        toolbarHideWorkItem?.cancel()
        setToolbarCompact(false)
    }

    func scheduleToolbarHide() {
        toolbarHideWorkItem?.cancel()
        let item = DispatchWorkItem { [weak self] in
            guard let self, self.expanded, !self.closing else { return }
            if self.win.frame.contains(NSEvent.mouseLocation) || self.targetPopup.cell?.isHighlighted == true || self.displayPopup.cell?.isHighlighted == true {
                return
            }
            self.setToolbarCompact(true)
        }
        toolbarHideWorkItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + 3, execute: item)
    }

    func startTimers() {
        timeTimer = Timer.scheduledTimer(timeInterval: 1, target: self, selector: #selector(tick), userInfo: nil, repeats: true)
        stateTimer = Timer.scheduledTimer(timeInterval: 2, target: self, selector: #selector(checkState), userInfo: nil, repeats: true)
        captionTimer = Timer.scheduledTimer(timeInterval: 1.5, target: self, selector: #selector(updateCaptionFallback), userInfo: nil, repeats: true)
        [timeTimer, stateTimer, captionTimer].forEach { $0?.addToCommonRunLoop() }
        tick()
        checkState()
        updateCaptionFallback()
    }

    @objc func tick() {
        guard !closing else { return }
        timeLabel.stringValue = formatElapsed(Date().timeIntervalSince(startTime))
        if Date().timeIntervalSince(lastCaptionAt) > 6, !sourceText.isEmpty, warningText.isEmpty {
            sourceLabel.animator().alphaValue = 0
            translationLabel.animator().alphaValue = 0
        }
    }

    func formatElapsed(_ elapsed: TimeInterval) -> String {
        let seconds = max(0, Int(elapsed))
        if seconds >= 3600 {
            return String(format: "%02d:%02d:%02d", seconds / 3600, (seconds % 3600) / 60, seconds % 60)
        }
        return String(format: "%02d:%02d", seconds / 60, seconds % 60)
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
            unhealthy = true
            warningText = "录音连接异常，请检查录音状态"
            renderCaptions(animated: true, warning: true)
            showToolbar()
        } else if unhealthy {
            unhealthy = false
            warningText = ""
            renderCaptions(animated: true)
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
        lastSequence = -1
        lastFileSize = 0
        lastFileGrowthAt = Date()
        postTranslationOptions()
    }

    @objc func updateCaptionFallback() {
        guard !closing, !unhealthy, Date().timeIntervalSince(lastWebSocketEventAt) > 3, !currentAudioPath.isEmpty else { return }
        let path = realtimeTranscriptPath(audioPath: currentAudioPath)
        guard FileManager.default.fileExists(atPath: path) else { return }
        let lines = captionLines(readTail(path: path))
        guard let latest = lines.suffix(2).nilIfEmpty?.joined(separator: " "), latest != sourceText else { return }
        sourceText = latest
        translationText = ""
        translationFailed = false
        lastCaptionAt = Date()
        renderCaptions(animated: true)
    }

    func realtimeTranscriptPath(audioPath: String) -> String {
        (audioPath as NSString).deletingPathExtension + ".realtime.transcript.txt"
    }

    func readTail(path: String) -> String {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let size = attrs[.size] as? UInt64,
              let handle = try? FileHandle(forReadingFrom: URL(fileURLWithPath: path)) else { return "" }
        defer { try? handle.close() }
        let offset = size > transcriptTailBytes ? size - transcriptTailBytes : 0
        do {
            try handle.seek(toOffset: offset)
            let data = try handle.readToEnd() ?? Data()
            var text = String(data: data, encoding: .utf8) ?? ""
            if offset > 0, let newline = text.firstIndex(of: "\n") {
                text = String(text[text.index(after: newline)...])
            }
            return text
        } catch {
            return ""
        }
    }

    func captionLines(_ raw: String) -> [String] {
        raw.split(separator: "\n").compactMap { value in
            let line = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if line.isEmpty { return nil }
            if line.hasPrefix("[Me]") { return "你  " + line.dropFirst(4).trimmingCharacters(in: .whitespacesAndNewlines) }
            if line.hasPrefix("[Them]") { return "对方  " + line.dropFirst(6).trimmingCharacters(in: .whitespacesAndNewlines) }
            return line
        }
    }

    func renderCaptions(animated: Bool, warning: Bool = false) {
        guard expanded else { return }
        sourceLabel.isHidden = displayMode == .translation
        translationLabel.isHidden = displayMode == .source
        let displayedTranslation = translationFailed
            ? (displayMode == .translation && !sourceText.isEmpty ? "翻译暂不可用 · \(sourceText)" : "翻译暂不可用")
            : translationText
        let mainText = warningText.isEmpty
            ? (displayMode == .translation ? displayedTranslation : sourceText)
            : warningText
        let secondaryText = warningText.isEmpty && displayMode == .bilingual ? displayedTranslation : ""
        if displayMode == .translation {
            translationLabel.frame = sourceLabel.frame
            translationLabel.attributedStringValue = captionString(mainText, size: 30, color: .white, weight: .bold)
        } else {
            translationLabel.frame = NSRect(x: 24, y: 20, width: root.bounds.width - 48, height: 42)
            sourceLabel.attributedStringValue = captionString(
                mainText,
                size: 30,
                color: warning ? NSColor(hex: "#FFD1CC") : .white,
                weight: .bold
            )
            translationLabel.attributedStringValue = captionString(secondaryText, size: 18, color: NSColor(hex: "#F4E0AC"), weight: .semibold)
        }
        sourceLabel.alphaValue = mainText.isEmpty ? 0 : 1
        translationLabel.alphaValue = (displayMode == .translation ? mainText : secondaryText).isEmpty ? 0 : 1
        guard animated else { return }
        if !sourceLabel.isHidden && !mainText.isEmpty {
            sourceLabel.alphaValue = 0
            sourceLabel.animator().alphaValue = 1
        }
        if !translationLabel.isHidden && !(displayMode == .translation ? mainText : secondaryText).isEmpty {
            translationLabel.alphaValue = 0
            translationLabel.animator().alphaValue = 1
        }
    }

    func captionString(_ text: String, size: CGFloat, color: NSColor, weight: NSFont.Weight) -> NSAttributedString {
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .center
        paragraph.lineBreakMode = .byTruncatingTail
        return NSAttributedString(string: text, attributes: [
            .font: NSFont.systemFont(ofSize: size, weight: weight),
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ])
    }

    @objc func targetLanguageChanged() {
        translationFailed = false
        translationText = ""
        renderCaptions(animated: false)
        showToolbar()
        postTranslationOptions()
    }

    @objc func displayModeChanged() {
        displayMode = CaptionDisplayMode(rawValue: displayPopup.indexOfSelectedItem) ?? .source
        renderCaptions(animated: false)
        showToolbar()
        postTranslationOptions()
    }

    func loadTargetLanguage() -> String {
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/yulu/config.json")
        guard let data = try? Data(contentsOf: url),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let transcription = raw["transcription"] as? [String: Any],
              let dictation = transcription["dictation"] as? [String: Any],
              let target = dictation["target_language"] as? String else { return "English" }
        return target
    }

    func normalizedTargetLanguage(_ value: String) -> String {
        switch value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "japanese", "ja", "日本語": return "日本語"
        case "korean", "ko", "한국어": return "한국어"
        case "french", "fr", "français": return "Français"
        case "spanish", "es", "español": return "Español"
        case "german", "de", "deutsch": return "Deutsch"
        case "traditional chinese", "zh-hant", "繁體中文": return "繁體中文"
        default: return "English"
        }
    }

    func postTranslationOptions() {
        guard !currentAudioPath.isEmpty,
              let token = readMcpToken(),
              let url = URL(string: "http://127.0.0.1:\(hostPort())/api/recordings/realtime/options") else { return }
        let index = max(0, targetPopup.indexOfSelectedItem)
        let target = targetLanguages[min(index, targetLanguages.count - 1)].value
        let body: [String: Any] = [
            "audioPath": currentAudioPath,
            "targetLanguage": target,
            "translationEnabled": displayMode.translationEnabled,
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        var request = URLRequest(url: url, timeoutInterval: 5)
        request.httpMethod = "POST"
        request.httpBody = data
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        URLSession.shared.dataTask(with: request).resume()
    }

    func readMcpToken() -> String? {
        let url = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".config/yulu/mcp-token.json")
        guard let data = try? Data(contentsOf: url),
              let raw = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = raw["token"] as? String,
              !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        return token.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func hostPort() -> String {
        let port = ProcessInfo.processInfo.environment["YULU_UI_PORT"]?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return port.isEmpty ? "7777" : port
    }

    func connectWebSocket() {
        guard !closing, webSocketTask == nil,
              let url = URL(string: "ws://127.0.0.1:\(hostPort())/ws") else { return }
        let task = webSocketSession.webSocketTask(with: url)
        webSocketTask = task
        task.resume()
        let frame = "{\"type\":\"subscribe\",\"channel\":\"realtime-transcript\"}"
        task.send(.string(frame)) { [weak self] error in
            if error != nil { self?.webSocketFailed(task) }
        }
        receiveWebSocket(task)
    }

    func receiveWebSocket(_ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let message):
                let data: Data?
                switch message {
                case .string(let text): data = text.data(using: .utf8)
                case .data(let value): data = value
                @unknown default: data = nil
                }
                if let data,
                   let frame = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                    DispatchQueue.main.async { self.handleWebSocketFrame(frame) }
                }
                self.receiveWebSocket(task)
            case .failure:
                self.webSocketFailed(task)
            }
        }
    }

    func webSocketFailed(_ task: URLSessionWebSocketTask) {
        DispatchQueue.main.async { [weak self] in
            guard let self, self.webSocketTask === task, !self.closing else { return }
            self.webSocketTask = nil
            self.reconnectWorkItem?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.connectWebSocket() }
            self.reconnectWorkItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: item)
        }
    }

    func handleWebSocketFrame(_ frame: [String: Any]) {
        guard let channel = frame["channel"] as? String,
              let payload = frame["payload"] as? [String: Any] else { return }
        guard channel == "realtime-transcript", !currentAudioPath.isEmpty else { return }
        if let stem = payload["stem"] as? String,
           stem != ((currentAudioPath as NSString).deletingPathExtension as NSString).lastPathComponent { return }
        let sequence = (payload["sequence"] as? NSNumber)?.intValue ?? lastSequence + 1
        guard sequence > lastSequence else { return }
        lastSequence = sequence
        lastWebSocketEventAt = Date()
        sourceLanguage = payload["sourceLanguage"] as? String ?? payload["language"] as? String ?? sourceLanguage
        sourceLanguageLabel.stringValue = sourceLanguageTitle(sourceLanguage) + " →"
        let source = (payload["sourceText"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let translation = (payload["translationText"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let translationStatus = payload["translationStatus"] as? String ?? "disabled"
        if !source.isEmpty, source != sourceText {
            sourceText = source
            lastCaptionAt = Date()
        }
        translationText = translation
        translationFailed = translationStatus == "failed"
        unhealthy = false
        warningText = ""
        renderCaptions(animated: true)
    }

    func sourceLanguageTitle(_ value: String) -> String {
        switch value {
        case "en": return "English"
        case "ja": return "日本語"
        case "auto": return "自动"
        default: return "中文"
        }
    }

    func audioDaemonStatus() -> [String: Any]? {
        let socketPath = NSHomeDirectory() + "/.config/yulu/audio_daemon.sock"
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        if fd < 0 { return nil }
        defer { Darwin.close(fd) }
        var timeout = timeval(tv_sec: 1, tv_usec: 0)
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        _ = socketPath.withCString { pointer in
            strncpy(&address.sun_path.0, pointer, min(strlen(pointer), 103))
        }
        let connected = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if connected != 0 { return nil }
        let payload = Data("{\"action\":\"status\"}".utf8)
        let wrote = payload.withUnsafeBytes { Darwin.write(fd, $0.baseAddress, payload.count) }
        if wrote <= 0 { return nil }
        shutdown(fd, SHUT_WR)
        var output = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = Darwin.read(fd, &buffer, buffer.count)
            if count <= 0 { break }
            output.append(buffer, count: count)
        }
        guard !output.isEmpty else { return nil }
        return try? JSONSerialization.jsonObject(with: output) as? [String: Any]
    }

    @objc func doStop() {
        guard !stopping, !closing else { return }
        stopping = true
        recordingButton.stoppingState = true
        recordingButton.isEnabled = false
        showToolbar()
        let directory = (CommandLine.arguments[0] as NSString).deletingLastPathComponent
        let process = Process()
        process.executableURL = yuluPythonExecutable()
        process.arguments = ["\(directory)/meeting_daemon.py", "stop"]
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.closing else { return }
                if process.terminationStatus == 0 {
                    self.checkState()
                } else {
                    self.stopping = false
                    self.recordingButton.stoppingState = false
                    self.recordingButton.isEnabled = true
                    self.warningText = "停止录制失败，请重试"
                    self.lastCaptionAt = Date()
                    self.renderCaptions(animated: true, warning: true)
                    self.showToolbar()
                }
            }
        }
        do {
            try process.run()
            stopProcess = process
        } catch {
            stopping = false
            recordingButton.stoppingState = false
            recordingButton.isEnabled = true
            warningText = "停止录制失败，请重试"
            renderCaptions(animated: true, warning: true)
        }
    }

    func finishAndExit() {
        guard !closing else { return }
        closing = true
        [timeTimer, stateTimer, captionTimer].forEach { $0?.invalidate() }
        webSocketTask?.cancel(with: .normalClosure, reason: nil)
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
}

extension Timer {
    func addToCommonRunLoop() { RunLoop.current.add(self, forMode: .common) }
}

extension ArraySlice {
    var nilIfEmpty: ArraySlice<Element>? { isEmpty ? nil : self }
}

let arguments = CommandLine.arguments
if arguments.contains("--self-test") {
    let app = AppDel(title: "test", path: "")
    assert(app.realtimeTranscriptPath(audioPath: "/tmp/Memo_20260630_120000.wav") == "/tmp/Memo_20260630_120000.realtime.transcript.txt")
    assert(app.captionLines("[Me] hello\n\n[Them] world\nplain\n") == ["你  hello", "对方  world", "plain"])
    assert(app.formatElapsed(12 * 60 + 48) == "12:48")
    assert(app.normalizedTargetLanguage("Japanese") == "日本語")
    assert(app.parseState(["recording": ["audio_path": "/tmp/a.wav"]]).recording == true)
    assert(app.displayMode == .source && !app.displayMode.translationEnabled)
    let captionAttributes = app.captionString("caption", size: 30, color: .white, weight: .bold).attributes(at: 0, effectiveRange: nil)
    assert(captionAttributes[.shadow] == nil)
    assert(captionAttributes[.backgroundColor] == nil)
    assert(captionAttributes[.strokeWidth] == nil && captionAttributes[.strokeColor] == nil)
    let outlinedLabel = OutlinedCaptionLabel(frame: NSRect(x: 0, y: 0, width: 400, height: 66))
    outlinedLabel.attributedStringValue = app.captionString("caption", size: 30, color: .white, weight: .bold)
    let outlineAttributes = outlinedLabel.outlineAttributedStringValue.attributes(at: 0, effectiveRange: nil)
    assert((outlineAttributes[.strokeWidth] as? NSNumber)?.doubleValue == 9.0)
    assert((outlineAttributes[.strokeColor] as? NSColor) == NSColor.black)
    let compactToolbar = app.toolbarFrame(compact: true, in: NSRect(x: 0, y: 0, width: 900, height: 176))
    assert(compactToolbar.width == compactToolbarWidth)
    let compactButton = RecordingButton(frame: app.compactRecordingButtonFrame(in: NSRect(origin: .zero, size: compactToolbar.size)))
    assert(compactButton.frame.midX == compactToolbar.width / 2 && compactButton.frame.midY == toolbarHeight / 2)
    compactButton.centersContent = true
    let buttonAttributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 10, weight: .semibold)]
    let buttonContent = compactButton.contentFrames(label: "录制中", attributes: buttonAttributes)
    assert(abs(NSUnionRect(buttonContent.indicator, buttonContent.label).midX - compactButton.bounds.midX) < 0.5)
    assert(buttonContent.indicator.midY == compactButton.bounds.midY && buttonContent.label.midY == compactButton.bounds.midY)
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
