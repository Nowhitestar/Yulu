"""yulu memo — voicemail inbox CLI."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional, Sequence

from voicemail.repo import (
    VOICEMAIL_DIR_DEFAULT,
    AmbiguousVoicemailId,
    VoicemailNotFound,
    delete_voicemail,
    get_voicemail,
    list_voicemails,
)

# Module-level so tests can monkeypatch
VOICEMAIL_DIR = VOICEMAIL_DIR_DEFAULT


def _cmd_new(title: Optional[str] = None) -> int:
    """Real implementation imported lazily so tests can stub the module."""
    from voicemail.recorder import cmd_new as _real
    return _real(title=title)


def _cmd_stop() -> int:
    from voicemail.recorder import cmd_stop as _real
    return _real()


def _send_summary(summary_path: str) -> bool:
    """Indirection around send_summary.send_summary for testability."""
    from send_summary import send_summary
    return send_summary(summary_path)


def _cmd_list(args) -> int:
    records = list_voicemails(directory=VOICEMAIL_DIR, limit=args.limit)
    if not records:
        print("no voicemails")
        return 0
    header = f"{'ID':<32} {'TITLE':<40} {'DURATION':<10} SUMMARIZED"
    print(header)
    print("-" * len(header))
    for r in records:
        summarized = "✓" if r.has_summary else ""
        if len(r.summary_slugs) > 1:
            summarized = f"✓ ({' + '.join(s.replace('voicemail-', '') for s in r.summary_slugs)})"
        title_disp = (r.title[:38] + "..") if len(r.title) > 38 else r.title
        dur = f"{r.duration_sec}s" if r.duration_sec < 60 else f"{r.duration_sec // 60}m{r.duration_sec % 60:02d}s"
        print(f"{r.stem:<32} {title_disp:<40} {dur:<10} {summarized}")
    return 0


def _resolve(id_prefix: str) -> Optional[object]:
    try:
        return get_voicemail(id_prefix, directory=VOICEMAIL_DIR)
    except AmbiguousVoicemailId as exc:
        print(f"ambiguous id '{id_prefix}'; candidates:", file=sys.stderr)
        for s in exc.candidates:
            print(f"  {s}", file=sys.stderr)
        return None
    except VoicemailNotFound:
        print(f"no voicemail matches '{id_prefix}'", file=sys.stderr)
        return None


def _cmd_show(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    transcript_path = rec.wav_path.with_suffix(".transcript.txt")
    summary_path = rec.wav_path.with_suffix(".summary.md")
    print(f"# {rec.stem}  —  {rec.title}")
    print()
    if transcript_path.exists():
        print("## Transcript\n")
        print(transcript_path.read_text(encoding="utf-8"))
    if summary_path.exists():
        print("\n## Summary\n")
        print(summary_path.read_text(encoding="utf-8"))
    return 0


def _cmd_delete(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    if not args.yes:
        ans = input(f"delete {rec.stem}? [y/N] ").strip().lower()
        if ans not in ("y", "yes"):
            print("aborted")
            return 0
    n = delete_voicemail(rec)
    print(f"removed {n} files")
    return 0


def _cmd_send(args) -> int:
    rec = _resolve(args.id)
    if rec is None:
        return 1
    slug = args.prompt or "voicemail-todos"
    if slug == "voicemail-todos":
        summary_path = rec.wav_path.with_suffix(".summary.md")
    else:
        summary_path = rec.wav_path.with_suffix(f".{slug}.summary.md")
    if not summary_path.exists():
        print(f"summary file not found: {summary_path}", file=sys.stderr)
        return 1
    ok = _send_summary(str(summary_path))
    return 0 if ok else 1


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="yulu memo",
                                     description="Voicemail inbox")
    sub = parser.add_subparsers(dest="cmd")

    new_p = sub.add_parser("new", help="Start a new voicemail recording")
    new_p.add_argument("--title", default=None)

    sub.add_parser("stop", help="Stop the current voicemail recording")

    list_p = sub.add_parser("list", help="List inbox (newest first)")
    list_p.add_argument("--limit", type=int, default=20)

    show_p = sub.add_parser("show", help="Show transcript + summary")
    show_p.add_argument("id")

    del_p = sub.add_parser("delete", help="Delete a voicemail")
    del_p.add_argument("id")
    del_p.add_argument("--yes", action="store_true",
                       help="Skip confirmation prompt")

    send_p = sub.add_parser("send", help="Forward summary via send_summary")
    send_p.add_argument("id")
    send_p.add_argument("--prompt", default=None,
                        help="Which summary slug to send (default: voicemail-todos)")

    args = parser.parse_args(argv)
    if args.cmd in (None, "new"):
        title = getattr(args, "title", None)
        return _cmd_new(title=title)
    if args.cmd == "stop":
        return _cmd_stop()
    if args.cmd == "list":
        return _cmd_list(args)
    if args.cmd == "show":
        return _cmd_show(args)
    if args.cmd == "delete":
        return _cmd_delete(args)
    if args.cmd == "send":
        return _cmd_send(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
