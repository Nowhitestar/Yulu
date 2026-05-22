"""`yulu summaries` CLI — read-only browser over the summaries provenance table."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from prompts import SummariesRepo, SummaryStatus, open_db


DEFAULT_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"


def _summary_to_dict(s) -> dict:
    d = asdict(s)
    d["status"] = s.status.value
    return d


def _extract_db_from_argv(argv: list[str]) -> tuple[str, list[str]]:
    """Same workaround as vocab/cli.py + prompts/cli.py — pull --db before
    argparse so it can appear after the subcommand."""
    remaining = []
    db_path = str(DEFAULT_DB)
    i = 0
    while i < len(argv):
        if argv[i] == "--db" and i + 1 < len(argv):
            db_path = argv[i + 1]
            i += 2
        elif argv[i].startswith("--db="):
            db_path = argv[i][len("--db="):]
            i += 1
        else:
            remaining.append(argv[i])
            i += 1
    return db_path, remaining


def _build_parser() -> argparse.ArgumentParser:
    """Subcommands:
      list [--audio <path>] [--status {queued,running,done,error}] [--json]
      show <id>
    """
    p = argparse.ArgumentParser(prog="yulu summaries")
    p.add_argument("--db", default=str(DEFAULT_DB))
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--audio")
    pl.add_argument("--status", choices=["queued", "running", "done", "error"])
    pl.add_argument("--json", action="store_true")

    ps = sub.add_parser("show")
    ps.add_argument("id")

    return p


def _print_table(rows: list[dict]) -> None:
    """Compact table: id-prefix (first 8), status, slug, audio basename, duration_ms."""
    if not rows:
        print("(empty)")
        return
    cols = [
        ("id", lambda r: r["id"][:8]),
        ("status", lambda r: r["status"]),
        ("slug", lambda r: r["prompt_slug"]),
        ("audio", lambda r: Path(r["audio_path"]).name),
        ("duration_ms", lambda r: str(r.get("duration_ms") or "")),
    ]
    headers = [c[0] for c in cols]
    data = [[fn(r) for _, fn in cols] for r in rows]
    widths = [max(len(h), max((len(str(row[i])) for row in data), default=0)) for i, h in enumerate(headers)]
    print("  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("  ".join("-" * w for w in widths))
    for row in data:
        print("  ".join(str(v).ljust(w) for v, w in zip(row, widths)))


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    db_path, remaining = _extract_db_from_argv(list(argv))
    parser = _build_parser()
    args = parser.parse_args(remaining)
    args.db = db_path

    repo = SummariesRepo(open_db(Path(args.db)))
    try:
        if args.cmd == "list":
            status = SummaryStatus(args.status) if args.status else None
            rows = repo.list_summaries(audio_path=args.audio, status=status)
            data = [_summary_to_dict(s) for s in rows]
            if args.json:
                print(json.dumps(data, ensure_ascii=False, indent=2))
            else:
                _print_table(data)
            return 0
        elif args.cmd == "show":
            s = repo.get(args.id)
            if not s:
                print(f"summary {args.id} not found", file=sys.stderr)
                return 1
            print(json.dumps(_summary_to_dict(s), ensure_ascii=False, indent=2))
            return 0
    finally:
        repo.conn.close()


if __name__ == "__main__":
    sys.exit(main())
