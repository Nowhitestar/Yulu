import importlib
import json
import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))


def _load_record_audio(tmp_path, monkeypatch):
    import record_audio
    importlib.reload(record_audio)
    state_path = tmp_path / ".state.json"
    monkeypatch.setattr(record_audio, "STATE_PATH", state_path)
    monkeypatch.setattr(record_audio, "CONFIG_DIR", tmp_path)
    monkeypatch.setattr(record_audio, "REALTIME_PID_PATH", tmp_path / ".realtime.pid")
    return record_audio, state_path


def _write_wav(path: Path, sample: int, frames: int = 8) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(struct.pack("<hh", sample, sample) * frames)


def test_daemon_status_resumes_when_state_is_recording_but_daemon_is_idle(tmp_path, monkeypatch):
    record_audio, state_path = _load_record_audio(tmp_path, monkeypatch)
    old = tmp_path / "Meet_20260609_120000.wav"
    new = tmp_path / "Meet_20260609_120500.wav"
    _write_wav(old, 100)
    calls = []

    record_audio.set_recording_started(
        "Meet", str(old), backend="daemon", path=state_path,
        extra={"segments": [str(old)]},
    )

    def fake_socket_send(cmd):
        calls.append(cmd)
        if cmd["action"] == "status":
            return {"recording": False, "file": ""}
        if cmd["action"] == "start":
            _write_wav(new, 200)
            return {"status": "recording", "file": str(new)}
        raise AssertionError(cmd)

    monkeypatch.setattr(record_audio, "socket_send", fake_socket_send)
    monkeypatch.setattr(record_audio, "load_config", lambda: {"silence_duration_sec": 300, "silence_threshold": 0.01})
    monkeypatch.setattr(record_audio, "start_realtime_transcriber", lambda *a, **k: None)
    monkeypatch.setattr(record_audio, "stop_realtime_transcriber", lambda *a, **k: None)

    status = record_audio.daemon_status()

    assert status["recording"] is True
    state = json.loads(state_path.read_text())
    assert state["audio_path"] == str(new)
    assert state["segments"] == [str(old), str(new)]
    assert [c["action"] for c in calls] == ["status", "start"]


def test_daemon_stop_merges_resume_segments_back_to_first_wav(tmp_path, monkeypatch):
    record_audio, state_path = _load_record_audio(tmp_path, monkeypatch)
    first = tmp_path / "Meet_20260609_120000.wav"
    second = tmp_path / "Meet_20260609_120500.wav"
    _write_wav(first, 100, frames=4)
    _write_wav(second, 200, frames=6)
    record_audio.set_recording_started(
        "Meet", str(second), backend="daemon", path=state_path,
        extra={"segments": [str(first), str(second)]},
    )

    monkeypatch.setattr(record_audio, "socket_send", lambda cmd: {"status": "stopped", "file": str(second), "duration": 10})
    monkeypatch.setattr(record_audio, "stop_realtime_transcriber", lambda *a, **k: None)

    result = record_audio.daemon_stop()

    assert result["path"] == str(first)
    with wave.open(str(first), "rb") as w:
        assert w.getnframes() == 10
    assert not second.exists()
    archived = second.with_suffix(".part2.wav")
    assert archived.exists()
    assert result["segments"] == [str(first), str(archived)]
    state = json.loads(state_path.read_text())
    assert state["audio_path"] == str(first)
    assert state["segments"] == [str(first), str(archived)]
