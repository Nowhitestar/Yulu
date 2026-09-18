import Cocoa
import UserNotifications

/// Only semantic events cross IPC. Copy and destinations belong to the App;
/// callers cannot inject URLs, error traces, sounds or arbitrary notification text.
struct YuluNotice {
    enum Kind: String {
        case meetingSoon = "meeting_soon"
        case recordingSaved = "recording_saved"
        case summaryReady = "summary_ready"
        case processingAttention = "processing_attention"
        case audioUnavailable = "audio_unavailable"
        case calendarEmpty = "calendar_empty"
    }

    let kind: Kind
    let id: String
    let subject: String
    let stem: String?

    init?(_ payload: [String: Any]) {
        guard let rawKind = payload["kind"] as? String, let kind = Kind(rawValue: rawKind),
              let id = payload["id"] as? String, !id.isEmpty, id.utf8.count <= 512,
              !id.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        let rawStem = payload["stem"] as? String
        if let rawStem {
            guard !rawStem.isEmpty, rawStem.utf8.count <= 255,
                  rawStem != ".", rawStem != "..",
                  !rawStem.contains("/"), !rawStem.contains("\\"),
                  !rawStem.unicodeScalars.contains(where: { CharacterSet.controlCharacters.contains($0) }) else { return nil }
        }
        if kind == .summaryReady || kind == .processingAttention {
            guard rawStem != nil else { return nil }
        }
        self.kind = kind
        self.id = id
        self.stem = rawStem
        let title = (payload["title"] as? String ?? "")
            .components(separatedBy: .whitespacesAndNewlines).filter { !$0.isEmpty }.joined(separator: " ")
            .unicodeScalars.filter { !CharacterSet.controlCharacters.contains($0) }
        let clean = String(String.UnicodeScalarView(title))
        self.subject = clean.count > 90 ? String(clean.prefix(89)) + "…" : clean
    }

    var key: String { "\(kind.rawValue):\(id)" }
    // A newer result replaces the saved/progress notice for the same recording.
    var group: String { stem.map { "recording:\($0)" } ?? "\(kind.rawValue):\(id)" }
    var route: String {
        if let stem {
            let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
            return "/inbox/\(stem.addingPercentEncoding(withAllowedCharacters: allowed)!)"
        }
        switch kind {
        case .audioUnavailable: return "/health"
        case .calendarEmpty: return "/settings/meetings"
        default: return "/inbox"
        }
    }
    var payload: [String: String] {
        var result = ["kind": kind.rawValue, "id": id, "title": subject]
        result["stem"] = stem
        return result
    }
    var audible: Bool { kind == .meetingSoon || kind == .audioUnavailable }

    func copy(english: Bool) -> (title: String, body: String) {
        let meeting = subject.isEmpty ? (english ? "Untitled recording" : "未命名录音") : subject
        switch kind {
        case .meetingSoon: return (english ? "Meeting in 5 minutes" : "会议将在 5 分钟后开始", meeting)
        case .recordingSaved: return (english ? "Recording saved" : "录音已保存", meeting)
        case .summaryReady: return (english ? "Summary ready" : "纪要已完成", meeting)
        case .processingAttention: return (english ? "Processing needs attention" : "录音处理需要关注", meeting)
        case .audioUnavailable:
            return (english ? "Audio service unavailable" : "音频服务暂不可用",
                    english ? "Open Health to restore recording." : "打开健康状态，恢复录音服务。")
        case .calendarEmpty:
            return (english ? "Calendar needs checking" : "请检查日历同步",
                    english ? "No meetings returned. Existing reminders were kept." : "未获取到会议，已保留现有提醒。")
        }
    }
}

/// All methods that touch AppKit or deduplication state run on the main queue.
/// The delegate is installed at App launch, including launches from a banner.
public final class YuluNotificationPresenter: NSObject, UNUserNotificationCenterDelegate {
    public static let shared = YuluNotificationPresenter()
    private var openRoute: ((String) -> Void)?
    private var english: () -> Bool = { false }
    private var center: UNUserNotificationCenter?
    private var seen: [String: Date] = [:]
    private var latest: [String: String] = [:]
    private var pending: [YuluNotice] = []
    private var checkingAuthorization = false
    private var toast: NSView?
    private var toastRoute: String?
    private var dismissWork: DispatchWorkItem?

    public func configure(openRoute: @escaping (String) -> Void) {
        self.openRoute = openRoute
        // UNUserNotificationCenter traps in a command-line executable. Only the
        // actual App may own delivery; legacy helpers must not impersonate it.
        guard Bundle.main.bundleIdentifier == "com.yulu.app" else { return }
        center = UNUserNotificationCenter.current()
        center?.delegate = self
    }

    func setLanguage(_ english: @escaping () -> Bool) { self.english = english }

    func receive(_ payload: [String: Any]) -> [String: Any] {
        guard let notice = YuluNotice(payload) else { return ["ok": false, "error": "invalid_notification"] }
        guard center != nil else { return ["ok": false, "error": "notification_app_unavailable"] }
        let now = Date()
        seen = seen.filter { now.timeIntervalSince($0.value) < 600 }
        if seen[notice.key] != nil { return ["ok": true, "duplicate": true] }
        if seen.count >= 256 {
            if let oldest = seen.min(by: { $0.value < $1.value })?.key { seen.removeValue(forKey: oldest) }
        }
        seen[notice.key] = now
        if latest.count >= 256 { latest.removeAll() }
        latest[notice.group] = notice.key
        center?.removeDeliveredNotifications(withIdentifiers: [notice.group])
        center?.removePendingNotificationRequests(withIdentifiers: [notice.group])
        if showToast(notice) { return ["ok": true, "presentation": "in_app"] }
        pending.append(notice)
        if pending.count > 32 { pending.removeFirst() }
        authorizeAndDeliver()
        // Acceptance is not proof of OS delivery (Focus / user permissions apply).
        return ["ok": true, "accepted": true]
    }

    private func authorizeAndDeliver() {
        guard !checkingAuthorization, let center else { return }
        checkingAuthorization = true
        center.getNotificationSettings { [weak self] settings in
            if settings.authorizationStatus == .notDetermined {
                center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                    DispatchQueue.main.async { self?.deliverPending(allowed: granted) }
                }
            } else {
                let allowed = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
                DispatchQueue.main.async { self?.deliverPending(allowed: allowed) }
            }
        }
    }

    private func deliverPending(allowed: Bool) {
        checkingAuthorization = false
        let notices = pending
        pending.removeAll()
        guard allowed, let center else {
            NSLog("Yulu notifications are disabled in System Settings.")
            return
        }
        for notice in notices where latest[notice.group] == notice.key {
            if showToast(notice) { continue }
            let copy = notice.copy(english: english())
            let content = UNMutableNotificationContent()
            content.title = copy.title
            content.body = copy.body
            content.threadIdentifier = notice.group
            content.userInfo = notice.payload
            if notice.audible { content.sound = .default }
            center.add(UNNotificationRequest(identifier: notice.group, content: content, trigger: nil)) { error in
                if let error { NSLog("Yulu notification delivery failed: %@", (error as NSError).domain) }
            }
        }
    }

    @discardableResult func showToast(_ notice: YuluNotice) -> Bool {
        guard NSApp.isActive,
              let window = NSApp.windows.first(where: { $0.isVisible && !$0.isMiniaturized && $0.level == .normal && $0.styleMask.contains(.titled) }),
              let parent = window.contentView else { return false }
        dismissToast()
        let copy = notice.copy(english: english())
        let panel = NSVisualEffectView()
        panel.material = .popover
        panel.blendingMode = .withinWindow
        panel.state = .active
        panel.wantsLayer = true
        panel.layer?.cornerRadius = 12
        panel.layer?.masksToBounds = true
        panel.setAccessibilityRole(.group)
        panel.setAccessibilityLabel(copy.title + ", " + copy.body)
        let title = NSTextField(labelWithString: copy.title)
        title.font = .systemFont(ofSize: 13, weight: .semibold)
        let body = NSTextField(labelWithString: copy.body)
        body.font = .systemFont(ofSize: 12)
        body.textColor = .secondaryLabelColor
        body.lineBreakMode = .byTruncatingTail
        body.maximumNumberOfLines = 1
        title.lineBreakMode = .byTruncatingTail
        title.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        body.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let labels = NSStackView(views: [title, body])
        labels.orientation = .vertical
        labels.alignment = .leading
        labels.spacing = 4
        let open = NSButton(title: english() ? "View" : "查看", target: self, action: #selector(openToast))
        open.bezelStyle = .rounded
        let close = NSButton(image: NSImage(systemSymbolName: "xmark", accessibilityDescription: english() ? "Dismiss" : "关闭")!, target: self, action: #selector(dismissToast))
        close.isBordered = false
        let row = NSStackView(views: [labels, open, close])
        row.spacing = 12
        labels.setContentHuggingPriority(.defaultLow, for: .horizontal)
        labels.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        row.translatesAutoresizingMaskIntoConstraints = false
        panel.addSubview(row)
        panel.translatesAutoresizingMaskIntoConstraints = false
        parent.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.trailingAnchor.constraint(equalTo: parent.trailingAnchor, constant: -20),
            panel.bottomAnchor.constraint(equalTo: parent.bottomAnchor, constant: -20),
            panel.leadingAnchor.constraint(greaterThanOrEqualTo: parent.leadingAnchor, constant: 20),
            panel.widthAnchor.constraint(lessThanOrEqualToConstant: 420),
            row.leadingAnchor.constraint(equalTo: panel.leadingAnchor, constant: 16),
            row.trailingAnchor.constraint(equalTo: panel.trailingAnchor, constant: -14),
            row.topAnchor.constraint(equalTo: panel.topAnchor, constant: 14),
            row.bottomAnchor.constraint(equalTo: panel.bottomAnchor, constant: -14),
        ])
        toast = panel
        toastRoute = notice.route
        NSAccessibility.post(element: panel, notification: .announcementRequested, userInfo: [
            .announcement: copy.title + ", " + copy.body, .priority: NSAccessibilityPriorityLevel.medium.rawValue,
        ])
        let work = DispatchWorkItem { [weak self] in self?.dismissToast() }
        dismissWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + 8, execute: work)
        return true
    }

    @objc private func openToast() {
        let route = toastRoute
        dismissToast()
        if let route { openRoute?(route) }
    }

    @objc private func dismissToast() {
        dismissWork?.cancel()
        dismissWork = nil
        toast?.removeFromSuperview()
        toast = nil
        toastRoute = nil
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                      withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async { [weak self] in
            defer { completionHandler() }
            guard response.actionIdentifier == UNNotificationDefaultActionIdentifier,
                  let payload = response.notification.request.content.userInfo as? [String: Any],
                  let notice = YuluNotice(payload) else { return }
            self?.openRoute?(notice.route)
        }
    }

    public func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                      withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        DispatchQueue.main.async { [weak self] in
            if let payload = notification.request.content.userInfo as? [String: Any],
               let notice = YuluNotice(payload), self?.showToast(notice) == true {
                completionHandler([])
            } else {
                completionHandler(notification.request.content.sound == nil ? [.banner, .list] : [.banner, .list, .sound])
            }
        }
    }
}
