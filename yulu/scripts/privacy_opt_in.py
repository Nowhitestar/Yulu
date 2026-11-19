"""Local-first privacy and external-service opt-in report."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Mapping


def load_config(path: Path) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def _dict(value: Any) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def privacy_opt_in_report(config: Mapping[str, Any] | None) -> dict[str, Any]:
    cfg = dict(config or {})
    agent_pipeline = _dict(cfg.get("agent_pipeline"))
    transcription = _dict(cfg.get("transcription"))
    transcription_engine = str(transcription.get("engine") or "local").strip().lower()
    if transcription_engine not in {"local", "xai"}:
        transcription_engine = "local"
    dictation = _dict(transcription.get("dictation"))
    # ADR-010: Yulu owns no conversation. Dictated text reaches xAI only through
    # this explicit switch, the xAI audio engine, and an accepted disclosure.
    dictation_text_provider = "xai" if dictation.get("text_provider") == "xai" else "none"
    # ADR-012: live notes send meeting text to xAI only through their own
    # switch and disclosure, with either audio engine. Retired caption
    # translation settings and the dictation switch never enable them.
    live_notes = _dict(transcription.get("live_notes"))
    live_notes_provider = "xai" if live_notes.get("provider") == "xai" else "none"
    pipeline_enabled = agent_pipeline.get("enabled") is not False

    return {
        "schema_version": 1,
        "ok": pipeline_enabled,
        "transcription": {
            "owner": "yulu",
            "provider": transcription_engine,
            "yulu_executor": True,
            "cloud_audio_opt_in": transcription_engine == "xai",
            "credential_source": "yulu-keychain" if transcription_engine == "xai" else None,
            "ok": True,
        },
        "dictation_text": {
            "owner": "yulu",
            "provider": dictation_text_provider,
            "yulu_executor": True,
            "cloud_text_opt_in": dictation_text_provider == "xai",
            "requires_xai_audio_engine": True,
            "ok": True,
        },
        "live_notes": {
            "owner": "yulu",
            "provider": live_notes_provider,
            "yulu_executor": True,
            "cloud_text_opt_in": live_notes_provider == "xai",
            "requires_xai_audio_engine": False,
            "ok": True,
        },
        "summary_delivery": {
            "owner": "hermes",
            "auto_channel": "file",
            "auto_external_opt_in": False,
            "external_opt_in_channels": [],
            "ok": True,
        },
    }
