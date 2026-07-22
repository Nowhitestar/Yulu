"""Status-agent config block (enabled flag + plist install helpers)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import status_agent_config as sac


def _stub_config(tmp_path: Path, monkeypatch, payload: dict | None = None) -> Path:
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps(payload or {}, ensure_ascii=False, indent=2))
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    return cfg


def test_load_defaults_when_block_missing(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {})
    block = sac.load()
    assert block["enabled"] is True
    assert block["hotkeys"]["dictate"]["key"] == "Space"
    assert block["hotkeys"]["translate"]["target_language"] == "English"
    assert block["hotkeys"]["voice_chat"]["key"] == "A"


def test_load_defaults_when_config_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sac, "CONFIG_PATH", tmp_path / "nonexistent.json")
    block = sac.load()
    assert block["enabled"] is True


def test_load_preserves_existing_block(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {
        "status_agent": {"enabled": False}
    })
    block = sac.load()
    assert block["enabled"] is False


def test_save_writes_block_under_status_agent_key(tmp_path, monkeypatch):
    cfg = _stub_config(tmp_path, monkeypatch, {"audio": {"backend": "daemon"}})
    sac.save({"enabled": False})
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["status_agent"]["enabled"] is False
    # Unrelated blocks preserved
    assert data["audio"]["backend"] == "daemon"


def test_save_creates_config_when_missing(tmp_path, monkeypatch):
    cfg = tmp_path / "fresh.json"
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    sac.save({"enabled": True})
    assert cfg.exists()
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is True


def test_status_agent_hotkeys_shape(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {})
    hotkeys = sac.status_agent_hotkeys()
    assert [item["action"] for item in hotkeys] == ["dictate", "translate", "voice_chat"]
    assert hotkeys[0]["keyCode"] == 49
    assert hotkeys[0]["modifierMask"] == 0x1800
    assert hotkeys[1]["targetLanguage"] == "English"


def test_status_agent_translate_hotkey_uses_dictation_target_language(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {
        "transcription": {"dictation": {"target_language": "Japanese"}},
        "status_agent": {
            "hotkeys": {
                "translate": {"key": "T", "modifiers": ["ctrl", "alt"], "target_language": "English"}
            }
        },
    })
    hotkeys = sac.status_agent_hotkeys()
    assert hotkeys[1]["targetLanguage"] == "Japanese"


# ─── Swift status_agent.swift static gates ─────────────────────────────────────
# Source-static asserts (no swiftc) over the menu-bar agent: it resolves the
# recordings base directory from config.json `audio.output_dir` (D-07), scans a
# single recordings root (the voicemails/ subdir was merged away), and shells
# out to the current recording/dictation modules.

STATUS_AGENT_SWIFT = SCRIPTS / "status_agent.swift"


def _swift_source() -> str:
    return STATUS_AGENT_SWIFT.read_text(encoding="utf-8")


def test_status_agent_swift_exists():
    assert STATUS_AGENT_SWIFT.exists(), f"missing {STATUS_AGENT_SWIFT}"


def test_status_agent_has_config_output_dir_reader():
    src = _swift_source()
    # The ported config.json reader must exist and key on `output_dir` (D-07).
    assert "func loadRecordingDir()" in src, "loadRecordingDir() reader not added"
    assert "output_dir" in src, "status_agent must read audio.output_dir from config.json"
    assert 'json["audio"]' in src, "reader must descend into the config 'audio' block"


def test_status_agent_recent_recordings_uses_config_dir():
    src = _swift_source()
    # loadRecentRecordings must source its base from loadRecordingDir(), not a
    # hardcoded home/Movies path.
    assert "let base = loadRecordingDir()" in src, (
        "loadRecentRecordings must derive its base from loadRecordingDir()"
    )


def test_status_agent_scans_single_root_no_voicemails_subdir():
    src = _swift_source()
    # The historical second directory (~/Movies/Yulu/voicemails) is gone:
    # recordings now live only in the root, so the agent must not reconstruct
    # a voicemails/ subdir path.
    assert "voicemails" not in src, (
        "status_agent still references a voicemails/ subdir; recordings now "
        "live in a single root directory"
    )


def test_status_agent_movies_yulu_only_as_fallback():
    src = _swift_source()
    # The historical ~/Movies/Yulu literal is permitted, but ONLY inside
    # loadRecordingDir() as the fallback default — never as a live source.
    assert "\\(home)/Movies/Yulu" not in src, (
        "status_agent still hardcodes \\(home)/Movies/Yulu as a recordings source"
    )
    reader_start = src.index("func loadRecordingDir()")
    reader_body = src[reader_start : reader_start + 600]
    assert "Movies/Yulu" in reader_body, (
        "the ~/Movies/Yulu fallback default must live inside loadRecordingDir()"
    )


def test_status_agent_has_hotkeys_no_voicemail():
    src = _swift_source()
    assert "import Carbon" in src
    assert "HotkeyRegistrar" in src
    assert "RegisterEventHotKey" in src
    assert "GetEventParameter" in src
    assert "kEventParamDirectObject" in src
    assert "hotKeyID.id == me.id" in src
    assert "eventNotHandledErr" in src
    assert "readHotkeysFromConfig" in src
    assert "launchDictateTranslateToggle" in src
    # The launcher now starts a meeting via meeting_daemon.py, not voicemail.cli.
    assert "voicemail" not in src.lower(), "no voicemail references should remain"
    assert "RecordingLauncher" in src, "launcher should be renamed RecordingLauncher"
    assert "meeting_daemon.py" in src, "launcher should shell out to meeting_daemon.py"


def test_status_agent_uses_supported_python_and_daemon_confirmed_meeting_state():
    src = _swift_source()
    assert "func yuluPythonProcess(scriptDir: String)" in src
    assert '"/opt/homebrew/bin/python3"' in src
    assert 'task.executableURL = URL(fileURLWithPath: "/usr/bin/env")' not in src

    toggle_start = src.index("@objc func onMenuToggle()")
    start_recording = src.index("private func startRecordingFromMenu()")
    toggle_body = src[toggle_start:start_recording]
    assert "_ = RecordingLauncher.launchStop()" in toggle_body
    assert "launcherPids.append(pid)" not in toggle_body

    dictate_start = src.index("@objc func onDictateToggle()")
    start_body = src[start_recording:dictate_start]
    assert "RecordingLauncher.launchStart(title: title)" in start_body
    assert "applyState(.recording)" not in start_body


def test_recorder_status_uses_supported_python():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    assert '"/opt/homebrew/bin/python3"' in src
    assert 'process.executableURL = URL(fileURLWithPath: "/usr/bin/env")' not in src


def test_recorder_status_renders_streaming_partials_without_restarting_fade():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    handler_start = src.index("func handleWebSocketFrame")
    handler_end = src.index("func sourceLanguageTitle", handler_start)
    handler = src[handler_start:handler_end]
    assert 'payload["partialText"]' in handler
    assert "liveCaptionSourceText" in handler
    assert "liveCaptionTranslationText" in handler
    assert "renderCaptions(animated: false)" in handler


def test_recorder_status_preserves_each_display_mode_during_streaming_updates():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    live_start = src.index("func liveCaptionSourceText")
    live_end = src.index("func captionSpeechCharacterCount", live_start)
    live = src[live_start:live_end]
    render_start = src.index("func renderCaptions")
    render_end = src.index("func setCaption", render_start)
    render = src[render_start:render_end]

    assert 'return stableText + "\\n" + partialText' not in live
    assert 'status == "disabled"' in live
    assert 'incomingText.isEmpty ? current : incomingText' in live
    assert '"翻译暂不可用 · \\(sourceText)"' not in render


def test_recorder_status_updates_streaming_captions_without_typewriter_delay():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    handler_start = src.index("func handleWebSocketFrame")
    handler_end = src.index("func sourceLanguageTitle", handler_start)
    handler = src[handler_start:handler_end]

    assert "setSourceCaption(source)" in handler
    assert "func nextCaptionRevealText" not in src
    assert "captionRevealTarget" not in src
    assert "captionRevealTimer" not in src


def test_recorder_status_wraps_long_captions_and_keeps_the_latest_tail():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    label_start = src.index("final class OutlinedCaptionLabel")
    label_end = src.index("final class AppDel", label_start)
    caption_start = src.index("func captionString")
    caption_end = src.index("@objc func targetLanguageChanged", caption_start)

    assert ".byWordWrapping" in src[label_start:label_end]
    assert ".byTruncatingTail" not in src[label_start:label_end]
    assert "func visibleCaptionText" in src
    assert "semanticBreaks" in src
    assert "characters.suffix" in src
    assert ".byWordWrapping" in src[caption_start:caption_end]


def test_recorder_status_bounds_live_caption_before_appkit_layout():
    src = (SCRIPTS / "recorder_status.swift").read_text(encoding="utf-8")
    visible_start = src.index("func visibleCaptionText")
    visible_end = src.index("func captionString", visible_start)
    visible = src[visible_start:visible_end]
    live_start = src.index("func liveCaptionSourceText")
    live_end = src.index("func captionSpeechCharacterCount", live_start)
    live = src[live_start:live_end]

    assert "let trimmed = boundedCaptionText(text, maxCharacters: captionLayoutCharacterLimit)" in visible
    assert visible.index("boundedCaptionText") < visible.index("boundingRect")
    assert "boundedCaptionText(stable, maxCharacters: stableCaptionCharacterLimit)" in live
    assert "boundedCaptionText(partial, maxCharacters: partialCaptionCharacterLimit)" in live


def test_status_agent_has_dictation_menu_entry():
    src = _swift_source()
    assert '"Start Dictation"' in src
    assert '"Stop Dictation"' in src
    assert "launchDictateToggle" in src
    assert "launchWarmDictation" in src
    assert '"dictate.py", "warm"' in src
    assert "--translate-to" in src
    assert 'launchWarmDictation(targetLanguage: dictationTargetLanguage(fallback: "English"))' in src
    assert '"dictate.py", "toggle"' in src
    assert "dictationTargetLanguage(fallback:" in src
    assert '"dictate_toggle"' in src
    assert '"dictate_translate"' in src
    assert "dictateToggleResponse" in src
    assert "dictateTranslateResponse" in src
    assert "--target-bundle-id" in src
    assert "currentInputTargetApplication()" in src
    assert "isUsableInputTarget" in src
    assert "com.apple.loginwindow" in src
    assert "NSWorkspace.shared.frontmostApplication" in src
    assert "NSWorkspace.shared.runningApplications.first" in src
    assert "launchd agents can report loginwindow as frontmost" in src
    assert ".nonactivatingPanel" in src
    assert "capturePasteTarget(for: target)" in src
    assert "capturedPasteTarget = pasteTarget" in src
    assert '"--deadline-sec", "6"' not in src
    assert '"--timeout-sec", "6"' not in src
    assert 'file.hasPrefix("\\(CONFIG_DIR)/dictation/")' in src
    assert "dictation recording active; ignoring meeting stop" in src


def test_status_agent_has_agent_console_entry():
    src = _swift_source()
    assert '"Open Agent Console"' in src
    assert '"open_agent_console"' in src
    assert "onOpenAgentConsole" in src
    assert "http://127.0.0.1:7777/agent-console" in src


def test_status_agent_has_voice_chat_entry():
    src = _swift_source()
    assert '"Ask Agent by Voice"' in src
    assert '"voice_chat"' in src
    assert '"open_voice_chat"' in src
    assert "WKWebView" in src
    assert "http://127.0.0.1:7777/voice-chat" in src
    assert "launchVoiceChatToggle" in src
    assert '"dictate.py", "ask-toggle"' in src
    assert "voiceChatResponse" in src
    assert "openVoiceChatResponse" in src
    assert "voiceChatWindowStatus" in src
    assert '"voice_chat_window_visible"' in src
    assert '"Stop Voice Chat"' in src
    assert "voice chat recording active; ignoring dictation" in src
    assert "voice chat recording active; ignoring translate dictation" in src


def test_status_agent_has_paste_clipboard_ipc():
    src = _swift_source()
    assert '"paste_clipboard"' in src
    assert "pasteClipboardResponse" in src
    assert "pasteClipboard(text:" in src
    assert "insertTextWithAccessibility" in src
    assert "runningTextTarget" in src
    assert "NSWorkspace.OpenConfiguration" in src
    assert "activateIgnoringOtherApps" in src
    assert "config.activates = true" in src
    assert "isFrontTextTarget" in src
    assert "waitForFrontTextTarget" in src
    assert "Thread.sleep(forTimeInterval: 0.05)" in src
    assert '"error": "target_not_front"' in src
    assert '"error": "paste_timeout"' in src
    assert '"front_app_name": NSWorkspace.shared.frontmostApplication?.localizedName ?? ""' in src
    assert "findWritableTextElement" in src
    assert "isWritableTextElement" in src
    assert "setAXTimeout" in src
    assert "AXUIElementSetMessagingTimeout" in src
    assert "depth: 3, budget: 16" in src
    assert "kAXFocusedWindowAttribute" in src
    assert "kAXMainWindowAttribute" in src
    assert "AXUIElementCreateApplication" in src
    assert "focusedSource = \"target\"" in src
    assert '"focused_value_unavailable:' in src
    assert "NSPasteboard.general.setString(text, forType: .string)" in src
    assert "\\(focusedSource)_\\(direct.1)" in src
    assert "accessibility_not_trusted" in src
    assert "accessibility_error" in src
    assert '"method": "accessibility"' in src
    assert 'return "keystroke"' in src
    assert "AXUIElementCreateSystemWide" in src
    assert "kAXSelectedTextRangeAttribute" in src
    assert "AXUIElementSetAttributeValue" in src
    assert "sendPasteKeystroke" in src
    assert "CGEvent(keyboardEventSource:" in src
    assert "postToPid(target.processIdentifier)" in src
    assert '"target_keystroke"' in src
    assert ".maskCommand" in src
    assert ".cghidEventTap" in src
    assert '"verified": false' in src
    assert "CapturedPasteTarget" in src
    assert "capturedPasteTargetMatches" in src
    assert '"method": "captured_accessibility"' in src
    assert "shouldAvoidAccessibilityInsert" in src
    assert "com.openai.codex" in src


def test_status_agent_processing_allows_next_recording():
    src = _swift_source()
    assert "Start Recording (transcribing previous)" in src
    assert "new == .idle || (new == .recording && !activeRecordingIsDictation) || new == .processing" in src
    assert "case .processing:" in src
    assert "startRecordingFromMenu()" in src
    assert "starting next recording while previous processing continues" in src
    assert "waitpid(pid, &status, WNOHANG)" in src
