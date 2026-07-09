"""`yulu prompts` CLI subcommand implementation."""

from __future__ import annotations

import argparse
import csv
import json
import os
import signal
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from .db import (
    PromptsRepo, Prompt, Category, Source, open_db,
)
from .seed import seed_from_current, restore_defaults


DEFAULT_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
WORKER_PID = Path.home() / ".config" / "yulu" / "agent_queue_worker.pid"


def _sighup_worker() -> None:
    """Best-effort SIGHUP to running agent_queue_worker for cache reload."""
    try:
        if not WORKER_PID.exists():
            return
        pid = int(WORKER_PID.read_text().strip())
        os.kill(pid, signal.SIGHUP)
    except (OSError, ValueError):
        pass


def _prompt_to_dict(p: Prompt) -> dict:
    d = asdict(p)
    d["category"] = p.category.value
    d["source"] = p.source.value
    return d


def _print_table(rows: list[dict]) -> None:
    """Simple aligned table; mirrors vocab/cli.py::_print_table style.

    Columns: slug, name, category, is_auto_run, source, sort_order
    """
    if not rows:
        print("(empty)")
        return
    cols = ["slug", "name", "category", "is_auto_run", "source", "sort_order"]
    widths = {c: max(len(c), max(len(str(r.get(c, "") or "")) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "") or "").ljust(widths[c]) for c in cols))


# ── subcommand handlers ─────────────────────────────────────────────

def _cmd_list(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """list [--category {summary,cleanup,voice}] [--auto-run] [--json]

    --auto-run filters to is_auto_run=True only.
    With no flags: all prompts, all categories, sorted by sort_order asc + slug asc.
    """
    category = Category(args.category) if args.category else None
    auto_run_only = getattr(args, "auto_run", False)
    prompts = repo.list_prompts(category=category, auto_run_only=auto_run_only)
    rows = [_prompt_to_dict(p) for p in prompts]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        _print_table(rows)
    return 0


def _cmd_add(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """add <slug> --name <name> --category {summary,cleanup,voice}
        (--content <text> | --from-file <path>)
        [--auto-run] [--sort-order N] [--note <text>]

    --content and --from-file are mutually exclusive AND required.
    Prints the new prompt's id. Returns 0 on success.
    Handles ValueError → print to stderr + return 1.
    """
    if args.from_file:
        content = Path(args.from_file).read_text(encoding="utf-8")
    else:
        content = args.content

    try:
        prompt_id = repo.add(
            slug=args.slug,
            name=args.name,
            category=Category(args.category),
            content=content,
            is_auto_run=getattr(args, "auto_run", False),
            sort_order=getattr(args, "sort_order", 0) or 0,
            note=getattr(args, "note", None),
        )
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        return 1
    print(prompt_id)
    return 0


def _cmd_edit(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """edit <slug> [--name ...] [--content ...|--from-file ...] [--category ...]
        [--sort-order N] [--note ...] [--auto-run | --no-auto-run]

    --auto-run and --no-auto-run are mutex (argparse mutually_exclusive_group).
    Returns 0 on success, 1 if slug not found (print "slug <x> not found" to stderr).
    """
    existing = repo.by_slug(args.slug)
    if not existing:
        print(f"slug {args.slug} not found", file=sys.stderr)
        return 1

    # Resolve content from --content or --from-file
    content = None
    if args.from_file:
        content = Path(args.from_file).read_text(encoding="utf-8")
    elif args.content:
        content = args.content

    # Resolve is_auto_run: None means "don't change"
    is_auto_run = None
    if getattr(args, "auto_run", False):
        is_auto_run = True
    elif getattr(args, "no_auto_run", False):
        is_auto_run = False

    category = Category(args.category) if args.category else None

    repo.edit(
        args.slug,
        name=args.name or None,
        content=content,
        category=category,
        is_auto_run=is_auto_run,
        sort_order=getattr(args, "sort_order", None),
        note=args.note if hasattr(args, "note") else None,
    )
    return 0


def _cmd_remove(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """remove <slug>

    Returns 1 with "slug <slug> not found" to stderr if missing; else 0.
    """
    if not repo.remove(args.slug):
        print(f"slug {args.slug} not found", file=sys.stderr)
        return 1
    return 0


def _cmd_show(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """show <slug>

    Prints the raw `content` to stdout (no escaping). Returns 1 if not found.
    """
    prompt = repo.by_slug(args.slug)
    if not prompt:
        print(f"slug {args.slug} not found", file=sys.stderr)
        return 1
    print(prompt.content)
    return 0


def _cmd_seed(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """seed --from-current | --restore-defaults

    Mutex flags, exactly one required (argparse group with required=True).
    Prints JSON-formatted summary dict from seed_from_current/restore_defaults.
    """
    if args.restore_defaults:
        summary = restore_defaults(repo)
    else:
        summary = seed_from_current(repo)
    print(json.dumps(summary, indent=2))
    return 0


def _cmd_export(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """export [--format json] [-o <path>]

    Default format json. Without -o: write to stdout.
    Exported shape: list of dicts (same as _prompt_to_dict).
    """
    prompts = repo.list_prompts()
    rows = [_prompt_to_dict(p) for p in prompts]
    if args.format == "json":
        out = json.dumps(rows, ensure_ascii=False, indent=2)
    else:
        import io
        buf = io.StringIO()
        fields = ["slug", "name", "category", "content", "is_auto_run",
                  "source", "sort_order", "note"]
        writer = csv.DictWriter(buf, fieldnames=fields)
        writer.writeheader()
        for r in rows:
            writer.writerow({f: r.get(f, "") for f in fields})
        out = buf.getvalue()
    if args.output:
        Path(args.output).write_text(out, encoding="utf-8")
    else:
        print(out)
    return 0


def _cmd_import(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """import <file>

    Accepts .json (list of dicts matching _prompt_to_dict shape).
    For each row: call repo.add with appropriate fields. Skip rows that
    fail to insert (slug conflict, validation error) with a stderr warning.
    Prints {"inserted": N} JSON summary.
    """
    p = Path(args.file)
    if not p.exists():
        print(f"file not found: {p}", file=sys.stderr)
        return 1
    if p.suffix == ".json":
        rows = json.loads(p.read_text(encoding="utf-8"))
    elif p.suffix == ".csv":
        with p.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    else:
        print(f"unsupported file extension: {p.suffix}", file=sys.stderr)
        return 1

    inserted = 0
    for r in rows:
        try:
            repo.add(
                slug=r["slug"],
                name=r["name"],
                category=Category(r["category"]),
                content=r["content"],
                is_auto_run=bool(r.get("is_auto_run", False)),
                source=Source(r.get("source") or "manual"),
                sort_order=int(r.get("sort_order", 0) or 0),
                note=r.get("note") or None,
            )
            inserted += 1
        except (KeyError, ValueError) as exc:
            print(f"skip row: {exc}", file=sys.stderr)
    print(json.dumps({"inserted": inserted}, indent=2))
    return 0


def _cmd_reload(args: argparse.Namespace, repo: PromptsRepo) -> int:
    """reload — SIGHUP the worker (best-effort) and print confirmation."""
    _sighup_worker()
    print("SIGHUP sent (best-effort)")
    return 0


# ── argparse + entry ────────────────────────────────────────────────

def _build_parser() -> argparse.ArgumentParser:
    """Build the argparse tree (see _cmd_* docstrings for surfaces)."""
    p = argparse.ArgumentParser(prog="yulu prompts")
    p.add_argument("--db", default=str(DEFAULT_DB), help="prompts.sqlite path")
    sub = p.add_subparsers(dest="cmd", required=True)

    # list
    pl = sub.add_parser("list")
    pl.add_argument("--category", choices=["summary", "cleanup", "voice"])
    pl.add_argument("--auto-run", dest="auto_run", action="store_true",
                    help="filter to auto-run prompts only")
    pl.add_argument("--json", action="store_true")

    # add
    pa = sub.add_parser("add")
    pa.add_argument("slug")
    pa.add_argument("--name", required=True)
    pa.add_argument("--category", choices=["summary", "cleanup", "voice"], required=True)
    content_group = pa.add_mutually_exclusive_group(required=True)
    content_group.add_argument("--content")
    content_group.add_argument("--from-file", dest="from_file")
    pa.add_argument("--auto-run", dest="auto_run", action="store_true")
    pa.add_argument("--sort-order", dest="sort_order", type=int, default=0)
    pa.add_argument("--note")

    # edit
    pe = sub.add_parser("edit")
    pe.add_argument("slug")
    pe.add_argument("--name")
    content_edit_group = pe.add_mutually_exclusive_group()
    content_edit_group.add_argument("--content")
    content_edit_group.add_argument("--from-file", dest="from_file")
    pe.add_argument("--category", choices=["summary", "cleanup", "voice"])
    pe.add_argument("--sort-order", dest="sort_order", type=int)
    pe.add_argument("--note")
    auto_run_group = pe.add_mutually_exclusive_group()
    auto_run_group.add_argument("--auto-run", dest="auto_run", action="store_true")
    auto_run_group.add_argument("--no-auto-run", dest="no_auto_run", action="store_true")

    # remove
    pr = sub.add_parser("remove")
    pr.add_argument("slug")

    # show
    psh = sub.add_parser("show")
    psh.add_argument("slug")

    # seed
    ps = sub.add_parser("seed")
    seed_group = ps.add_mutually_exclusive_group(required=True)
    seed_group.add_argument("--from-current", dest="from_current", action="store_true")
    seed_group.add_argument("--restore-defaults", dest="restore_defaults", action="store_true")

    # export
    px = sub.add_parser("export")
    px.add_argument("--format", choices=["json", "csv"], default="json")
    px.add_argument("-o", "--output")

    # import
    pi = sub.add_parser("import")
    pi.add_argument("file")

    # reload
    sub.add_parser("reload")

    return p


def _extract_db_from_argv(argv: list[str]) -> tuple[str, list[str]]:
    """Extract --db value from argv (may appear anywhere), return (db_path, remaining_argv)."""
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


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    db_path, remaining = _extract_db_from_argv(list(argv))
    parser = _build_parser()
    args = parser.parse_args(remaining)
    args.db = db_path

    repo = PromptsRepo(open_db(Path(args.db)))
    handlers = {
        "list":   _cmd_list,
        "add":    _cmd_add,
        "edit":   _cmd_edit,
        "remove": _cmd_remove,
        "show":   _cmd_show,
        "seed":   _cmd_seed,
        "export": _cmd_export,
        "import": _cmd_import,
        "reload": _cmd_reload,
    }
    try:
        code = handlers[args.cmd](args, repo)
    finally:
        repo.conn.close()

    if args.cmd in {"add", "edit", "remove", "seed", "import"}:
        _sighup_worker()
    return code


if __name__ == "__main__":
    sys.exit(main())
