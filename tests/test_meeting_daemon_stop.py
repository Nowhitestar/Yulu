import json
import stat
import sys
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.error import HTTPError, URLError

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))


class _Response:
    def __init__(self, status=202):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, _exc_type, _exc, _tb):
        return False

    def read(self):
        return b'{"ok":true}'

    def getcode(self):
        return self.status


def _prepare_stop(monkeypatch, tmp_path, *, returncode=0, final_path=None):
    import meeting_daemon

    wav = tmp_path / "TeamSync_20260102_090000.wav"
    wav.write_bytes(b"RIFFxxxxWAVE")
    final_path = wav if final_path is None else final_path
    calls = []

    monkeypatch.setattr(meeting_daemon, "_kill_status_window", lambda: None)
    monkeypatch.setattr(meeting_daemon, "_active_recording_info", lambda: {
        "title": "Team Sync",
        "audio_path": str(wav),
        "file_path": str(wav),
        "backend": "daemon",
        "transcription_language": "zh",
    })
    monkeypatch.setattr(meeting_daemon, "set_recording_stopped", lambda **_kw: {})
    monkeypatch.setattr(meeting_daemon, "load_schedule", lambda: {"events": [], "meetings": []})
    monkeypatch.setattr(meeting_daemon, "save_schedule", lambda _data: None)
    monkeypatch.setattr(meeting_daemon.subprocess, "Popen", lambda *_a, **_kw: SimpleNamespace())

    def fake_run(args, capture_output=False, text=False):
        calls.append(args)
        stdout = f"FINAL_RECORDING_PATH={final_path}\n" if final_path else ""
        return SimpleNamespace(returncode=returncode, stdout=stdout, stderr="stop failed" if returncode else "")

    monkeypatch.setattr(meeting_daemon.subprocess, "run", fake_run)
    monkeypatch.setattr(meeting_daemon, "MCP_TOKEN_PATH", tmp_path / "mcp-token.json")
    monkeypatch.setattr(meeting_daemon, "RECORDING_EVENTS_DIR", tmp_path / "recording-events")
    monkeypatch.setattr(meeting_daemon, "CONFIG_PATH", tmp_path / "config.json")
    return meeting_daemon, wav, calls


def test_stop_posts_completion_to_host_and_never_runs_legacy_pipeline(monkeypatch, tmp_path):
    meeting_daemon, wav, calls = _prepare_stop(monkeypatch, tmp_path)
    meeting_daemon.MCP_TOKEN_PATH.write_text(json.dumps({"token": "secret"}), encoding="utf-8")
    meeting_daemon.CONFIG_PATH.write_text(
        json.dumps({"agent_pipeline": {"auto_send_notion": True}}),
        encoding="utf-8",
    )
    monkeypatch.setenv("YULU_UI_PORT", "8123")
    seen = {}

    def fake_urlopen(request, timeout):
        seen.update({
            "url": request.full_url,
            "authorization": request.get_header("Authorization"),
            "content_type": request.get_header("Content-type"),
            "payload": json.loads(request.data.decode("utf-8")),
            "timeout": timeout,
        })
        return _Response()

    monkeypatch.setattr(meeting_daemon, "urlopen", fake_urlopen)

    meeting_daemon._stop_and_process()

    assert [Path(args[1]).name for args in calls] == ["record_audio.py"]
    assert calls[0][2] == "stop"
    assert seen == {
        "url": "http://127.0.0.1:8123/api/recordings/completed",
        "authorization": "Bearer secret",
        "content_type": "application/json",
        "payload": {
            "audioPath": str(wav.resolve()),
            "title": "Team Sync",
            "language": "zh",
        },
        "timeout": 5.0,
    }
    assert not meeting_daemon.RECORDING_EVENTS_DIR.exists()


def test_stop_spools_completion_atomically_when_host_is_unavailable(monkeypatch, tmp_path):
    meeting_daemon, wav, calls = _prepare_stop(monkeypatch, tmp_path)
    meeting_daemon.MCP_TOKEN_PATH.write_text(json.dumps({"token": "secret"}), encoding="utf-8")
    meeting_daemon.CONFIG_PATH.write_text(
        json.dumps({"agent_pipeline": {"auto_send_notion": True}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        meeting_daemon,
        "urlopen",
        lambda *_a, **_kw: (_ for _ in ()).throw(URLError("host unavailable")),
    )

    meeting_daemon._stop_and_process()

    assert [Path(args[1]).name for args in calls] == ["record_audio.py"]
    events = list(meeting_daemon.RECORDING_EVENTS_DIR.glob("*.json"))
    assert len(events) == 1
    assert json.loads(events[0].read_text(encoding="utf-8")) == {
        "audioPath": str(wav.resolve()),
        "title": "Team Sync",
        "language": "zh",
    }
    assert not list(meeting_daemon.RECORDING_EVENTS_DIR.glob("*.tmp"))
    assert not list(meeting_daemon.RECORDING_EVENTS_DIR.glob(".*.tmp"))
    assert stat.S_IMODE(meeting_daemon.RECORDING_EVENTS_DIR.stat().st_mode) == 0o700
    assert stat.S_IMODE(events[0].stat().st_mode) == 0o600


def test_policy_disabled_completion_is_permanently_acknowledged_without_spooling(monkeypatch, tmp_path):
    meeting_daemon, wav, _calls = _prepare_stop(monkeypatch, tmp_path)
    meeting_daemon.MCP_TOKEN_PATH.write_text(json.dumps({"token": "secret"}), encoding="utf-8")
    meeting_daemon.CONFIG_PATH.write_text(
        json.dumps({"agent_pipeline": {"enabled": True, "auto_process_recordings": True}}),
        encoding="utf-8",
    )
    body = BytesIO(json.dumps({
        "ok": False,
        "error": "recording_pipeline_policy_disabled",
        "permanent": True,
    }).encode("utf-8"))
    monkeypatch.setattr(
        meeting_daemon,
        "urlopen",
        lambda request, timeout: (_ for _ in ()).throw(
            HTTPError(request.full_url, 409, "Conflict", {}, body)
        ),
    )

    assert meeting_daemon._dispatch_recording_completed(str(wav), "Team Sync") is None
    assert not meeting_daemon.RECORDING_EVENTS_DIR.exists()


def test_capture_edge_keeps_recording_without_dispatch_when_auto_processing_is_disabled(monkeypatch, tmp_path):
    meeting_daemon, wav, _calls = _prepare_stop(monkeypatch, tmp_path)
    meeting_daemon.CONFIG_PATH.write_text(
        json.dumps({"agent_pipeline": {"enabled": True, "auto_process_recordings": False}}),
        encoding="utf-8",
    )
    monkeypatch.setattr(
        meeting_daemon,
        "urlopen",
        lambda *_a, **_kw: (_ for _ in ()).throw(AssertionError("must not post")),
    )

    assert meeting_daemon._dispatch_recording_completed(str(wav), "Team Sync") is None
    assert wav.exists()
    assert not meeting_daemon.RECORDING_EVENTS_DIR.exists()


def test_recording_completion_never_carries_legacy_automatic_share_intent(monkeypatch, tmp_path):
    import meeting_daemon

    cfg = tmp_path / "config.json"
    monkeypatch.setattr(meeting_daemon, "CONFIG_PATH", cfg)
    cfg.write_text(json.dumps({
        "agent_pipeline": {"auto_send_notion": False},
    }), encoding="utf-8")
    assert "sendToNotion" not in meeting_daemon._recording_completed_payload("/tmp/a.wav", "A")
    assert meeting_daemon._recording_completed_payload("/tmp/a.wav", "A")["language"] == "zh"

    cfg.write_text(json.dumps({"agent_pipeline": {"auto_send_notion": True}}), encoding="utf-8")
    assert "sendToNotion" not in meeting_daemon._recording_completed_payload("/tmp/a.wav", "A")

    cfg.write_text("{}", encoding="utf-8")
    assert "sendToNotion" not in meeting_daemon._recording_completed_payload("/tmp/a.wav", "A")


def test_realtime_request_freezes_configured_language_and_uses_bearer_token(monkeypatch, tmp_path):
    import meeting_daemon

    token_path = tmp_path / "mcp-token.json"
    config_path = tmp_path / "config.json"
    token_path.write_text(json.dumps({"token": "secret"}), encoding="utf-8")
    config_path.write_text(json.dumps({"transcription": {"language": "ja"}}), encoding="utf-8")
    monkeypatch.setattr(meeting_daemon, "MCP_TOKEN_PATH", token_path)
    monkeypatch.setattr(meeting_daemon, "CONFIG_PATH", config_path)
    monkeypatch.setenv("YULU_UI_PORT", "8123")
    seen = {}

    def fake_urlopen(request, timeout):
        seen.update({
            "url": request.full_url,
            "authorization": request.get_header("Authorization"),
            "payload": json.loads(request.data.decode("utf-8")),
            "timeout": timeout,
        })
        return _Response(status=200)

    monkeypatch.setattr(meeting_daemon, "urlopen", fake_urlopen)

    language = meeting_daemon._transcription_language()
    assert meeting_daemon._post_realtime("start", {
        "audioPath": "/tmp/meeting.wav",
        "title": "日本語会議",
        "language": language,
    }) is True
    assert seen == {
        "url": "http://127.0.0.1:8123/api/recordings/realtime/start",
        "authorization": "Bearer secret",
        "payload": {
            "audioPath": "/tmp/meeting.wav",
            "title": "日本語会議",
            "language": "ja",
        },
        "timeout": 30.0,
    }


def test_stop_failure_or_missing_file_does_not_dispatch(monkeypatch, tmp_path):
    meeting_daemon, _wav, calls = _prepare_stop(monkeypatch, tmp_path, returncode=2)
    monkeypatch.setattr(
        meeting_daemon,
        "_dispatch_recording_completed",
        lambda *_a: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )
    assert meeting_daemon._stop_and_process() is False
    assert [Path(args[1]).name for args in calls] == ["record_audio.py"]

    missing = tmp_path / "missing.wav"
    meeting_daemon, _wav, calls = _prepare_stop(monkeypatch, tmp_path, final_path=missing)
    monkeypatch.setattr(
        meeting_daemon,
        "_dispatch_recording_completed",
        lambda *_a: (_ for _ in ()).throw(AssertionError("must not dispatch")),
    )
    assert meeting_daemon._stop_and_process() is False
    assert [Path(args[1]).name for args in calls] == ["record_audio.py"]


def test_stop_keeps_window_until_state_confirmation(monkeypatch, tmp_path):
    meeting_daemon, _wav, _calls = _prepare_stop(monkeypatch, tmp_path)
    killed = []
    monkeypatch.setattr(meeting_daemon, "_kill_status_window", lambda: killed.append(True))

    assert meeting_daemon._stop_and_process() is True
    assert killed == []


def test_stop_notification_receives_stop_reason(monkeypatch, tmp_path):
    meeting_daemon, _wav, _calls = _prepare_stop(monkeypatch, tmp_path)
    notifications = []
    monkeypatch.setattr(
        meeting_daemon.subprocess,
        "Popen",
        lambda args, **_kwargs: notifications.append(args) or SimpleNamespace(),
    )

    assert meeting_daemon._stop_and_process() is True
    assert notifications[0][-1] == "manual"

    notifications.clear()
    assert meeting_daemon._stop_and_process(stop_reason="automatic") is True
    assert notifications[0][-1] == "automatic"


def test_auto_stop_distinguishes_user_choice_from_timeout(monkeypatch):
    import meeting_daemon

    choices = iter(["停止录制", "timeout"])
    reasons = []
    monkeypatch.setattr(meeting_daemon, "load_state", lambda: {})
    monkeypatch.setattr(
        meeting_daemon,
        "recording_info",
        lambda _state: {"title": "Team Sync", "meeting_id": "meeting-1"},
    )
    monkeypatch.setattr(
        meeting_daemon.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout=next(choices)),
    )
    monkeypatch.setattr(
        meeting_daemon,
        "_stop_and_process",
        lambda stop_reason="manual": reasons.append(stop_reason) or True,
    )

    meeting_daemon.cmd_auto_stop()
    meeting_daemon.cmd_auto_stop()

    assert reasons == ["manual", "automatic"]


def test_auto_stop_continue_schedules_the_next_prompt(monkeypatch):
    import meeting_daemon

    events = []
    monkeypatch.setattr(meeting_daemon, "load_state", lambda: {})
    monkeypatch.setattr(
        meeting_daemon,
        "recording_info",
        lambda _state: {"title": "Team Sync", "meeting_id": "meeting-1"},
    )
    monkeypatch.setattr(
        meeting_daemon.subprocess,
        "run",
        lambda *_args, **_kwargs: SimpleNamespace(stdout="继续录制"),
    )
    monkeypatch.setattr(meeting_daemon, "_add_runtime_event", events.append)
    monkeypatch.setattr(
        meeting_daemon,
        "_stop_and_process",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not stop")),
    )

    meeting_daemon.cmd_auto_stop()

    assert len(events) == 1
    assert events[0]["id"] == "recording-meeting-1::ask_stop_extended"
    assert events[0]["kind"] == "ask_stop"
    assert events[0]["meeting_id"] == "meeting-1"
    assert events[0]["title"] == "Team Sync"


def test_auto_stop_without_active_recording_is_a_noop(monkeypatch, capsys):
    import meeting_daemon

    monkeypatch.setattr(meeting_daemon, "load_state", lambda: {})
    monkeypatch.setattr(meeting_daemon, "recording_info", lambda _state: None)
    monkeypatch.setattr(
        meeting_daemon.subprocess,
        "run",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not show prompt")),
    )
    monkeypatch.setattr(
        meeting_daemon,
        "_stop_and_process",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("must not stop")),
    )

    meeting_daemon.cmd_auto_stop()

    assert "没有正在进行的录制" in capsys.readouterr().out


def test_status_window_detaches_from_parent_session(monkeypatch, tmp_path):
    import meeting_daemon

    script_dir = tmp_path / "scripts"
    config_dir = tmp_path / "config"
    script_dir.mkdir()
    config_dir.mkdir()
    status_bin = script_dir / "recorder_status"
    status_bin.write_text("binary", encoding="utf-8")
    state_path = config_dir / ".state.json"
    state_path.write_text('{"recording":true}', encoding="utf-8")
    seen = {}

    class _Process:
        pid = 12345

        def wait(self, timeout):
            raise meeting_daemon.subprocess.TimeoutExpired("recorder_status", timeout)

    def fake_popen(args, **kwargs):
        seen["args"] = args
        seen["kwargs"] = kwargs
        return _Process()

    monkeypatch.setattr(meeting_daemon, "SCRIPT_DIR", script_dir)
    monkeypatch.setattr(meeting_daemon, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(meeting_daemon, "STATE_PATH", state_path)
    monkeypatch.setattr(meeting_daemon, "_kill_status_window", lambda: None)
    monkeypatch.setattr(meeting_daemon.subprocess, "Popen", fake_popen)

    meeting_daemon._launch_status_window("Team Sync")

    assert seen["args"] == [str(status_bin), "Team Sync", str(state_path)]
    assert seen["kwargs"]["stdin"] is meeting_daemon.subprocess.DEVNULL
    assert seen["kwargs"]["start_new_session"] is True
    assert json.loads(state_path.read_text(encoding="utf-8"))["_status_pid"] == 12345


def test_start_recording_uses_capture_controller(monkeypatch):
    import meeting_daemon
    import record_audio

    class FakeCaptureController:
        def __init__(self):
            self.calls = []

        def status(self):
            self.calls.append(("status", None))
            return {"recording": False}

        def start(self, payload):
            self.calls.append(("start", payload))
            return {"status": "recording", "file": "/tmp/meeting.wav"}

    ctrl = FakeCaptureController()
    monkeypatch.setattr(record_audio, "_capture_controller", lambda: ctrl)
    monkeypatch.setattr(record_audio, "socket_send", lambda cmd: (_ for _ in ()).throw(AssertionError("socket_send bypassed seam")))

    assert meeting_daemon._daemon_start_recording("Team Sync") == "/tmp/meeting.wav"
    assert ctrl.calls == [
        ("status", None),
        ("start", {"title": "Team Sync"}),
    ]
