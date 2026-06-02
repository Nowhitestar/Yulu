import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from configure import FULL_MODE, FAST_MODE, set_engine, set_mode
from transcribe import normalize_post_recording_mode, read_realtime_transcript


def write_config(path):
    path.write_text(json.dumps({"transcription": {"language": "zh"}}, ensure_ascii=False), encoding="utf-8")


def test_post_recording_mode_aliases():
    assert normalize_post_recording_mode("fast") == FAST_MODE
    assert normalize_post_recording_mode("realtime") == FAST_MODE
    assert normalize_post_recording_mode("full") == FULL_MODE
    assert normalize_post_recording_mode("quality") == FULL_MODE


def test_realtime_transcript_rejects_agent_event_json(tmp_path):
    transcript = tmp_path / "meeting.realtime.transcript.txt"
    transcript.write_text(
        json.dumps([
            {"type": "realtime_transcript_error", "title": "Weekly"},
            {"type": "realtime_transcript_ready", "title": "Weekly"},
        ], ensure_ascii=False),
        encoding="utf-8",
    )

    assert read_realtime_transcript(transcript) is None


def test_configure_sets_fast_and_full_modes(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_mode("full", path=cfg)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["transcription"]["post_recording_mode"] == FULL_MODE

    set_mode("fast", path=cfg)
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["transcription"]["post_recording_mode"] == FAST_MODE


def test_configure_sets_mlx_engine_for_final_and_realtime(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_engine("mlx", "mlx-community/whisper-large-v3-mlx", path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["final_engine"] == "mlx"
    assert trans["mlx"]["model"] == "mlx-community/whisper-large-v3-mlx"
    assert trans["mlx"]["final_model"] == "mlx-community/whisper-large-v3-mlx"
    assert trans["mlx"]["preprocess_audio"] is True
    assert trans["realtime"]["engine"] == "mlx"
    assert trans["realtime"]["mlx_model"] == "mlx-community/whisper-large-v3-mlx"


def test_configure_mlx_engine_does_not_resurrect_dead_python_marker(tmp_path):
    # v0.6.0 removed the dedicated venv; migrate/detect.py treats a lingering
    # transcription.mlx.python as a v0.5.x-stale signal. configure.py must NOT
    # write it back, or every install would look un-migrated on each upgrade.
    cfg = tmp_path / "config.json"
    write_config(cfg)

    set_engine("mlx", path=cfg)

    mlx = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]["mlx"]
    assert "python" not in mlx


def test_configure_sets_whisper_engine_command(tmp_path):
    cfg = tmp_path / "config.json"
    write_config(cfg)
    model = tmp_path / "ggml-large-v3.bin"

    set_engine("whisper", str(model), path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["final_engine"] == "whisper"
    assert trans["local_model_path"] == str(model)
    assert trans["realtime"]["engine"] == "whisper"
    assert "{{input}}" in trans["command"]
