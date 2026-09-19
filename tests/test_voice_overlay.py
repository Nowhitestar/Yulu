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

@main struct Preview {
    static func main() throws {
        let app = NSApplication.shared
        app.setActivationPolicy(.prohibited)
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
        var y: CGFloat = 720
        var heights: [CGFloat] = []
        let confirmation = VoiceOverlayContentView(frame: .zero)
        let confirmationSize = confirmation.update(title: "已输入", hint: "", mode: .success)
        precondition(confirmationSize.height == 44)
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
            if mode == .recovery {
                precondition(view.transcriptLabel.frame.maxY < view.copyButton.frame.minY)
                if needsInputAccess { precondition(view.permissionButton.frame.maxX < view.copyButton.frame.minX) }
            }
            heights.append(size.height)
            y -= 18
        }
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


@pytest.mark.parametrize("appearance", ["light", "dark"])
def test_native_voice_overlay_layout_and_text_recovery(voice_overlay_preview, tmp_path, appearance):
    result = subprocess.run([str(voice_overlay_preview), appearance, str(tmp_path / f"{appearance}.png")],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    measured = json.loads(result.stdout)
    assert measured["offscreen"] is True
    assert measured["heights"][:2] == [60, 60]
    assert measured["heights"][2] < measured["heights"][3] <= 184
