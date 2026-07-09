import sys
from pathlib import Path
from types import SimpleNamespace

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))


def test_stop_uses_daemon_status_when_state_is_idle(monkeypatch, tmp_path):
    import meeting_daemon
    import record_audio

    wav = tmp_path / "TeamSync_20260102_090000.wav"
    wav.write_bytes(b"RIFFxxxxWAVE")
    calls = []

    monkeypatch.setattr(meeting_daemon, "_kill_status_window", lambda: None)
    monkeypatch.setattr(meeting_daemon, "load_state", lambda: {"recording": False})
    def fake_socket_send(cmd):
        return {"recording": True, "file": str(wav)} if cmd.get("action") == "status" else None

    monkeypatch.setattr(record_audio, "socket_send", fake_socket_send)
    monkeypatch.setattr(meeting_daemon, "set_recording_stopped", lambda **_kw: {})
    monkeypatch.setattr(meeting_daemon, "load_schedule", lambda: {"events": [], "meetings": []})
    monkeypatch.setattr(meeting_daemon, "save_schedule", lambda _data: None)
    monkeypatch.setattr(meeting_daemon.subprocess, "Popen", lambda *_a, **_kw: SimpleNamespace())

    def fake_run(args, capture_output=False, text=False):
        calls.append(args)
        script = Path(args[1]).name if len(args) > 1 else ""
        if script == "record_audio.py":
            return SimpleNamespace(returncode=0, stdout=f"FINAL_RECORDING_PATH={wav}\n", stderr="")
        if script == "transcribe.py":
            return SimpleNamespace(returncode=0, stdout="Transcript saved: x\nSummary status: draft_agent_pending\n", stderr="")
        return SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(meeting_daemon.subprocess, "run", fake_run)

    meeting_daemon._stop_and_process()

    assert any(len(args) > 2 and Path(args[1]).name == "record_audio.py" and args[2] == "stop" for args in calls)


def test_post_recording_plan_summarizes_when_realtime_is_reusable(monkeypatch, tmp_path):
    import json
    import meeting_daemon

    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"transcription": {"post_recording_mode": "fast_summary"}}), encoding="utf-8")
    monkeypatch.setattr(meeting_daemon, "CONFIG_PATH", cfg)

    wav = tmp_path / "TeamSync_20260102_090000.wav"
    wav.write_bytes(b"RIFFxxxxWAVE")
    wav.with_suffix(".realtime.transcript.txt").write_text("live transcript", encoding="utf-8")

    plan = meeting_daemon._post_recording_plan(str(wav))

    assert plan["event"] == "summarizing"
    assert "复用实时转写" in plan["message"]


def test_post_recording_plan_transcribes_in_full_mode(monkeypatch, tmp_path):
    import json
    import meeting_daemon

    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps({"transcription": {"post_recording_mode": "full_transcribe"}}), encoding="utf-8")
    monkeypatch.setattr(meeting_daemon, "CONFIG_PATH", cfg)

    wav = tmp_path / "TeamSync_20260102_090000.wav"
    wav.write_bytes(b"RIFFxxxxWAVE")
    wav.with_suffix(".realtime.transcript.txt").write_text("live transcript", encoding="utf-8")

    assert meeting_daemon._post_recording_plan(str(wav))["event"] == "transcribing"


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
