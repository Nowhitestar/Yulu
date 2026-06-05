"""`yulu search` CLI: argparse + IPC client + in-process fallback.

The CLI is a thin client. It prefers the running status_agent's IPC
(spec §7) so the index sweep / FTS5 work happens in the long-lived
agent process, but falls back to importing `search.reader` in-process
when the agent isn't reachable. Both paths share the same
`search.reader.search()` — no behavior drift between them.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import socket as _socket
import subprocess
import sys
from datetime import timedelta
from pathlib import Path
from typing import Optional

# Import lazily where possible so help / --doctor / --reindex don't
# pay the cost of opening the SQLite connection unless they need it.

IPC_SOCKET_PATH = Path.home() / ".config" / "yulu" / "status_agent.sock"

_DURATION_RE = re.compile(r"^(?P<n>\d+)\s*(?P<unit>[smhdw])$")
_DURATION_UNITS = {
    "s": ("seconds", 1),
    "m": ("minutes", 60),
    "h": ("hours", 3600),
    "d": ("days", 86400),
    "w": ("weeks", 7 * 86400),
}


def parse_duration(spec: str) -> timedelta:
    """Parse '30s' / '15m' / '4h' / '7d' / '2w' into a timedelta.

    Raises argparse.ArgumentTypeError on bad input so argparse renders
    a clean error message."""
    if spec is None:
        return None
    s = spec.strip().lower()
    m = _DURATION_RE.match(s)
    if not m:
        raise argparse.ArgumentTypeError(
            f"invalid duration {spec!r}; want N[s|m|h|d|w]")
    n = int(m.group("n"))
    _key, sec = _DURATION_UNITS[m.group("unit")]
    return timedelta(seconds=n * sec)


def _types_to_kinds(type_: Optional[str], in_: Optional[str]) -> Optional[list[str]]:
    """Combine --type {meeting,all} and --in {summary,transcript,both} into a
    `kinds` list. None means "all kinds". Every recording is a meeting now, so
    `meeting` and `all` are equivalent."""
    from search.indexer import KIND_MEETING_SUMMARY, KIND_MEETING_TRANSCRIPT

    # --type is a no-op for kind selection (only meetings exist); --in narrows.
    base = {
        "summary":    [KIND_MEETING_SUMMARY],
        "transcript": [KIND_MEETING_TRANSCRIPT],
        "both":       None,   # all kinds → don't filter
    }
    t = (type_ or "all").lower()
    i = (in_ or "both").lower()
    if t not in ("meeting", "all") or i not in base:
        raise argparse.ArgumentTypeError(
            f"invalid --type / --in combination: type={type_!r}, in={in_!r}"
        )
    return base[i]


# ── IPC client ─────────────────────────────────────────────────────────

def _ipc_search(
    *,
    query: str,
    since: Optional[timedelta],
    kinds: Optional[list[str]],
    limit: int,
    timeout: float = 5.0,
    socket_path: Optional[Path] = None,
) -> Optional[dict]:
    # Resolve socket path at call time so tests can monkeypatch the
    # module-level IPC_SOCKET_PATH without it being captured as a default.
    if socket_path is None:
        socket_path = IPC_SOCKET_PATH
    """Send a {"action":"search", ...} request to status_agent.sock and
    return the parsed JSON response.

    Returns None when the agent is unreachable (FileNotFoundError,
    ConnectionRefused, OSError, timeout) so the caller can fall back to
    in-process search.
    """
    payload = {
        "action": "search",
        "query": query,
        "limit": int(limit),
    }
    if since is not None:
        payload["since_days"] = max(0, int(since.total_seconds() / 86400))
    if kinds:
        payload["kinds"] = list(kinds)
    line = (json.dumps(payload) + "\n").encode("utf-8")
    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        try:
            s.connect(str(socket_path))
        except (FileNotFoundError, ConnectionRefusedError, OSError):
            return None
        s.sendall(line)
        chunks: list[bytes] = []
        while True:
            buf = s.recv(4096)
            if not buf:
                break
            chunks.append(buf)
            if buf.endswith(b"\n"):
                break
    except (TimeoutError, OSError):
        return None
    finally:
        s.close()
    body = b"".join(chunks).strip()
    if not body:
        return None
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError:
        return None


def _in_process_search(
    *,
    query: str,
    since: Optional[timedelta],
    kinds: Optional[list[str]],
    limit: int,
) -> dict:
    """In-process fallback: import search.reader directly. Returns an
    IPC-shaped dict so the renderer can treat both paths uniformly."""
    from search import indexer as _indexer
    from search.reader import search
    hits, tel = search(query, since=since, kinds=kinds, limit=limit,
                       db_path=_indexer.SEARCH_DB_PATH)
    return {
        "ok": True,
        "hits": [h.to_dict() for h in hits],
        "elapsed_ms": tel.get("sweep_ms", 0) + tel.get("query_ms", 0),
        "fallback_used": tel.get("fallback_used", False),
        "telemetry": tel,
    }


# ── Rendering ──────────────────────────────────────────────────────────

_HIT_OPEN = "[hit]"
_HIT_CLOSE = "[/hit]"


def _render_snippet(snippet: str, *, tty: bool) -> str:
    """ANSI bold-underline for [hit]...[/hit] on TTY; plain text otherwise."""
    if not tty:
        return snippet.replace(_HIT_OPEN, "[").replace(_HIT_CLOSE, "]")
    bold = "\033[1;4m"
    reset = "\033[0m"
    return snippet.replace(_HIT_OPEN, bold).replace(_HIT_CLOSE, reset)


def _format_recorded_at(iso: str) -> str:
    """Convert '2026-05-21T16:00:08' → '2026-05-21 16:00:08'."""
    return iso.replace("T", " ", 1) if iso else iso


def _render_text(resp: dict, *, tty: bool, verbose: bool) -> str:
    hits = resp.get("hits") or []
    tel = resp.get("telemetry") or {}
    elapsed = resp.get("elapsed_ms", tel.get("query_ms", 0))
    path = "FTS5" if not (resp.get("fallback_used") or tel.get("fallback_used")) else "LIKE"
    header = f"{len(hits)} hit{'' if len(hits) == 1 else 's'} ({elapsed} ms, {path})"
    lines = [header, ""]
    for i, h in enumerate(hits, start=1):
        kind = h.get("kind", "?")
        title = h.get("meeting_title", "?")
        when = _format_recorded_at(h.get("recorded_at", ""))
        snippet = _render_snippet(h.get("snippet", ""), tty=tty)
        path_str = h.get("source_path", "")
        lines.append(f"[{i}] {kind}  {title}  {when}")
        if snippet:
            lines.append(f"    {snippet}")
        lines.append(f"    {path_str}")
        lines.append("")
    if verbose:
        lines.append(
            f"telemetry: sweep_ms={tel.get('sweep_ms')} "
            f"query_ms={tel.get('query_ms')} "
            f"fallback_used={tel.get('fallback_used')}"
        )
    return "\n".join(lines).rstrip() + "\n"


# ── Commands ──────────────────────────────────────────────────────────

def _do_search(args) -> int:
    try:
        kinds = _types_to_kinds(args.type, args.in_)
    except argparse.ArgumentTypeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 2
    since = parse_duration(args.since) if args.since else None

    resp = None
    if not args.no_ipc:
        resp = _ipc_search(
            query=args.query, since=since, kinds=kinds, limit=args.limit,
        )
    if resp is None:
        try:
            resp = _in_process_search(
                query=args.query, since=since, kinds=kinds, limit=args.limit,
            )
        except ValueError as exc:
            print(f"⚠️ {exc}", file=sys.stderr)
            return 2

    if not resp.get("ok", True):
        print(f"⚠️ {resp.get('error', 'search failed')}", file=sys.stderr)
        return 1

    if args.json:
        print(json.dumps(resp, ensure_ascii=False))
        return 0

    tty = sys.stdout.isatty()
    print(_render_text(resp, tty=tty, verbose=args.verbose), end="")

    if args.open and resp.get("hits"):
        top = resp["hits"][0]
        path = top.get("source_path")
        if path:
            try:
                subprocess.run(["open", path], check=False)
            except FileNotFoundError:
                print("⚠️ `open` command not found (not macOS?)", file=sys.stderr)
    return 0


def _do_doctor() -> int:
    from search import indexer as _indexer
    from search.reader import doctor
    h = doctor(db_path=_indexer.SEARCH_DB_PATH)
    print(json.dumps(h, ensure_ascii=False, indent=2))
    return 0


def _do_reindex() -> int:
    from search import indexer as _indexer
    from search.reader import reindex
    counts = reindex(db_path=_indexer.SEARCH_DB_PATH)
    print(json.dumps({"reindex": counts}, ensure_ascii=False))
    return 0


# ── argparse ──────────────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="yulu search",
        description="Search across meetings and summaries.",
    )
    p.add_argument("query", nargs="?", default="",
                   help="Search term (e.g. 'OKR', '项目进度', '进度').")
    p.add_argument("--since", default=None,
                   help="Time window, e.g. 30m / 4h / 7d / 2w (default: all time).")
    p.add_argument("--type", choices=["meeting", "all"], default="all",
                   help="Restrict to a corpus type (only meetings exist). Default: all.")
    # 'in' is a Python keyword; argparse uses dest='in_' via add_argument.
    p.add_argument("--in", dest="in_",
                   choices=["summary", "transcript", "both"], default="both",
                   help="Restrict to summaries, transcripts, or both. Default: both.")
    p.add_argument("--limit", type=int, default=20,
                   help="Max hits (capped at 100).")
    p.add_argument("--json", action="store_true",
                   help="Emit raw JSON to stdout instead of rendered text.")
    p.add_argument("--open", action="store_true",
                   help="Open the top hit's source file via macOS `open`.")
    p.add_argument("--verbose", action="store_true",
                   help="Show telemetry line at the bottom of text output.")
    p.add_argument("--no-ipc", action="store_true",
                   help="Skip the IPC path; use in-process search.reader directly.")
    p.add_argument("--doctor", action="store_true",
                   help="Print search-index health dict and exit.")
    p.add_argument("--reindex", action="store_true",
                   help="Drop docs/docs_meta and rebuild from disk.")
    return p


def main(argv: list[str] | None = None) -> int:
    args = _build_parser().parse_args(argv)
    if args.doctor:
        return _do_doctor()
    if args.reindex:
        return _do_reindex()
    if not args.query.strip():
        print("⚠️ search requires a query (or --doctor / --reindex)",
              file=sys.stderr)
        return 2
    return _do_search(args)


if __name__ == "__main__":
    raise SystemExit(main())
