"""record_audio.realtime_enabled(): the global realtime-transcription flag.

transcription.realtime_enabled is the canonical key (seeded true by setup.sh).
audio.realtime_transcribe is a deprecated legacy fallback, honored only when the
canonical key is absent. load_config() no longer injects the legacy key."""

import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import record_audio


def _write_cfg(tmp_path, monkeypatch, cfg):
    p = tmp_path / "config.json"
    p.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(record_audio, "CONFIG_PATH", p)
    return p


def test_realtime_enabled_defaults_true_when_unset(tmp_path, monkeypatch):
    _write_cfg(tmp_path, monkeypatch, {})
    assert record_audio.realtime_enabled() is True


def test_realtime_enabled_reads_new_key_true(tmp_path, monkeypatch):
    _write_cfg(tmp_path, monkeypatch, {"transcription": {"realtime_enabled": True}})
    assert record_audio.realtime_enabled() is True


def test_realtime_enabled_reads_new_key_false(tmp_path, monkeypatch):
    _write_cfg(tmp_path, monkeypatch, {"transcription": {"realtime_enabled": False}})
    assert record_audio.realtime_enabled() is False


def test_realtime_enabled_new_key_takes_priority_over_legacy(tmp_path, monkeypatch):
    _write_cfg(tmp_path, monkeypatch, {
        "transcription": {"realtime_enabled": False},
        "audio": {"realtime_transcribe": True},
    })
    assert record_audio.realtime_enabled() is False


def test_realtime_enabled_legacy_fallback_when_new_key_absent(tmp_path, monkeypatch):
    _write_cfg(tmp_path, monkeypatch, {"audio": {"realtime_transcribe": False}})
    assert record_audio.realtime_enabled() is False


def test_load_config_no_longer_injects_legacy_realtime_key(tmp_path, monkeypatch):
    """The vestigial audio.realtime_transcribe default was removed from
    load_config(); it must not reappear in the returned audio config."""
    _write_cfg(tmp_path, monkeypatch, {"audio": {"mic_device": ":0"}})
    audio_cfg = record_audio.load_config()
    assert "realtime_transcribe" not in audio_cfg
