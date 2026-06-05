#!/usr/bin/env python3
"""Unify legacy voicemail recordings into the meetings store.

Voicemails used to live as ``voicemail_YYYYMMDD_HHMMSS.*`` files in a separate
``<data_dir>/voicemails/`` subdirectory. The voicemail concept was removed —
every recording is now a meeting — so this one-shot migration MERGES those
recordings into the single root recordings directory and renames the stem from
``voicemail_<ts>`` to ``Memo_<ts>``.

Design (matches the very real risk of moving 1 GB WAVs that may be on iCloud):

  * Per recording, enumerate ALL siblings by *prefix* — every entry named
    ``<oldstem>.wav`` or starting with ``<oldstem>.`` (``.chunk-*.wav`` /
    ``.raw`` / ``.mic`` / ``.sys`` / ``.realtime.*`` / a ``.realtime`` dir /
    ``.transcript.txt`` / ``.summary.md`` + ``.summary.html`` / ``.title`` /
    ``.lock`` …). No fixed whitelist — user data has chunk + mic/sys variants.
  * Move each sibling to the root dir renamed ``<newstem><suffix>``. Prefer an
    atomic ``os.rename``; on a cross-device link error (EXDEV — the iCloud /
    different-volume case) fall back to copy → fsync → verify size → unlink the
    source (never a half-moved 1 GB WAV).
  * Collision-safe: a destination that already exists is NEVER overwritten —
    that recording is skipped (and reported) so a partial earlier run or a
    name clash can't destroy data.
  * Idempotent: an empty/absent ``voicemails/`` is a no-op; the (now empty)
    ``voicemails/`` dir is removed at the end.
  * ``--dry-run`` is the safe default: it prints the plan and mutates NOTHING.

After moving files, callers should run a single search-index sweep
(``search.reader.sweep``) so the stale ``voicemails/`` rows are reconciled away
and the new root ``Memo_*`` files re-index as meetings — see ``run_sweep``.

stdlib only (``argparse`` / ``os`` / ``shutil`` / ``pathlib`` / ``re`` / ``sys``).
"""

from __future__ import annotations

import argparse
import errno
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

# A legacy voicemail stem: voicemail_YYYYMMDD_HHMMSS
_VOICEMAIL_STEM_RE = re.compile(r"^voicemail_(\d{8})_(\d{6})$")
_OLD_PREFIX = "voicemail_"
_NEW_PREFIX = "Memo_"
_VOICEMAILS_SUBDIR = "voicemails"


def _default_data_dir() -> Path:
    """Resolve the recordings root the same way the rest of the tree does:
    config.json's ``audio.output_dir`` → PathResolver default → ~/Movies/Yulu.
    """
    # Prefer the configured output_dir (what record_audio / the daemon use).
    try:
        import json

        cfg = json.loads(
            (Path.home() / ".config" / "yulu" / "config.json").read_text(
                encoding="utf-8"
            )
        )
        raw = (cfg.get("audio") or {}).get("output_dir")
        if raw:
            return Path(os.path.expanduser(raw))
    except Exception:
        pass
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return Path(MacOSPathResolver().data_dir())
    except Exception:
        return Path.home() / "Movies" / "Yulu"


def _new_name(old_name: str) -> str:
    """Rewrite a single entry's leading ``voicemail_`` to ``Memo_``.

    Operates on the *name* (not the full stem) so it works for every sibling
    suffix uniformly: ``voicemail_X.wav`` → ``Memo_X.wav``,
    ``voicemail_X.realtime.transcript.txt`` → ``Memo_X.realtime.transcript.txt``.
    """
    if old_name.startswith(_OLD_PREFIX):
        return _NEW_PREFIX + old_name[len(_OLD_PREFIX):]
    return old_name


@dataclass
class Move:
    src: Path
    dst: Path


@dataclass
class RecordingPlan:
    """All sibling moves for one ``voicemail_<ts>`` recording."""
    stem: str
    moves: list[Move] = field(default_factory=list)
    # Set when at least one destination already exists → the whole recording
    # is skipped (collision-safe; we never partially merge a recording).
    collision: Optional[Path] = None


@dataclass
class UnifyPlan:
    data_dir: Path
    voicemails_dir: Path
    recordings: list[RecordingPlan] = field(default_factory=list)

    @property
    def moved_recordings(self) -> list[RecordingPlan]:
        return [r for r in self.recordings if r.collision is None]

    @property
    def skipped_recordings(self) -> list[RecordingPlan]:
        return [r for r in self.recordings if r.collision is not None]

    @property
    def total_files(self) -> int:
        return sum(len(r.moves) for r in self.moved_recordings)

    def render(self) -> str:
        if not self.recordings:
            return "  (no legacy voicemails to migrate)"
        lines: list[str] = []
        for rec in self.recordings:
            new_stem = _new_name(rec.stem)
            if rec.collision is not None:
                lines.append(
                    f"  SKIP {rec.stem} → {new_stem} "
                    f"(destination exists: {rec.collision.name})"
                )
                continue
            lines.append(f"  MOVE {rec.stem} → {new_stem} ({len(rec.moves)} file(s))")
            for mv in rec.moves:
                lines.append(f"        {mv.src.name}  →  {mv.dst}")
        return "\n".join(lines)


def _iter_sibling_entries(directory: Path, stem: str) -> list[Path]:
    """Every entry in ``directory`` belonging to ``stem`` — the bare
    ``<stem>.wav`` plus anything starting with ``<stem>.`` (files AND dirs).

    Prefix-with-trailing-dot avoids ``voicemail_…113`` also matching
    ``voicemail_…1130`` siblings.
    """
    dot_prefix = stem + "."
    out: list[Path] = []
    try:
        entries = sorted(directory.iterdir(), key=lambda p: p.name)
    except OSError:
        return out
    for entry in entries:
        name = entry.name
        if name == f"{stem}.wav" or name.startswith(dot_prefix):
            out.append(entry)
    return out


def build_plan(data_dir: Path) -> UnifyPlan:
    """Scan ``<data_dir>/voicemails`` and build the (mutation-free) move plan.

    Every recording's destination is checked for collision against the root
    ``data_dir`` up-front, so a dry-run faithfully shows what an apply would do.
    """
    data_dir = Path(data_dir)
    vm_dir = data_dir / _VOICEMAILS_SUBDIR
    plan = UnifyPlan(data_dir=data_dir, voicemails_dir=vm_dir)
    if not vm_dir.is_dir():
        return plan

    # Identify recordings by their WAV; sort for a stable, oldest-first plan.
    stems: list[str] = []
    try:
        for child in sorted(vm_dir.iterdir(), key=lambda p: p.name):
            if child.is_file() and child.suffix == ".wav":
                stem = child.stem
                if _VOICEMAIL_STEM_RE.match(stem):
                    stems.append(stem)
    except OSError:
        return plan

    for stem in stems:
        rec = RecordingPlan(stem=stem)
        for src in _iter_sibling_entries(vm_dir, stem):
            dst = data_dir / _new_name(src.name)
            if dst.exists():
                rec.collision = dst
                break
            rec.moves.append(Move(src=src, dst=dst))
        plan.recordings.append(rec)
    return plan


def _move_one(src: Path, dst: Path) -> None:
    """Move ``src`` → ``dst``, never overwriting. Atomic rename when possible;
    on EXDEV (cross-volume — e.g. an iCloud-evicted file on another mount)
    fall back to a verified copy: copy → fsync → size-check → unlink source.

    Refuses to clobber an existing ``dst`` (defensive: the planner already
    skips collisions, but this is the last line of defence for a TOCTOU).
    """
    if dst.exists():
        raise FileExistsError(f"refusing to overwrite existing destination: {dst}")
    try:
        os.rename(src, dst)
        return
    except OSError as exc:
        if exc.errno != errno.EXDEV:
            raise

    # Cross-device: copy then verify then unlink. Directories recurse.
    if src.is_dir():
        shutil.copytree(src, dst)
        # Best-effort fsync of the new tree's files.
        for root, _dirs, files in os.walk(dst):
            for fname in files:
                _fsync_file(Path(root) / fname)
        if not dst.is_dir():
            raise OSError(f"cross-device copy of dir {src} → {dst} failed verification")
        shutil.rmtree(src)
        return

    src_size = src.stat().st_size
    shutil.copyfile(src, dst)
    _fsync_file(dst)
    # Verify the bytes landed before we delete the only copy.
    if dst.stat().st_size != src_size:
        # Leave both copies in place; surface the failure loudly.
        raise OSError(
            f"cross-device copy size mismatch for {src} → {dst} "
            f"({dst.stat().st_size} != {src_size}); source left intact"
        )
    os.unlink(src)


def _fsync_file(path: Path) -> None:
    try:
        fd = os.open(str(path), os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError:
        # fsync is a durability nicety; never fail the migration over it.
        pass


@dataclass
class UnifyResult:
    moved_recordings: int = 0
    moved_files: int = 0
    skipped_recordings: int = 0
    errors: list[str] = field(default_factory=list)
    removed_voicemails_dir: bool = False


def apply_plan(plan: UnifyPlan) -> UnifyResult:
    """Execute ``plan``. Mutates the filesystem. Collision recordings are left
    untouched. Removes the ``voicemails/`` dir only when it's empty afterward."""
    result = UnifyResult(skipped_recordings=len(plan.skipped_recordings))
    for rec in plan.moved_recordings:
        rec_files = 0
        for mv in rec.moves:
            try:
                _move_one(mv.src, mv.dst)
                rec_files += 1
            except OSError as exc:
                result.errors.append(f"{mv.src} → {mv.dst}: {exc}")
        if rec_files:
            result.moved_files += rec_files
        if rec_files == len(rec.moves):
            result.moved_recordings += 1

    # Remove voicemails/ only if it's now empty (don't clobber leftovers /
    # collision survivors).
    vm_dir = plan.voicemails_dir
    if vm_dir.is_dir():
        try:
            next(vm_dir.iterdir())
        except StopIteration:
            try:
                vm_dir.rmdir()
                result.removed_voicemails_dir = True
            except OSError as exc:
                result.errors.append(f"rmdir {vm_dir}: {exc}")
        except OSError:
            pass
    return result


def run_sweep() -> Optional[dict]:
    """Run one search-index sweep so moved files re-index as meetings and the
    stale voicemails/ rows are reconciled away. Best-effort: a missing search
    module / DB must never fail the migration. Returns the sweep counts or
    None when the sweep couldn't run."""
    try:
        from search import reader as _search_reader

        return _search_reader.sweep()
    except Exception as exc:  # pragma: no cover - defensive
        print(f"⚠️ search sweep skipped: {exc}", file=sys.stderr)
        return None


def unify(data_dir: Path, *, dry_run: bool, do_sweep: bool = True) -> int:
    """Top-level entry point. Returns a process exit code (0 = ok)."""
    plan = build_plan(data_dir)

    if dry_run:
        print("Planned voicemail→meeting unification (dry-run — nothing applied):")
        print(plan.render())
        n = len(plan.moved_recordings)
        s = len(plan.skipped_recordings)
        print(f"\nWould move {n} recording(s) ({plan.total_files} file(s)); "
              f"skip {s} on collision.")
        return 0

    if not plan.recordings:
        # Nothing to move — but still tidy an empty voicemails/ dir if present
        # (apply_plan handles the no-move case and removes the empty dir).
        result = apply_plan(plan)
        if result.removed_voicemails_dir:
            print(f"Removed empty {plan.voicemails_dir}.")
        else:
            print("No legacy voicemails to migrate — nothing to do.")
        return 0

    result = apply_plan(plan)
    print(
        f"Unified {result.moved_recordings} recording(s) "
        f"({result.moved_files} file(s)) into {plan.data_dir}."
    )
    if result.skipped_recordings:
        print(f"Skipped {result.skipped_recordings} recording(s) due to name "
              f"collisions (left untouched).")
    if result.removed_voicemails_dir:
        print(f"Removed empty {plan.voicemails_dir}.")
    for err in result.errors:
        print(f"⚠️ {err}", file=sys.stderr)

    if do_sweep and result.moved_files:
        counts = run_sweep()
        if counts is not None:
            print(
                "Search index swept: "
                f"+{counts.get('added', 0)} ~{counts.get('updated', 0)} "
                f"-{counts.get('removed', 0)}."
            )

    return 1 if result.errors else 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="yulu migrate unify-voicemails",
        description="Merge legacy voicemail recordings into the meetings store "
                    "(voicemail_* → Memo_*).",
    )
    p.add_argument(
        "--dry-run",
        dest="dry_run",
        action="store_true",
        default=True,
        help="print the planned moves and exit WITHOUT touching any files (default)",
    )
    p.add_argument(
        "--apply",
        dest="dry_run",
        action="store_false",
        help="actually perform the migration (move + rename the files)",
    )
    p.add_argument(
        "--data-dir",
        dest="data_dir",
        default=None,
        help="recordings root (default: config.json audio.output_dir → ~/Movies/Yulu)",
    )
    p.add_argument(
        "--no-sweep",
        dest="do_sweep",
        action="store_false",
        help="skip the post-migration search-index sweep",
    )
    return p


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    args = _build_parser().parse_args(argv)
    data_dir = Path(args.data_dir) if args.data_dir else _default_data_dir()
    return unify(data_dir, dry_run=args.dry_run, do_sweep=args.do_sweep)


if __name__ == "__main__":
    sys.exit(main())
