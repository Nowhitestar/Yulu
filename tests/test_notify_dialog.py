"""notify.py ask_record / _fallback_dialog: defaults must keep the prompt
on screen until the user clicks, and the default button must be 开始录制
(回车不再误触"忽略")."""

import subprocess
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import notify


def _capture_osascript_script(monkeypatch):
    """Patch subprocess.run so that notify._fallback_dialog produces an
    AppleScript we can inspect without actually showing a dialog."""
    captured = {}

    class FakeResult:
        stdout = "button returned:开始录制, gave up:false"
        stderr = ""

    def fake_run(cmd, *_args, **_kwargs):
        # cmd = ["osascript", "-e", "<script>"]
        captured["cmd"] = cmd
        captured["script"] = cmd[2] if len(cmd) >= 3 else ""
        return FakeResult()

    monkeypatch.setattr(subprocess, "run", fake_run)
    return captured


def test_ask_record_default_omits_giving_up(monkeypatch):
    captured = _capture_osascript_script(monkeypatch)
    result = notify.ask_record("Anthropic Sync")
    assert result == "开始录制"
    # No timeout → no "giving up after" suffix → dialog stays until clicked.
    assert "giving up after" not in captured["script"]


def test_ask_record_default_button_is_start_recording(monkeypatch):
    captured = _capture_osascript_script(monkeypatch)
    notify.ask_record("Anthropic Sync")
    # Default button is the one chosen on Enter. Must be 开始录制 now.
    assert 'default button "开始录制"' in captured["script"]


def test_ask_record_explicit_timeout_still_works(monkeypatch):
    captured = _capture_osascript_script(monkeypatch)
    notify.ask_record("Anthropic Sync", timeout=30)
    assert "giving up after 30" in captured["script"]


def test_fallback_dialog_parses_button_choice(monkeypatch):
    """Regression: stdout 'button returned:开始录制, gave up:false' must
    yield exactly '开始录制' after split/strip — the choice comparison in
    meeting_daemon depends on this string equality."""
    _capture_osascript_script(monkeypatch)
    choice = notify._fallback_dialog(
        "msg", buttons=["忽略", "开始录制"], default_button="开始录制",
    )
    assert choice == "开始录制"


def test_fallback_dialog_returns_timeout_on_gave_up(monkeypatch):
    captured = {}

    class FakeResult:
        stdout = "gave up:true"
        stderr = ""

    def fake_run(cmd, *_args, **_kwargs):
        captured["cmd"] = cmd
        return FakeResult()

    monkeypatch.setattr(subprocess, "run", fake_run)
    result = notify._fallback_dialog(
        "msg", buttons=["a", "b"], default_button="a", timeout=1,
    )
    assert result == "timeout"
