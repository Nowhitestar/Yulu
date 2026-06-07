"""PORT-03 (Phase 15) — the ``transcription.diarization.*`` config schema + reader contract.

config.example.json is the authoritative schema reference (PROJECT.md / CLAUDE.md). v0.6 adds a
documented ``transcription.diarization`` block. These tests lock:

  * the block exists with the documented keys + safe DEFAULT-OFF value (a fresh install / an
    upgrader who never opts in pulls nothing extra and gets today's plain transcript);
  * the inline ``note`` documents it (the repo's config convention — nested "note" strings);
  * provider defaults to the chosen engine (sherpa-onnx);
  * the runtime readers agree with the schema: ``diarize_pipeline.diarization_enabled`` is False for
    the example block (off by default) and the backend ``resolve_model_paths`` honors ``seg_model``/
    ``emb_model`` overrides (and falls back to the managed dir when they are "").

CI-safe: pure JSON + pure-path readers; no sherpa, no models, no network.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

CONFIG_EXAMPLE = SCRIPTS / "config.example.json"


def _example() -> dict:
    return json.loads(CONFIG_EXAMPLE.read_text(encoding="utf-8"))


def _diar() -> dict:
    return _example()["transcription"]["diarization"]


def test_config_example_is_valid_json():
    assert isinstance(_example(), dict)


def test_diarization_block_present_with_documented_keys():
    diar = _diar()
    for key in ("enabled", "provider", "seg_model", "emb_model", "num_speakers", "threshold", "note"):
        assert key in diar, f"diarization.{key} missing from config.example.json"


def test_diarization_defaults_off():
    """Default-OFF is the migration-safety contract: an upgrader who never opts in is unaffected."""
    assert _diar()["enabled"] is False


def test_diarization_provider_default_is_sherpa_onnx():
    assert _diar()["provider"] == "sherpa-onnx"


def test_diarization_default_threshold_and_num_speakers():
    diar = _diar()
    assert diar["num_speakers"] is None          # auto-cluster by default (calendar prior when present)
    assert isinstance(diar["threshold"], (int, float))
    assert diar["threshold"] == 0.5              # EN-calibrated default (Phase 12)


def test_diarization_model_paths_blank_by_default():
    """Blank model paths → the managed ~/.config/yulu/models/diarization/ files are used."""
    diar = _diar()
    assert diar["seg_model"] == ""
    assert diar["emb_model"] == ""


def test_diarization_has_inline_note_documentation():
    """The repo config convention: a nested 'note' string documents the block."""
    note = _diar()["note"]
    assert isinstance(note, str) and len(note) > 40
    # The note must convey the load-bearing facts a user needs.
    assert "sherpa-onnx" in note
    assert "default" in note.lower()


def test_pipeline_reader_agrees_block_is_disabled():
    """The runtime gate (diarize_pipeline.diarization_enabled) reads the example block as OFF."""
    from stt_daemon import diarize_pipeline as dp

    assert dp.diarization_enabled(_example()["transcription"]) is False
    # And ON once enabled, proving the reader keys off exactly this block.
    trans = _example()["transcription"]
    trans["diarization"]["enabled"] = True
    assert dp.diarization_enabled(trans) is True


def test_backend_resolve_model_paths_honors_overrides_else_managed_dir(tmp_path):
    """The backend's path resolution matches the schema: explicit seg/emb override; "" → managed."""
    from stt_daemon.backends import diarize as diar_backend

    # "" (the example default) → managed diarization dir filenames.
    seg, emb = diar_backend.resolve_model_paths(seg_path=None, emb_path=None)
    assert seg.name == diar_backend.SEG_MODEL_FILENAME
    assert emb.name == diar_backend.EMB_MODEL_FILENAME
    assert seg.parent.name == diar_backend.DIARIZATION_SUBDIR

    # explicit override wins.
    custom_seg = tmp_path / "my_seg.onnx"
    custom_emb = tmp_path / "my_emb.onnx"
    seg2, emb2 = diar_backend.resolve_model_paths(
        seg_path=str(custom_seg), emb_path=str(custom_emb))
    assert seg2 == custom_seg and emb2 == custom_emb
