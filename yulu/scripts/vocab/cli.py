"""`yulu vocab` CLI subcommand implementation."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Optional

from application_paths import CONFIG_READ_PATHS, DURABLE_DATA_DIR

from .db import VocabRepo, Scope, Source, open_db
from .seed import seed_from_current, restore_defaults


DEFAULT_DB = DURABLE_DATA_DIR / "vocab.sqlite"


def _word_to_dict(w) -> dict:
    d = asdict(w)
    d["scope"] = w.scope.value
    d["source"] = w.source.value
    return d


def _print_table(rows: list[dict]) -> None:
    if not rows:
        print("(empty)")
        return
    cols = ["id", "term", "canonical", "scope", "source", "enabled", "note"]
    widths = {c: max(len(c), max(len(str(r.get(c, "") or "")) for r in rows)) for c in cols}
    header = "  ".join(c.ljust(widths[c]) for c in cols)
    print(header)
    print("  ".join("-" * widths[c] for c in cols))
    for r in rows:
        print("  ".join(str(r.get(c, "") or "").ljust(widths[c]) for c in cols))


def _cmd_list(args: argparse.Namespace, repo: VocabRepo) -> int:
    scope = Scope(args.scope) if args.scope else None
    words = repo.list_words(scope=scope, enabled_only=False)
    if args.disabled:
        words = [w for w in words if not w.enabled]
    rows = [_word_to_dict(w) for w in words]
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
    else:
        _print_table(rows)
    return 0


def _cmd_add(args: argparse.Namespace, repo: VocabRepo) -> int:
    canonical = args.canonical if args.canonical is not None else args.term
    wid = repo.add(
        term=args.term,
        canonical=canonical,
        scope=Scope(args.scope),
        note=args.note,
    )
    print(wid)
    return 0


def _cmd_edit(args: argparse.Namespace, repo: VocabRepo) -> int:
    existing = repo.get(args.id)
    if not existing:
        print(f"id {args.id} not found", file=sys.stderr)
        return 1
    repo.edit(
        args.id,
        term=args.term,
        canonical=args.canonical,
        scope=Scope(args.scope) if args.scope else None,
        note=args.note,
    )
    if args.enable:
        repo.set_enabled(args.id, True)
    elif args.disable:
        repo.set_enabled(args.id, False)
    return 0


def _cmd_remove(args: argparse.Namespace, repo: VocabRepo) -> int:
    if not repo.remove(args.id):
        print(f"id {args.id} not found", file=sys.stderr)
        return 1
    return 0


def _cmd_seed(args: argparse.Namespace, repo: VocabRepo) -> int:
    config_replacements = _load_config_replacements() if args.from_current else None
    if args.restore_defaults:
        summary = restore_defaults(repo)
    else:
        summary = seed_from_current(repo, config_replacements=config_replacements)
    print(json.dumps(summary, indent=2))
    return 0


def _cmd_export(args: argparse.Namespace, repo: VocabRepo) -> int:
    words = repo.list_words()
    rows = [_word_to_dict(w) for w in words]
    if args.format == "json":
        out = json.dumps(rows, ensure_ascii=False, indent=2)
    else:
        import io
        buf = io.StringIO()
        fields = ["term", "canonical", "scope", "source", "enabled", "note"]
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


def _cmd_import(args: argparse.Namespace, repo: VocabRepo) -> int:
    p = Path(args.file)
    if not p.exists():
        print(f"file not found: {p}", file=sys.stderr)
        return 1
    inserted = 0
    if p.suffix == ".json":
        rows = json.loads(p.read_text(encoding="utf-8"))
    elif p.suffix == ".csv":
        with p.open(newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
    else:
        print(f"unsupported file extension: {p.suffix}", file=sys.stderr)
        return 1
    for r in rows:
        try:
            repo.add(
                term=r["term"],
                canonical=r["canonical"],
                scope=Scope(r["scope"]),
                source=Source(r.get("source") or "manual"),
                enabled=str(r.get("enabled", "1")).lower() not in ("0", "false"),
                note=r.get("note") or None,
            )
            inserted += 1
        except (KeyError, ValueError) as exc:
            print(f"skip row: {exc}", file=sys.stderr)
    print(json.dumps({"inserted": inserted}, indent=2))
    return 0


def _load_config_replacements() -> Optional[dict[str, str]]:
    config = next((path for path in CONFIG_READ_PATHS if path.exists()), None)
    if config is None:
        return None
    try:
        data = json.loads(config.read_text(encoding="utf-8"))
        trans = data.get("transcription", {})
        return trans.get("replacements")
    except (json.JSONDecodeError, OSError):
        return None


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="yulu vocab")
    p.add_argument("--db", default=str(DEFAULT_DB), help="vocab.sqlite path")
    sub = p.add_subparsers(dest="cmd", required=True)

    pl = sub.add_parser("list")
    pl.add_argument("--scope", choices=["prompt", "replace", "both"])
    pl.add_argument("--disabled", action="store_true", help="show only disabled rows")
    pl.add_argument("--json", action="store_true")

    pa = sub.add_parser("add")
    pa.add_argument("term")
    pa.add_argument("canonical", nargs="?")
    pa.add_argument("--scope", choices=["prompt", "replace", "both"], default="both")
    pa.add_argument("--note")

    pe = sub.add_parser("edit")
    pe.add_argument("id")
    pe.add_argument("--term")
    pe.add_argument("--canonical")
    pe.add_argument("--scope", choices=["prompt", "replace", "both"])
    pe.add_argument("--note")
    group = pe.add_mutually_exclusive_group()
    group.add_argument("--enable", action="store_true")
    group.add_argument("--disable", action="store_true")

    pr = sub.add_parser("remove")
    pr.add_argument("id")

    ps = sub.add_parser("seed")
    seed_group = ps.add_mutually_exclusive_group(required=True)
    seed_group.add_argument("--from-current", action="store_true")
    seed_group.add_argument("--restore-defaults", action="store_true")

    px = sub.add_parser("export")
    px.add_argument("--format", choices=["json", "csv"], default="json")
    px.add_argument("-o", "--output")

    pi = sub.add_parser("import")
    pi.add_argument("file")

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

    # Pre-extract --db so it works regardless of position (before or after subcommand)
    db_path, remaining_argv = _extract_db_from_argv(list(argv))

    parser = _build_parser()
    # Remove --db from the parser since we handle it manually above;
    # inject it back as a dummy default so args.db is still accessible
    args = parser.parse_args(remaining_argv)
    args.db = db_path

    repo = VocabRepo(open_db(Path(args.db)))
    handlers = {
        "list": _cmd_list,
        "add": _cmd_add,
        "edit": _cmd_edit,
        "remove": _cmd_remove,
        "seed": _cmd_seed,
        "export": _cmd_export,
        "import": _cmd_import,
    }
    try:
        code = handlers[args.cmd](args, repo)
    finally:
        repo.conn.close()

    return code


if __name__ == "__main__":
    sys.exit(main())
