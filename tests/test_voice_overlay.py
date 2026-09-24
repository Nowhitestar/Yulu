"""Exercise native voice permission denial and layout without recording."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu/scripts"
pytestmark = pytest.mark.skipif(sys.platform != "darwin", reason="Native macOS view")


@pytest.fixture(scope="module")
def voice_overlay_preview(tmp_path_factory):
    build = tmp_path_factory.mktemp("voice-overlay")
    source = build / "preview.swift"
    source.write_text(r'''
import Cocoa

final class OffscreenVoicePanel: NSPanel {
    override func orderFrontRegardless() {} // Exercise the controller without a visible desktop window.
}

@main struct Preview {
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
        if CommandLine.arguments[1] == "motion" {
            let view = VoiceOverlayContentView(frame: NSRect(x: 0, y: 0, width: 244, height: 48))
            let motion = VoiceOverlayMotion()
            motion.reduceMotion = { false }
            var scheduled: [(TimeInterval, () -> Void)] = []
            motion.schedule = { scheduled.append(($0, $1)) }
            var hidden = 0
            motion.show(view)
            precondition(motion.phase == .appearing)
            precondition(view.layer?.animation(forKey: "voice-transform") != nil)
            motion.hide(view, canceled: true) { hidden += 1 }
            motion.show(view) // Reverse an interrupted exit.
            scheduled[0].1()
            scheduled[1].1()
            precondition(motion.phase == .appearing && hidden == 0)
            scheduled[2].1()
            precondition(motion.phase == .visible)
            motion.show(view) // New processing labels do not restart the entrance.
            precondition(scheduled.count == 3)
            motion.hide(view) { hidden += 1 }
            motion.hide(view) { hidden += 100 } // Repeated idle poll.
            precondition(scheduled.count == 4)
            scheduled[3].1()
            precondition(motion.phase == .hidden && hidden == 1)
            precondition(scheduled.allSatisfy { $0.0 > 0 && $0.0 <= 0.25 })
            motion.reduceMotion = { true }
            motion.show(view)
            precondition(scheduled.last!.0 == 0)
            precondition(view.layer?.animation(forKey: "voice-transform") == nil)
            precondition(CATransform3DIsIdentity(view.layer!.transform))
            precondition(view.layer!.opacity == 1)
            scheduled.last!.1()
            motion.hide(view) { hidden += 1 }
            precondition(scheduled.last!.0 == 0)
            scheduled.last!.1()
            precondition(hidden == 2 && view.layer!.opacity == 0)
            print("motion-interruption-and-reduced-motion-ok")
            return
        }
        if CommandLine.arguments[1].hasPrefix("lifecycle") {
            let root = URL(fileURLWithPath: CommandLine.arguments[2])
            let environment = try JSONDecoder().decode([String: String].self,
                from: Data(contentsOf: root.appendingPathComponent("environment.json")))
            let controls = NativeRecordingControls(environment: environment, openRoute: { _ in })
            let controller = StatusAgentApp()
            controller.statusItem = NSStatusBar.system.statusItem(withLength: 0)
            controller.menu = NSMenu()
            controller.state = .idle
            let panel = OffscreenVoicePanel(contentRect: NSRect(x: 0, y: 0, width: 244, height: 48),
                styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
            let visual = VoiceOverlayContentView(frame: panel.contentView!.bounds)
            panel.contentView = visual
            controller.voiceOverlayWindow = panel
            controller.voiceOverlayWave = visual.waveView
            visual.cancelButton.target = controller
            visual.cancelButton.action = NSSelectorFromString("cancelVoiceInputFromOverlay")
            func waitUntil(_ predicate: () -> Bool) {
                let deadline = Date().addingTimeInterval(5)
                while !predicate() && Date() < deadline {
                    RunLoop.main.run(until: Date().addingTimeInterval(0.005))
                }
                precondition(predicate(), "Voice lifecycle did not settle")
            }
            if CommandLine.arguments[1] == "lifecycle-error" {
                let noticePanel = OffscreenVoicePanel(contentRect: .zero,
                    styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
                let notice = VoiceOverlayContentView(frame: .zero)
                noticePanel.contentView = notice
                controller.voiceFeedbackWindow = noticePanel
                notice.cancelButton.target = controller
                notice.cancelButton.action = NSSelectorFromString("dismissVoiceFeedback")
                controller.onVoiceChat()
                waitUntil { notice.mode == .failure }
                waitUntil { controller.voiceOverlayMotion.phase == .hidden }
                precondition(noticePanel !== panel && noticePanel.frame.width == 360)
                precondition(!notice.statusLabel.isHidden && notice.copyButton.isHidden)
                precondition(visual.statusLabel.isHidden && panel.frame.size == VoiceOverlayContentView.capsuleSize)
                notice.cancelButton.performClick(nil)
                waitUntil { controller.voiceFeedbackMotion.phase == .hidden }
                precondition(controller.feedbackVisibleUntil == nil)
                controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
                withExtendedLifetime(controls) {}
                print("voice-lifecycle-ok separate-error-panel")
                return
            }
            let started = ProcessInfo.processInfo.systemUptime
            controller.onVoiceChat()
            let response = ProcessInfo.processInfo.systemUptime - started
            precondition(response < 0.20, "Initial feedback waited for the helper")
            precondition(visual.mode == .starting && !visual.stopButton.isEnabled)
            controller.onVoiceChat() // Stop before the first helper is ready.
            precondition(controller.pendingVoiceStop != nil)
            waitUntil { controller.pendingStartFeedbackText == nil && controller.state == .idle }
            waitUntil { controller.voiceOverlayMotion.phase == .hidden }
            precondition(controller.voiceRecoveryText == nil)
            controller.onVoiceChat()
            waitUntil { FileManager.default.fileExists(atPath: root.appendingPathComponent("capture").path) }
            visual.cancelButton.performClick(nil)
            controller.onVoiceChat() // Restart while the old cancellation is still running.
            let doubleRestart = CommandLine.arguments[1] == "lifecycle-double-restart"
            if doubleRestart {
                controller.onVoiceChat() // Preserve a second finish request during cancellation.
                waitUntil {
                    let events = (try? String(contentsOf: root.appendingPathComponent("events"), encoding: .utf8)) ?? ""
                    return events.split(separator: "\n").count == 7 && controller.state == .idle
                }
            } else {
                waitUntil { controller.state == .recording && controller.pendingStartFeedbackText == nil }
                precondition(visual.mode == .recording && visual.stopButton.isEnabled)
            }
            let events = try String(contentsOf: root.appendingPathComponent("events"), encoding: .utf8)
                .split(separator: "\n").map(String.init)
            let expected = ["start", "stop", "start", "cancel-begin", "cancel-end", "start"]
                + (doubleRestart ? ["stop"] : [])
            precondition(events == expected, events.description)
            if !doubleRestart { controller.onVoiceChat() }
            waitUntil { controller.state == .idle }
            waitUntil { controller.voiceOverlayMotion.phase == .hidden }
            precondition(controller.voiceRecoveryText == nil && !panel.isVisible)
            controller.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
            withExtendedLifetime(controls) {}
            print("voice-lifecycle-ok response_ms=\(Int(response * 1000))")
            return
        }
        if CommandLine.arguments[1] == "paste-feedback" {
            precondition(voiceResultPresentation(pasted: true, dispatched: true, failed: false) == .dismiss)
            precondition(voiceResultPresentation(pasted: false, dispatched: true, failed: false) == .unconfirmed)
            precondition(voiceResultPresentation(pasted: false, dispatched: false, failed: false) == .recovery)
            precondition(voiceResultPresentation(pasted: false, dispatched: true, failed: true) == .recovery)
            let before = PasteTextSnapshot(value: "hello 🌏 world", selection: CFRange(location: 6, length: 2))
            precondition(before.confirmsInsertion("朋友", after: PasteTextSnapshot(value: "hello 朋友 world", selection: nil)))
            let web = PasteTextSnapshot(value: "Editor label: old", selection: nil)
            precondition(web.confirmsInsertion("新文字", after: PasteTextSnapshot(value: "Editor label: old新文字", selection: nil)))
            let existing = PasteTextSnapshot(value: "already has 新文字", selection: nil)
            precondition(!existing.confirmsInsertion("新文字", after: existing))
            precondition(!web.confirmsInsertion("新文字", after: PasteTextSnapshot(value: "Editor label: changed", selection: nil)))
            precondition(!web.confirmsInsertion("新文字", after: PasteTextSnapshot(value: nil, selection: nil)))
            precondition(!PasteTextSnapshot(value: nil, selection: nil).confirmsInsertion("新文字", after: existing))
            precondition(!web.confirmsInsertion("", after: existing))
            print("paste-feedback-ok")
            return
        }
        if CommandLine.arguments[1] == "permissions" {
            let controller = StatusAgentApp()
            for permission in [(false, false), (true, false), (false, true)] {
                controller.inputAccessCheck = { permission }
                // Empty text avoids changing the user's clipboard. A nonexistent
                // target proves denial is handled before trying to activate it.
                let result = controller.pasteClipboard(text: "", targetBundleId: "com.yulu.test.absent", targetAppName: nil)
                precondition(result["ok"] as? Bool == false)
                precondition(result["error"] as? String == "accessibility_not_trusted")
                precondition(result["dispatched"] as? Bool == false)
                precondition(result["copied"] as? Bool == false)
                precondition(result["verified"] as? Bool == false)
            }
            print("permission-denial-ok")
            return
        }
        let dark = CommandLine.arguments[1] == "dark"
        let appearance = NSAppearance(named: dark ? .darkAqua : .aqua)!
        app.appearance = appearance
        let canvas = NSView(frame: NSRect(x: 0, y: 0, width: 432, height: 740))
        canvas.appearance = appearance
        canvas.wantsLayer = true
        canvas.layer?.backgroundColor = (dark ? NSColor(calibratedWhite: 0.10, alpha: 1)
            : NSColor(calibratedWhite: 0.94, alpha: 1)).cgColor
        let window = NSWindow(contentRect: canvas.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = canvas
        let samples: [(String, String, VoiceOverlayAnimationMode, String, Bool)] = [
            ("听写中", "再次按快捷键结束", .recording, "", false),
            ("正在整理文字", "正在处理这段录音", .processing, "", false),
            ("文字已识别", "请确认输入框，也可按 ⌘V 粘贴", .recovery,
             "请把讨论要点整理成一份简短的会议纪要。\n保留负责人和截止时间。", false),
            ("文字已识别", "未能自动输入，可复制后粘贴", .recovery,
             String(repeating: "长文本也需要保留完整内容，复制时不能丢字。", count: 30), false),
            ("文字已识别", "需开启输入权限，才能自动粘贴", .recovery,
             "这段文字已保留，开启权限后即可自动输入。", true),
        ]
        let starting = VoiceOverlayContentView(frame: .zero)
        let startingSize = starting.update(title: "正在启动…", hint: "", mode: .starting)
        precondition(startingSize == NSSize(width: 122, height: 24))
        precondition(!starting.stopButton.isHidden && !starting.stopButton.isEnabled)
        precondition(!starting.cancelButton.isHidden && starting.statusLabel.isHidden)
        var y: CGFloat = 720
        var heights: [CGFloat] = []
        let confirmation = VoiceOverlayContentView(frame: .zero)
        let confirmationSize = confirmation.update(title: "已输入", hint: "", mode: .success)
        precondition(confirmationSize.height == 24 && confirmation.statusLabel.isHidden)
        precondition(confirmation.stopButton.isHidden && confirmation.cancelButton.isHidden && confirmation.copyButton.isHidden)
        for (title, hint, mode, transcript, needsInputAccess) in samples {
            let view = VoiceOverlayContentView(frame: .zero)
            view.appearance = appearance
            let size = view.update(title: title, hint: hint, mode: mode, transcript: transcript, needsInputAccess: needsInputAccess)
            precondition(size.width <= 380 && size.height <= 184)
            precondition(view.stopButton.isHidden == (mode != .recording))
            precondition(view.copyButton.isHidden == (mode != .recovery))
            precondition(view.permissionButton.isHidden == !needsInputAccess)
            precondition(!view.cancelButton.isHidden)
            precondition(view.transcriptLabel.stringValue == transcript)
            y -= size.height
            view.frame = NSRect(x: (432 - size.width) / 2, y: y, width: size.width, height: size.height)
            view.waveView.level = 0.55
            canvas.addSubview(view)
            view.layoutSubtreeIfNeeded()
            precondition(view.statusLabel.frame.maxX <= view.cancelButton.frame.minX)
            if mode == .recording || mode == .processing {
                precondition(size == NSSize(width: 122, height: 24))
                precondition(view.statusLabel.isHidden && view.hintLabel.isHidden)
                precondition(view.waveView.toolTip == nil)
                precondition(view.waveView.frame.maxX < view.cancelButton.frame.minX)
                if mode == .recording { precondition(view.cancelButton.frame.maxX < view.stopButton.frame.minX) }
                precondition(view.stopButton.frame.maxX < view.bounds.maxX)
            }
            if mode == .recovery {
                precondition(view.transcriptLabel.frame.maxY < view.copyButton.frame.minY)
                if needsInputAccess { precondition(view.permissionButton.frame.maxX < view.copyButton.frame.minX) }
            }
            heights.append(size.height)
            y -= 18
        }
        let failure = VoiceOverlayContentView(frame: .zero)
        let failureSize = failure.update(title: "Unable to start dictation. Check microphone access and try again.", hint: "", mode: .failure)
        failure.frame = NSRect(origin: .zero, size: failureSize)
        failure.layoutSubtreeIfNeeded()
        precondition(failureSize.width == 360 && failureSize.height >= 52)
        precondition(!failure.statusLabel.isHidden && failure.statusLabel.cell?.wraps == true)
        precondition(failure.statusLabel.frame.maxX < failure.cancelButton.frame.minX)
        canvas.layoutSubtreeIfNeeded()
        let bitmap = canvas.bitmapImageRepForCachingDisplay(in: canvas.bounds)!
        appearance.performAsCurrentDrawingAppearance {
            canvas.cacheDisplay(in: canvas.bounds, to: bitmap)
        }
        try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
        let data = try JSONSerialization.data(withJSONObject: ["heights": heights, "offscreen": !window.isVisible])
        print(String(data: data, encoding: .utf8)!)
    }
}
''', encoding="utf-8")
    binary = build / "preview"
    env = os.environ.copy()
    env.setdefault("DEVELOPER_DIR", "/Library/Developer/CommandLineTools")
    result = subprocess.run([
        "swiftc", "-parse-as-library", "-D", "YULU_NATIVE_RECORDING_LIBRARY",
        str(SCRIPTS / "status_agent.swift"), str(SCRIPTS / "native_notifications.swift"), str(source),
        "-module-cache-path", "/private/tmp/yulu-swift-module-cache",
        "-framework", "Cocoa", "-framework", "Carbon", "-framework", "WebKit",
        "-framework", "UserNotifications", "-o", str(binary),
    ], env=env, capture_output=True, text=True, timeout=60)
    assert result.returncode == 0, result.stderr
    return binary


def test_denied_voice_input_does_not_activate_a_target_or_report_paste(voice_overlay_preview):
    result = subprocess.run([str(voice_overlay_preview), "permissions"],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "permission-denial-ok"


def test_paste_confirmation_and_nonintrusive_feedback(voice_overlay_preview):
    result = subprocess.run([str(voice_overlay_preview), "paste-feedback"],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "paste-feedback-ok"


@pytest.mark.parametrize("appearance", ["light", "dark"])
def test_native_voice_overlay_layout_and_text_recovery(voice_overlay_preview, tmp_path, appearance):
    result = subprocess.run([str(voice_overlay_preview), appearance, str(tmp_path / f"{appearance}.png")],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    measured = json.loads(result.stdout)
    assert measured["offscreen"] is True
    assert measured["heights"][:2] == [24, 24]
    assert measured["heights"][2] < measured["heights"][3] <= 184


def test_voice_motion_can_reverse_and_respects_reduce_motion(voice_overlay_preview):
    result = subprocess.run([str(voice_overlay_preview), "motion"],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "motion-interruption-and-reduced-motion-ok"


@pytest.mark.parametrize("scenario", ["lifecycle", "lifecycle-double-restart", "lifecycle-error"])
def test_voice_start_early_stop_cancel_and_restart_use_isolated_helpers(voice_overlay_preview, tmp_path, scenario):
    for directory in ["data/dictation", "ipc", "logs", "media"]:
        (tmp_path / directory).mkdir(parents=True, exist_ok=True)
    (tmp_path / "data/config.json").write_text('{"status_agent":{"feedback_sounds":false}}')
    (tmp_path / "data/dictation/state.json").write_text('{"intent":"voice_chat"}')
    (tmp_path / "dictate.py").write_text('''import json, os, sys, time
from pathlib import Path
root = Path(os.environ["HOME"])
if (root / "fail-start").exists():
    print(json.dumps({"error_code":"capture_unavailable"}), flush=True)
    sys.exit(1)
capture = root / "capture"
def event(value):
    with (root / "events").open("a") as output: output.write(value + "\\n")
if sys.argv[1] == "cancel":
    event("cancel-begin")
    time.sleep(.15)
    capture.unlink(missing_ok=True)
    event("cancel-end")
    print(json.dumps({"canceled": True}), flush=True)
elif capture.exists():
    event("stop")
    capture.unlink()
    time.sleep(.25)
    print(json.dumps({"action":"stop", "chat":{}}), flush=True)
else:
    event("start")
    capture.touch()
    time.sleep(.25)
    print(json.dumps({"action":"start"}), flush=True)
''')
    if scenario == "lifecycle-error":
        (tmp_path / "fail-start").touch()
    (tmp_path / "environment.json").write_text(json.dumps({
        "HOME": str(tmp_path), "YULU_APPLICATION_SUPPORT_DIR": str(tmp_path / "data"),
        "YULU_IPC_DIR": str(tmp_path / "ipc"), "YULU_CACHE_DIR": str(tmp_path / "ipc"),
        "YULU_LOG_DIR": str(tmp_path / "logs"), "YULU_MEDIA_LIBRARY_DIR": str(tmp_path / "media"),
        "YULU_LEGACY_READ_ONLY_DATA_DIR": str(tmp_path / "legacy"),
        "YULU_SCRIPT_DIR": str(tmp_path), "YULU_PYTHON": sys.executable,
        "YULU_MANAGE_REMINDERS": "0", "PATH": "/usr/bin:/bin",
    }))
    result = subprocess.run([str(voice_overlay_preview), scenario, str(tmp_path)],
                            capture_output=True, text=True, timeout=20)
    assert result.returncode == 0, result.stderr
    assert "voice-lifecycle-ok" in result.stdout
