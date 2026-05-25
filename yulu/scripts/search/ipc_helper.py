"""Tiny stdin→stdout adapter used by status_agent.swift's IPC `search` action.

Swift speaks JSON over a Unix socket; it shells out to this helper to
avoid binding FTS5/SQLite into the Swift binary. Contract:

  - stdin: one JSON object matching the IPC `search` request schema
           (spec §7.1).
  - stdout: one JSON object matching the IPC `search` response schema.
  - exit 0 on success (including "no hits"); non-zero on protocol error.

Designed to be cheap to spawn — imports `search.reader` lazily so a
malformed request can fail fast without touching the database.
"""

from __future__ import annotations

import json
import sys
from datetime import timedelta
from typing import Any

_VALID_KIND_ALIASES = {
    "summary": ("meeting_summary", "voicemail_summary"),
    "transcript": ("meeting_transcript", "voicemail_transcript"),
    "meeting": ("meeting_summary", "meeting_transcript"),
    "voicemail": ("voicemail_summary", "voicemail_transcript"),
}


def _expand_kinds(req: dict) -> list[str] | None:
    """Resolve the effective `kinds` list from the request.

    Precedence:
      - `kinds`: literal list of canonical kinds (already validated by
        reader).
      - `in`:   shorthand like ["summary"] → both *_summary kinds.
      - else:  None, meaning all four kinds.
    """
    explicit = req.get("kinds")
    if isinstance(explicit, list) and explicit:
        return [str(k) for k in explicit]
    shorthand = req.get("in")
    if isinstance(shorthand, list) and shorthand:
        out: list[str] = []
        for s in shorthand:
            for k in _VALID_KIND_ALIASES.get(str(s), ()):
                if k not in out:
                    out.append(k)
        return out or None
    return None


def handle_request(req: dict) -> dict[str, Any]:
    """Translate one request dict into a response dict.

    No I/O assumptions — callable from tests without spawning a process."""
    from search.reader import search

    query = req.get("query")
    if not isinstance(query, str) or not query.strip():
        return {"ok": False, "error": "query is required (non-empty string)"}

    since = None
    if "since_days" in req and req["since_days"] is not None:
        try:
            n = int(req["since_days"])
            if n < 0:
                raise ValueError
            since = timedelta(days=n)
        except (ValueError, TypeError):
            return {"ok": False, "error": "since_days must be a non-negative integer"}

    try:
        kinds = _expand_kinds(req)
    except Exception as exc:
        return {"ok": False, "error": f"invalid kinds: {exc}"}

    limit = req.get("limit", 20)
    try:
        limit = int(limit)
    except (ValueError, TypeError):
        return {"ok": False, "error": "limit must be an integer"}

    from search import indexer as _indexer
    try:
        hits, tel = search(query, since=since, kinds=kinds, limit=limit,
                           db_path=_indexer.SEARCH_DB_PATH)
    except ValueError as exc:
        return {"ok": False, "error": str(exc)}

    return {
        "ok": True,
        "hits": [h.to_dict() for h in hits],
        "elapsed_ms": int(tel.get("sweep_ms", 0)) + int(tel.get("query_ms", 0)),
        "fallback_used": bool(tel.get("fallback_used", False)),
        "telemetry": tel,
    }


def main() -> int:
    raw = sys.stdin.read()
    if not raw.strip():
        sys.stdout.write(json.dumps({"ok": False, "error": "empty stdin"}) + "\n")
        return 2
    try:
        req = json.loads(raw)
    except json.JSONDecodeError as exc:
        sys.stdout.write(
            json.dumps({"ok": False, "error": f"invalid JSON: {exc}"}) + "\n"
        )
        return 2
    if not isinstance(req, dict):
        sys.stdout.write(
            json.dumps({"ok": False, "error": "request must be a JSON object"}) + "\n"
        )
        return 2
    resp = handle_request(req)
    sys.stdout.write(json.dumps(resp, ensure_ascii=False) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
