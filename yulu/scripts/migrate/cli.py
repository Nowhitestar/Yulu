#!/usr/bin/env python3
"""``yulu migrate`` / ``yulu rollback`` — the pipeline DRIVER (MIG-01, MIG-03, D-05).

This module is the user-facing (and agent-facing) surface for Phase 7. It does NOT
re-implement any of the four pipeline stages — it COMPOSES them, mirroring
``provision/cli.py``'s argparse-subcommand + ``main(argv)`` shape:

  * ``detect`` (07-01) — ``detect_migration(runtime_dir, config_dir) -> MigrationNeed``
  * ``plan``   (07-01) — ``build_plan(need) -> MigrationPlan`` (dry-run-able)
  * ``apply``  (07-03) — ``apply_migration(...) -> MigrationResult`` (transactional)
  * ``verify`` (07-03) — ``finalize(result, ...)`` (post-migration gate + prune)

SUBCOMMANDS
-----------
``migrate [--dry-run] [--runtime-dir DIR] [--config-dir DIR]``
    The four-stage pipeline. ``detect`` → if NOT ``needs_migration``, print
    "up-to-date" and exit 0 (a current install is a no-op — migration never re-runs
    destructively). → ``build_plan``. → with ``--dry-run``, print ``plan.render()``
    and exit 0 having mutated NOTHING (no apply, no daemon stop). → else
    ``apply_migration``; a REFUSED (recording-active) result prints the refusal and
    exits non-zero WITHOUT mutating. → ``verify.finalize``: on PASS print success
    (the backup was pruned); on FAIL print "verification failed — backup retained;
    run ``yulu rollback`` to restore" and exit non-zero (the backup is NEVER pruned
    on a failed verify — D-03).

``rollback [--runtime-dir DIR]``
    Locate the most-recent ``<name>.backup-*`` sibling of the install dir and call
    ``apply.rollback(backup, install_dir)`` — restoring the prior state byte-for-byte.
    No backup found → a clear message and exit non-zero (nothing to restore).

NAMING (the easy-to-confuse pair):
  * ``--runtime-dir`` == the ``~/.yulu`` INSTALL TREE (release_installer's runtime
    sense; ``.yulu-install.json`` + the ``<name>.backup-*`` live here). Defaults to
    ``~/.yulu``.
  * ``--config-dir`` == ``~/.config/yulu`` (``config.json``). Defaults via the
    platform PathResolver (lazy + guarded), falling back to ``~/.config/yulu``.

Security: this CLI never shells out. The only caller-influenced values are the two
directory paths (handed to the stages as ``Path`` objects) and the ``--dry-run``
flag; the migration plan is built IN-PROCESS by ``build_plan`` from the detect
result (a fixed three-step enum apply dispatches on — no externally-supplied plan,
T-07-13). ``--dry-run`` is the safe default-adjacent path: it never mutates.

stdlib (``argparse`` / ``sys`` / ``os`` / ``pathlib``) + the four migrate stages only.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional

from migrate import apply as apply_mod
from migrate import verify as verify_mod
from migrate.apply import apply_migration, rollback
from migrate.detect import detect_migration
from migrate.plan import build_plan

# The default ``~/.yulu`` install tree — byte-identical to release_installer's CLI
# default (release_installer.py:541). The ``<name>.backup-*`` siblings live next to it.
_DEFAULT_INSTALL_DIR = os.path.expanduser("~/.yulu")


def _default_config_dir() -> Path:
    """Resolve ``~/.config/yulu`` lazily + guarded (mirrors detect._default_config_dir).

    The macOS PathResolver import must never break this stdlib CLI on another
    platform; degrade to ``~/.config/yulu``. Tests / advanced callers pass an
    explicit ``--config-dir`` and never hit this.
    """
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return Path(MacOSPathResolver().config_dir())
    except Exception:
        return Path.home() / ".config" / "yulu"


def _runtime_dir(args: argparse.Namespace) -> Path:
    """The ``~/.yulu`` install tree to operate on (explicit ``--runtime-dir`` or default)."""
    if getattr(args, "runtime_dir", None):
        return Path(args.runtime_dir)
    return Path(_DEFAULT_INSTALL_DIR)


def _config_dir(args: argparse.Namespace) -> Path:
    """The ``~/.config/yulu`` config root (explicit ``--config-dir`` or PathResolver default)."""
    if getattr(args, "config_dir", None):
        return Path(args.config_dir)
    return _default_config_dir()


def _latest_backup(install_dir: Path) -> Optional[Path]:
    """The most-recent ``<name>.backup-*`` sibling of ``install_dir``, or ``None``.

    ``move_existing_runtime_to_backup`` names backups ``<install_dir.name>.backup-<rand>``
    next to the install dir. "Most recent" is by mtime so a re-run restores the latest
    snapshot. A missing parent / no backup degrades to ``None`` (nothing to restore).
    """
    parent = install_dir.parent
    prefix = install_dir.name + ".backup-"
    try:
        candidates = [
            p for p in parent.iterdir()
            if p.is_dir() and p.name.startswith(prefix)
        ]
    except OSError:
        return None
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _cmd_migrate(args: argparse.Namespace) -> int:
    """Run detect → plan → (dry-run?) → apply → verify/finalize. Returns the exit code."""
    runtime_dir = _runtime_dir(args)
    config_dir = _config_dir(args)

    # ── detect ──
    need = detect_migration(runtime_dir, config_dir)
    if not need.needs_migration:
        print(f"Yulu install at {runtime_dir} is up-to-date — nothing to migrate.")
        return 0

    # ── plan ──
    plan = build_plan(need)

    # ── dry-run: print the plan, mutate NOTHING ──
    if args.dry_run:
        print("Planned migration corrections (dry-run — nothing applied):")
        rendered = plan.render()
        print(rendered if rendered else "  (no corrections)")
        return 0

    # ── apply (transactional) ──
    result = apply_migration(need, plan, runtime_dir, config_dir)

    if not result.ok:
        # Recording-active refusal (or any non-ok apply) — ZERO mutation already.
        for reason in result.reasons:
            print(reason, file=sys.stderr)
        return 1

    # ── verify + prune-on-success-only ──
    if verify_mod.finalize(result, config_dir, runtime_dir):
        print("Migration complete and verified. Applied:")
        for reason in result.reasons:
            print(f"  - {reason}")
        print("Backup pruned after the verified success.")
        return 0

    # Verify FAILED — the backup is RETAINED (never pruned). Point at rollback.
    print(
        "Migration applied but verification FAILED — backup retained; "
        "run `yulu rollback` to restore the prior state.",
        file=sys.stderr,
    )
    if result.backup is not None:
        print(f"  backup: {result.backup}", file=sys.stderr)
    return 1


def _cmd_rollback(args: argparse.Namespace) -> int:
    """Restore the prior state from the most-recent backup. Returns the exit code."""
    runtime_dir = _runtime_dir(args)
    backup = _latest_backup(runtime_dir)
    if backup is None:
        print(
            f"No migration backup found next to {runtime_dir} — nothing to roll back.",
            file=sys.stderr,
        )
        return 1
    rollback(backup, runtime_dir)
    print(f"Rolled back: restored {runtime_dir} from {backup}.")
    return 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="yulu migrate",
        description="Seamlessly migrate an existing v0.5.x ~/.yulu install (transactional).",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    pm = sub.add_parser(
        "migrate",
        help="detect->plan->apply->verify the migration (--dry-run prints the plan only)",
    )
    pm.add_argument(
        "--dry-run",
        action="store_true",
        help="print the planned corrections and exit WITHOUT applying anything",
    )
    pm.add_argument(
        "--runtime-dir",
        help="the ~/.yulu install tree to migrate (default: ~/.yulu)",
    )
    pm.add_argument(
        "--config-dir",
        help="the ~/.config/yulu config root (default: resolved via PathResolver)",
    )

    pr = sub.add_parser(
        "rollback",
        help="restore the prior state from the most-recent migration backup",
    )
    pr.add_argument(
        "--runtime-dir",
        help="the ~/.yulu install tree to roll back (default: ~/.yulu)",
    )

    return p


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "migrate":
        return _cmd_migrate(args)
    if args.cmd == "rollback":
        return _cmd_rollback(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
