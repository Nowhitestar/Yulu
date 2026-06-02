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
    # Realtime/live captions run a FAST model independent of the (here: slow
    # large-v3) FINAL model, so the live tail keeps up with wall-clock audio.
    # Picking large-v3 for the final pass must NOT drag realtime down with it.
    assert trans["realtime"]["mlx_model"] == "mlx-community/whisper-large-v3-turbo"
    assert trans["realtime"]["chunk_sec"] == 15
    assert trans["realtime"]["chunk_max_sec"] == 30


def test_configure_respects_explicit_realtime_model_override(tmp_path):
    """If a user has already set a realtime model, set_engine must not stomp it."""
    cfg = tmp_path / "config.json"
    write_config(cfg)
    # Pre-seed an explicit realtime model.
    import json as _json
    data = _json.loads(cfg.read_text(encoding="utf-8"))
    data.setdefault("transcription", {}).setdefault("realtime", {})["mlx_model"] = \
        "mlx-community/whisper-small-mlx"
    cfg.write_text(_json.dumps(data), encoding="utf-8")

    set_engine("mlx", "mlx-community/whisper-large-v3-mlx", path=cfg)

    trans = json.loads(cfg.read_text(encoding="utf-8"))["transcription"]
    assert trans["realtime"]["mlx_model"] == "mlx-community/whisper-small-mlx"


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
