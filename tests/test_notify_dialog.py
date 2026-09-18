"""Notification ownership and fail-safe capture prompts, without real user data."""
import json
import socket
import subprocess
import sys
import threading
from pathlib import Path
from types import SimpleNamespace

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))
import notify


def test_saved_event_contains_destination_and_no_unproven_processing_state(monkeypatch):
    calls = []
    monkeypatch.setattr(notify, "send_event", lambda *args: calls.append(args) or True)
    assert notify.notify_stop("Team Sync", "manual", "TeamSync_20260918")
    assert notify.notify_stop("Team Sync", "automatic", "TeamSync_20260918")
    assert calls == [("recording_saved", "TeamSync_20260918", "Team Sync", "TeamSync_20260918")] * 2


def test_notification_transport_uses_private_app_socket(monkeypatch):
    import tempfile
    with tempfile.TemporaryDirectory(prefix="yulu-notify-", dir="/private/tmp") as root:
        monkeypatch.setattr(notify, "IPC_DIR", Path(root))
        received = []
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
            server.bind(str(Path(root) / "status_agent.sock"))
            server.listen(1)
            server.settimeout(3)

            def accept():
                connection, _ = server.accept()
                with connection, connection.makefile("rb") as stream:
                    received.append(json.loads(stream.readline()))
                    connection.sendall(b'{"ok":true,"accepted":true}\n')

            thread = threading.Thread(target=accept)
            thread.start()
            assert notify.send_event("meeting_soon", "calendar-event:remind", '会议 "sync"\n标题')
            thread.join(timeout=3)
            assert not thread.is_alive()
        assert received == [{"action": "notify", "kind": "meeting_soon", "id": "calendar-event:remind", "title": '会议 "sync"\n标题'}]


def test_unavailable_app_never_falls_back_to_script_notifications(monkeypatch, tmp_path, capsys):
    monkeypatch.setattr(notify, "IPC_DIR", tmp_path)
    monkeypatch.setattr(notify.subprocess, "run", lambda *_a, **_k: pytest.fail("unexpected fallback"))
    assert notify.send_event("meeting_soon", "id", "Private title") is False
    assert "Private title" not in capsys.readouterr().err


@pytest.mark.parametrize("mode,choice,expected", [
    ("record", "record", "开始录制"), ("record", "ignore", "忽略"),
    ("stop", "stop", "停止录制"), ("stop", "continue", "继续录制"),
    ("stop", "timeout", "继续录制"), ("stop", "", "继续录制"),
])
def test_native_prompt_choices_are_explicit(monkeypatch, tmp_path, mode, choice, expected):
    monkeypatch.setenv("YULU_NATIVE_HELPER_DIR", str(tmp_path))
    calls = []
    def run(args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(returncode=0, stdout=json.dumps({"choice": choice}))
    monkeypatch.setattr(notify.subprocess, "run", run)
    ask = notify.ask_record if mode == "record" else notify.ask_stop
    assert ask("Team Sync") == expected
    assert calls[0][0] == [str(tmp_path / "meeting_prompt"), "Team Sync", "", "record", mode]
    assert calls[0][1]["timeout"] is None  # Persistent until an explicit choice.


@pytest.mark.parametrize("failure", [FileNotFoundError(), subprocess.TimeoutExpired("prompt", 1), ValueError()])
def test_missing_or_timed_out_prompt_never_starts_or_stops_capture(monkeypatch, failure):
    def run(*_a, **_k):
        raise failure
    monkeypatch.setattr(notify.subprocess, "run", run)
    assert notify.ask_record("Meeting", timeout=1) == "忽略"
    assert notify.ask_stop("Meeting", timeout=1) == "继续录制"
