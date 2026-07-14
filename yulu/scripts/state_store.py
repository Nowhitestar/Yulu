#!/usr/bin/env python3
"""Shared recording state helpers for Yulu scripts.

The on-disk state file is intentionally small JSON, but several processes read
and write it. Keep normalization here so old states and the current schema both
work during upgrades.
"""

from __future__ import annotations

import json
import os
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

CONFIG_DIR = Path.home() / ".config" / "yulu"
STATE_PATH = CONFIG_DIR / ".state.json"
STATE_VERSION = 2


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def normalize_state(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        raw = {}

    # Legacy meeting_daemon shape:
    # {"recording": {"title": ..., "audio_path": ..., "start_time": ...}}
    rec = raw.get("recording")
    if isinstance(rec, dict):
        active = bool(rec)
        file_path = rec.get("audio_path") or rec.get("file_path") or raw.get("file_path", "")
        title = rec.get("title") or raw.get("title", "")
        meeting_id = rec.get("meeting_id") or raw.get("meeting_id", "")
        started_at = rec.get("start_time") or rec.get("started_at") or raw.get("started_at", "")
        backend = rec.get("backend") or raw.get("backend", "daemon")
    else:
        active = bool(rec)
        file_path = raw.get("file_path") or raw.get("audio_path") or ""
        title = raw.get("title", "")
        meeting_id = raw.get("meeting_id", "")
        started_at = raw.get("started_at") or raw.get("start_time") or ""
        backend = raw.get("backend", "daemon")

    state = dict(raw)
    state.update(
        {
            "version": STATE_VERSION,
            "recording": active,
            "status": raw.get("status") or ("recording" if active else "idle"),
            "title": title if active else raw.get("title", ""),
            "meeting_id": meeting_id if active else raw.get("meeting_id", ""),
            "file_path": file_path if active else raw.get("file_path", ""),
            "audio_path": file_path if active else raw.get("audio_path", raw.get("file_path", "")),
            "started_at": started_at if active else raw.get("started_at", ""),
            "backend": backend,
            "updated_at": raw.get("updated_at", _now()),
        }
    )
    return state


def load_state(path: Path = STATE_PATH) -> dict[str, Any]:
    if not path.exists():
        return normalize_state({})
    try:
        return normalize_state(json.loads(path.read_text(encoding="utf-8")))
    except Exception:
        return normalize_state({})


def save_state(state: dict[str, Any], path: Path = STATE_PATH) -> dict[str, Any]:
    state = normalize_state(state)
    state["updated_at"] = _now()
    _atomic_write_json(path, state)
    return state


def set_recording_started(
    title: str,
    file_path: str,
    *,
    meeting_id: str = "",
    backend: str = "daemon",
    path: Path = STATE_PATH,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    state: dict[str, Any] = {
        "version": STATE_VERSION,
        "recording": True,
        "status": "recording",
        "title": title,
        "meeting_id": meeting_id,
        "file_path": file_path,
        "audio_path": file_path,
        "started_at": _now(),
        "backend": backend,
    }
    if extra:
        state.update(extra)
    return save_state(state, path)


def set_recording_stopped(
    *,
    status: str = "idle",
    path: Path = STATE_PATH,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    previous = load_state(path)
    state = {
        **previous,
        "recording": False,
        "status": status,
        "title": "",
        "meeting_id": "",
        "file_path": "",
        "audio_path": "",
        "backend": previous.get("backend", "daemon"),
    }
    if extra:
        state.update(extra)
    return save_state(state, path)


def recording_info(state: dict[str, Any] | None = None) -> dict[str, Any]:
    state = normalize_state(state or load_state())
    if not state.get("recording"):
        return {}
    return {
        "title": state.get("title", ""),
        "meeting_id": state.get("meeting_id", ""),
        "audio_path": state.get("audio_path") or state.get("file_path", ""),
        "file_path": state.get("file_path") or state.get("audio_path", ""),
        "started_at": state.get("started_at", ""),
        "backend": state.get("backend", "daemon"),
        "transcription_language": state.get("transcription_language", "zh"),
    }


def is_recording_active(state: dict[str, Any] | None = None) -> bool:
    return bool(normalize_state(state or load_state()).get("recording"))
