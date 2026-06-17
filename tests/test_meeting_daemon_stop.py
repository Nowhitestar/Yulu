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
