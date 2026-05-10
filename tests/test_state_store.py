import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from state_store import is_recording_active, load_state, recording_info, set_recording_started, set_recording_stopped


def test_normalizes_legacy_nested_recording_state(tmp_path):
    state_path = tmp_path / ".state.json"
    state_path.write_text(json.dumps({
        "recording": {
            "title": "Legacy Meeting",
            "meeting_id": "abc",
            "audio_path": "/tmp/legacy.wav",
            "start_time": "2026-05-09T21:00:00",
        }
    }), encoding="utf-8")

    state = load_state(state_path)
    rec = recording_info(state)

    assert is_recording_active(state)
    assert state["recording"] is True
    assert rec["title"] == "Legacy Meeting"
    assert rec["audio_path"] == "/tmp/legacy.wav"
    assert rec["meeting_id"] == "abc"


def test_writes_flat_v2_recording_state(tmp_path):
    state_path = tmp_path / ".state.json"

    set_recording_started("New Meeting", "/tmp/new.wav", meeting_id="m1", path=state_path)
    state = load_state(state_path)

    assert state["version"] == 2
    assert state["recording"] is True
    assert state["file_path"] == "/tmp/new.wav"
    assert state["audio_path"] == "/tmp/new.wav"

    set_recording_stopped(path=state_path)
    stopped = load_state(state_path)

    assert stopped["recording"] is False
    assert stopped["status"] == "idle"
    assert recording_info(stopped) == {}
