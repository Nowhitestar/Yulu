#!/usr/bin/env python3
"""Shared agent queue helpers.

The queue remains a JSON file for transparency, but writes are locked and atomic
so multiple Yulu processes do not overwrite each other's events.
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
import uuid
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Iterator

CONFIG_DIR = Path.home() / ".config" / "yulu"
QUEUE_PATH = CONFIG_DIR / "agent-queue.json"
LOCK_PATH = CONFIG_DIR / ".agent-queue.lock"
PROCESSING_STALE_AFTER = timedelta(hours=2)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _read_queue(path: Path) -> list[dict[str, Any]]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return []
    if not isinstance(data, list):
        return []
    return [x for x in data if isinstance(x, dict)]


def _write_queue_atomic(path: Path, queue: list[dict[str, Any]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(queue, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


@contextlib.contextmanager
def locked_queue(path: Path = QUEUE_PATH, lock_path: Path = LOCK_PATH) -> Iterator[list[dict[str, Any]]]:
    path = Path(path)
    lock_path = Path(lock_path)
    if path != QUEUE_PATH and lock_path == LOCK_PATH:
        lock_path = path.parent / f".{path.name}.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    with lock_path.open("a+") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        queue = _read_queue(path)
        try:
            yield queue
            _write_queue_atomic(path, queue)
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)


def append_event(event_type: str, path: Path = QUEUE_PATH, **fields: Any) -> dict[str, Any]:
    entry = {
        "id": fields.pop("id", str(uuid.uuid4())),
        "type": event_type,
        "ts": fields.pop("ts", _now()),
        **fields,
    }
    with locked_queue(path=path) as queue:
        queue.append(entry)
    return entry


def _is_stale_processing(entry: dict[str, Any]) -> bool:
    if entry.get("status") != "processing":
        return False
    raw = entry.get("processing_at")
    if not raw:
        return True
    try:
        started = datetime.fromisoformat(str(raw).replace("Z", "+00:00")).replace(tzinfo=None)
    except Exception:
        return True
    return datetime.now() - started > PROCESSING_STALE_AFTER


def claim_summary_request(
    path: Path = QUEUE_PATH,
    worker_name: str = "yulu-agent-queue-worker",
) -> dict[str, Any] | None:
    with locked_queue(path=path) as queue:
        for entry in queue:
            if entry.get("type") != "summary_request":
                continue
            if entry.get("status") in {"done", "error"}:
                continue
            if entry.get("status") == "processing" and not _is_stale_processing(entry):
                continue
            entry.setdefault("id", str(uuid.uuid4()))
            entry["status"] = "processing"
            entry["processing_by"] = worker_name
            entry["processing_at"] = _now()
            entry.pop("error", None)
            return dict(entry)
    return None


def update_event(
    event_id: str,
    updates: dict[str, Any],
    path: Path = QUEUE_PATH,
    match: dict[str, Any] | None = None,
) -> bool:
    with locked_queue(path=path) as queue:
        for entry in queue:
            matched = entry.get("id") == event_id
            if not matched and match:
                matched = all(entry.get(k) == v for k, v in match.items())
            if matched:
                entry.update(updates)
                return True
    return False


def load_queue(path: Path = QUEUE_PATH) -> list[dict[str, Any]]:
    return _read_queue(Path(path))
