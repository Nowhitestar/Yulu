"""voicemail→meeting data migration (migrate/voicemail_unify.py).

All tests operate on pytest tmp_path ONLY — never the real ~/Movies/Yulu.
Coverage: dry-run mutates nothing; every sibling variant (chunk/mic/sys/
realtime files + .summary.html + a .realtime dir) survives the move with the
voicemail_* → Memo_* rename; re-running is a no-op; collisions skip without
touching the source; the cross-device (EXDEV) fallback verifies size before
unlinking; the empty voicemails/ dir is removed.
"""

import errno
import os
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from migrate import voicemail_unify as vu


# ── fixtures ───────────────────────────────────────────────────────────

STEM = "voicemail_20260602_160113"
NEW_STEM = "Memo_20260602_160113"

# The full sibling spread a real recording can have (no fixed whitelist in
# the migrator — it enumerates by prefix).
SIBLING_SUFFIXES = [
    ".wav",
    ".chunk-000.wav",
    ".chunk-001.wav",
    ".raw",
    ".mic",
    ".sys",
    ".transcript.txt",
    ".raw.transcript.txt",
    ".realtime.transcript.txt",
    ".realtime.coverage.json",
    ".title",
    ".summary.md",
    ".summary.html",
    ".action-items.summary.md",
    ".lock",
]


def _make_voicemail(vm_dir: Path, stem: str = STEM) -> dict[str, bytes]:
    """Create a voicemail recording with every sibling suffix + a .realtime
    directory. Returns {filename: contents} for later verification."""
    vm_dir.mkdir(parents=True, exist_ok=True)
    written: dict[str, bytes] = {}
    for suffix in SIBLING_SUFFIXES:
        name = f"{stem}{suffix}"
        body = f"contents-of-{name}".encode("utf-8")
        (vm_dir / name).write_bytes(body)
        written[name] = body
    # A directory sibling (defensive: <stem>.realtime/ with a child).
    rt_dir = vm_dir / f"{stem}.realtime"
    rt_dir.mkdir()
    (rt_dir / "partial.json").write_bytes(b"partial-data")
    return written


# ── dry-run ────────────────────────────────────────────────────────────

def test_dry_run_mutates_nothing(tmp_path, capsys):
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    written = _make_voicemail(vm_dir)
    before = sorted(p.name for p in vm_dir.iterdir())

    rc = vu.unify(data_dir, dry_run=True, do_sweep=False)
    assert rc == 0

    # Source dir untouched; nothing appeared at the root.
    assert sorted(p.name for p in vm_dir.iterdir()) == before
    root_files = [p.name for p in data_dir.iterdir() if p.name != "voicemails"]
    assert root_files == []
    out = capsys.readouterr().out
    assert "dry-run" in out
    assert NEW_STEM in out


# ── apply: full sibling survival + rename ──────────────────────────────

def test_apply_moves_all_siblings_with_rename(tmp_path):
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    written = _make_voicemail(vm_dir)

    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0

    # Every sibling now lives at root under the Memo_ stem with identical bytes.
    for name, body in written.items():
        new_name = name.replace("voicemail_", "Memo_", 1)
        dst = data_dir / new_name
        assert dst.exists(), f"missing migrated file {new_name}"
        assert dst.read_bytes() == body
        # Original gone.
        assert not (vm_dir / name).exists()

    # The .realtime directory moved too, with its child.
    moved_rt = data_dir / f"{NEW_STEM}.realtime"
    assert moved_rt.is_dir()
    assert (moved_rt / "partial.json").read_bytes() == b"partial-data"

    # voicemails/ removed once empty.
    assert not vm_dir.exists()


def test_html_sidecar_survives(tmp_path):
    data_dir = tmp_path / "Yulu"
    _make_voicemail(data_dir / "voicemails")
    vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert (data_dir / f"{NEW_STEM}.summary.html").exists()


# ── idempotency ────────────────────────────────────────────────────────

def test_second_run_is_noop(tmp_path):
    data_dir = tmp_path / "Yulu"
    _make_voicemail(data_dir / "voicemails")
    vu.unify(data_dir, dry_run=False, do_sweep=False)
    root_after_first = sorted(p.name for p in data_dir.iterdir())

    # Re-run — voicemails/ is gone, so build_plan finds nothing.
    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0
    assert sorted(p.name for p in data_dir.iterdir()) == root_after_first


def test_absent_voicemails_dir_is_noop(tmp_path):
    data_dir = tmp_path / "Yulu"
    data_dir.mkdir()
    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0
    assert list(data_dir.iterdir()) == []


def test_empty_voicemails_dir_removed(tmp_path):
    data_dir = tmp_path / "Yulu"
    (data_dir / "voicemails").mkdir(parents=True)
    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0
    # Nothing to move, but an empty voicemails/ is tidied away.
    assert not (data_dir / "voicemails").exists()


# ── collision safety ───────────────────────────────────────────────────

def test_collision_skips_recording_and_leaves_source(tmp_path):
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    written = _make_voicemail(vm_dir)

    # Pre-create a colliding destination at root (e.g. a prior partial run).
    data_dir.mkdir(exist_ok=True)
    collide = data_dir / f"{NEW_STEM}.wav"
    collide.write_bytes(b"PRE-EXISTING-DO-NOT-CLOBBER")

    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0

    # The colliding destination is untouched.
    assert collide.read_bytes() == b"PRE-EXISTING-DO-NOT-CLOBBER"
    # The whole recording was skipped → ALL source siblings remain in place.
    for name in written:
        assert (vm_dir / name).exists(), f"{name} should not have moved on collision"
    # voicemails/ is NOT removed (it still holds the skipped recording).
    assert vm_dir.exists()


def test_apply_plan_reports_skipped(tmp_path):
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    _make_voicemail(vm_dir)
    data_dir.mkdir(exist_ok=True)
    (data_dir / f"{NEW_STEM}.wav").write_bytes(b"x")

    plan = vu.build_plan(data_dir)
    assert len(plan.skipped_recordings) == 1
    assert len(plan.moved_recordings) == 0
    result = vu.apply_plan(plan)
    assert result.skipped_recordings == 1
    assert result.moved_recordings == 0


def test_rerun_completes_a_partially_moved_recording(tmp_path):
    """Regression for the orphan-sidecar gap: if a prior apply moved the .wav to
    root (Memo_*.wav) but stranded some siblings in voicemails/ (e.g. an I/O error
    mid-move), a re-run must DISCOVER the recording via a stranded sibling — not only
    by its now-absent .wav — and complete the move instead of abandoning them."""
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    vm_dir.mkdir(parents=True)
    # Partial-failure layout: .wav already moved to root; two siblings stranded.
    (data_dir / f"{NEW_STEM}.wav").write_bytes(b"already-moved-wav")
    (vm_dir / f"{STEM}.transcript.txt").write_bytes(b"stranded-transcript")
    (vm_dir / f"{STEM}.summary.md").write_bytes(b"stranded-summary")

    plan = vu.build_plan(data_dir)
    # Discovered via the stranded siblings (the .wav is gone) — no false collision
    # against the already-moved Memo_*.wav (that name isn't a sibling here).
    assert len(plan.moved_recordings) == 1
    assert plan.moved_recordings[0].stem == STEM
    assert {mv.src.name for mv in plan.moved_recordings[0].moves} == {
        f"{STEM}.transcript.txt",
        f"{STEM}.summary.md",
    }

    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0
    # Stranded siblings completed at root; the already-moved .wav left untouched.
    assert (data_dir / f"{NEW_STEM}.transcript.txt").read_bytes() == b"stranded-transcript"
    assert (data_dir / f"{NEW_STEM}.summary.md").read_bytes() == b"stranded-summary"
    assert (data_dir / f"{NEW_STEM}.wav").read_bytes() == b"already-moved-wav"
    assert not (vm_dir / f"{STEM}.transcript.txt").exists()
    assert not (vm_dir / f"{STEM}.summary.md").exists()


# ── cross-device (EXDEV) fallback ──────────────────────────────────────

def test_exdev_fallback_copies_and_verifies(tmp_path, monkeypatch):
    """When os.rename raises EXDEV, _move_one must copy → verify size → unlink
    the source so we never end up with a half-moved file."""
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    written = _make_voicemail(vm_dir)

    real_rename = os.rename

    def fake_rename(src, dst):
        raise OSError(errno.EXDEV, "Cross-device link")

    monkeypatch.setattr(vu.os, "rename", fake_rename)

    rc = vu.unify(data_dir, dry_run=False, do_sweep=False)
    assert rc == 0

    for name, body in written.items():
        new_name = name.replace("voicemail_", "Memo_", 1)
        dst = data_dir / new_name
        assert dst.read_bytes() == body
        assert not (vm_dir / name).exists()


def test_exdev_size_mismatch_leaves_source_intact(tmp_path, monkeypatch):
    """If the cross-device copy lands a truncated file, the source MUST be
    left intact (no data loss) and the error surfaced."""
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    vm_dir.mkdir(parents=True)
    src = vm_dir / f"{STEM}.wav"
    src.write_bytes(b"the-full-original-bytes")

    def fake_rename(s, d):
        raise OSError(errno.EXDEV, "Cross-device link")

    def truncated_copyfile(s, d):
        Path(d).write_bytes(b"trunc")   # wrong size on purpose

    monkeypatch.setattr(vu.os, "rename", fake_rename)
    monkeypatch.setattr(vu.shutil, "copyfile", truncated_copyfile)

    plan = vu.build_plan(data_dir)
    result = vu.apply_plan(plan)

    # The source is still there with its original bytes.
    assert src.read_bytes() == b"the-full-original-bytes"
    assert result.errors, "a size mismatch must be reported as an error"
    assert any("size mismatch" in e for e in result.errors)


# ── stem matching ──────────────────────────────────────────────────────

def test_non_voicemail_stems_ignored(tmp_path):
    """Only voicemail_<ts> recordings are migrated; a meeting WAV that somehow
    sits in voicemails/ (non-matching stem) is left alone."""
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    vm_dir.mkdir(parents=True)
    (vm_dir / "Standup_20260602_160113.wav").write_bytes(b"meeting")
    (vm_dir / f"{STEM}.wav").write_bytes(b"memo")

    vu.unify(data_dir, dry_run=False, do_sweep=False)

    # The memo migrated; the non-voicemail stem stayed put.
    assert (data_dir / f"{NEW_STEM}.wav").exists()
    assert (vm_dir / "Standup_20260602_160113.wav").exists()
    # voicemails/ survives because it still holds the unmatched file.
    assert vm_dir.exists()


def test_prefix_match_does_not_overreach(tmp_path):
    """A sibling enumerated for stem X must not accidentally grab files for a
    longer stem that merely shares X as a prefix."""
    data_dir = tmp_path / "Yulu"
    vm_dir = data_dir / "voicemails"
    vm_dir.mkdir(parents=True)
    # Two distinct recordings whose stems share a prefix is impossible with the
    # fixed-width ts format, so assert the trailing-dot boundary directly.
    sibs = vu._iter_sibling_entries(
        _seed_two(vm_dir), STEM
    )
    names = sorted(p.name for p in sibs)
    assert f"{STEM}.wav" in names
    assert f"{STEM}.transcript.txt" in names
    # The decoy (extra digits, no dot boundary) must NOT be captured.
    assert not any("DECOY" in n for n in names)


def _seed_two(vm_dir: Path) -> Path:
    (vm_dir / f"{STEM}.wav").write_bytes(b"a")
    (vm_dir / f"{STEM}.transcript.txt").write_bytes(b"b")
    # Decoy: same prefix but extra digits and NO dot boundary after STEM.
    (vm_dir / f"{STEM}9999_DECOY.wav").write_bytes(b"c")
    return vm_dir
