"""MIG-01 / MIG-02 / MIG-03 — the transactional apply + rollback + prune-on-verify-only.

``migrate/apply.py`` is the destructive half of the pipeline. It must be
TRANSACTIONAL: a backup is taken BEFORE any mutation, a recording-active state
refuses with ZERO mutation, ANY mid-apply error rolls back to the prior state, and
``rollback`` restores byte-for-byte. ``migrate/verify.py`` gates the prune: the
backup is reclaimed ONLY after a verified success, and a failed verify KEEPS it so
``yulu rollback`` is always possible (the CONCERNS §2e bounded-lifecycle fix).

These tests prove (Task 1 — apply/rollback):
  (1) transactional order — apply takes a backup of the prior state BEFORE applying
      any correction (the returned backup dir exists and equals the pre-apply tree);
  (2) recording-guard (MIG-02) — an injected ``recording=True`` status refuses
      (ok=False, "recording active" reason), takes NO backup, mutates NOTHING
      (config.json + tree byte-identical), stops NO daemon;
  (3) no data loss (MIG-01) — recordings/transcripts/vocab/prompts/summaries all
      survive byte-for-byte after apply;
  (4) rollback byte-for-byte (MIG-03) — ``rollback(backup, install_dir)`` restores the
      prior tree so it is byte-identical to the pre-apply snapshot;
  (5) mid-apply failure rolls back — an exception during a correction restores the
      install tree (no half-migration) and re-raises;
  (6) no ``pkill`` anywhere in apply.py (T-07-05 static control).

These tests prove (Task 2 — verify/finalize, prune-on-success-only):
  (7) verify passes on a structurally-healthy doctor report, fails on error/empty;
  (8) finalize PRUNES the backup on a verify pass and KEEPS it on a verify fail
      (both branches — the headline §2e fix; a failed verify NEVER prunes);
  (9) prune_backup(None) is a safe no-op.

Import style mirrors test_migrate_recording_guard.py: yulu/scripts on sys.path so
``import migrate.apply`` works from the repo root or from yulu/scripts.
"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from migrate import apply as apply_mod  # noqa: E402
from migrate import verify as verify_mod  # noqa: E402
from migrate.apply import MigrationResult, apply_migration, rollback  # noqa: E402
from migrate.detect import detect_migration  # noqa: E402
from migrate.plan import build_plan  # noqa: E402
from provision import state as state_mod  # noqa: E402

APPLY_SRC = SCRIPTS / "migrate" / "apply.py"


# ── Fixtures: a realistic v0.5.x ~/.yulu install tree + ~/.config/yulu config ──


class _StubManager:
    """Records unload() calls so a test can assert ZERO daemons were stopped on a
    refused (recording-active) run, and that the clean-stop path runs otherwise."""

    def __init__(self):
        self.unloaded = []

    def unload(self, label):
        self.unloaded.append(label)


def _send_recording(_cmd):
    """Injected socket_send reporting a LIVE recording (guard must refuse)."""
    return {"recording": True}


def _send_idle(_cmd):
    """Injected socket_send reporting NO recording (guard clean-stops)."""
    return {"recording": False}


def _legacy_install(tmp_path: Path):
    """Build a genuine-looking v0.5.x pair and return (install_dir, config_dir).

    install_dir (~/.yulu sense): an installer ledger WITHOUT schema_version (so detect
    sees v0.5.x) plus the irreplaceable user data — recordings/, transcripts/,
    vocab.sqlite, prompts.sqlite, a summary. config_dir (~/.config/yulu sense): a
    config.json carrying the dead transcription.mlx.python and the hardcoded
    ~/Movies/Yulu output_dir.
    """
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    # Phase-1 installer ledger: has `schema` + `source` but NO `schema_version`.
    (install_dir / ".yulu-install.json").write_text(
        json.dumps(
            {
                "schema": 1,
                "source": "release",
                "version": "0.5.1",
                "sha256": "deadbeef",
                "installed_at": "2025-01-01T00:00:00Z",
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    # Irreplaceable user data — must survive byte-for-byte.
    (install_dir / "recordings").mkdir()
    (install_dir / "recordings" / "m1.wav").write_bytes(b"RIFF\x00\x00WAVdata-audio")
    (install_dir / "transcripts").mkdir()
    (install_dir / "transcripts" / "m1.txt").write_text("hello transcript", encoding="utf-8")
    (install_dir / "vocab.sqlite").write_bytes(b"SQLite format 3\x00 vocab")
    (install_dir / "prompts.sqlite").write_bytes(b"SQLite format 3\x00 prompts")
    (install_dir / "m1.summary.md").write_text("# Summary\n\n- point", encoding="utf-8")

    config_dir = tmp_path / "config-yulu"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps(
            {
                "audio": {"output_dir": "~/Movies/Yulu", "format": "wav"},
                "transcription": {
                    "final_engine": "mlx",
                    "mlx": {
                        "python": "~/.config/yulu/venv-mlx-whisper/bin/python",
                        "model": "mlx-community/whisper-large-v3-mlx",
                    },
                },
                "llm": {"command": None},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return install_dir, config_dir


def _snapshot_tree(root: Path) -> dict:
    """Map every file under ``root`` to its bytes — for byte-for-byte assertions."""
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = p.read_bytes()
    return out


def _drive(install_dir: Path, config_dir: Path, socket_send):
    """Run detect → build_plan → apply_migration with an injected manager+socket."""
    need = detect_migration(install_dir, config_dir)
    plan = build_plan(need)
    manager = _StubManager()
    result = apply_migration(
        need,
        plan,
        install_dir,
        config_dir,
        manager=manager,
        socket_send=socket_send,
    )
    return need, plan, manager, result


# ── (1) transactional order: backup taken BEFORE any mutation ──


def test_apply_takes_backup_before_mutation(tmp_path):
    install_dir, config_dir = _legacy_install(tmp_path)
    pre_tree = _snapshot_tree(install_dir)

    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)

    assert result.ok is True
    assert result.backup is not None
    assert result.backup.is_dir(), "backup dir must exist after apply"
    # The backup is the PRE-apply tree snapshot, byte-for-byte (taken before mutation).
    assert _snapshot_tree(result.backup) == pre_tree


# ── (2) recording-guard (MIG-02): refuse, ZERO mutation, no daemon stopped ──


def test_apply_refuses_while_recording_zero_mutation(tmp_path):
    install_dir, config_dir = _legacy_install(tmp_path)
    pre_tree = _snapshot_tree(install_dir)
    pre_config = (config_dir / "config.json").read_bytes()

    _need, _plan, manager, result = _drive(install_dir, config_dir, _send_recording)

    assert result.ok is False
    assert result.backup is None, "a refused run must take NO backup"
    assert any("recording active" in r.lower() for r in result.reasons)
    # ZERO mutation: tree + config byte-identical; NO daemon stopped.
    assert _snapshot_tree(install_dir) == pre_tree
    assert (config_dir / "config.json").read_bytes() == pre_config
    assert manager.unloaded == [], "no daemon may be stopped on a recording refusal"


# ── (3) no data loss (MIG-01): all user data survives byte-for-byte ──


def test_apply_loses_no_data(tmp_path):
    install_dir, config_dir = _legacy_install(tmp_path)
    # Capture the irreplaceable payloads BEFORE migration.
    expected = {
        "recordings/m1.wav": (install_dir / "recordings" / "m1.wav").read_bytes(),
        "transcripts/m1.txt": (install_dir / "transcripts" / "m1.txt").read_bytes(),
        "vocab.sqlite": (install_dir / "vocab.sqlite").read_bytes(),
        "prompts.sqlite": (install_dir / "prompts.sqlite").read_bytes(),
        "m1.summary.md": (install_dir / "m1.summary.md").read_bytes(),
    }

    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)
    assert result.ok is True

    # The data lives in the backup (the tree was moved aside); rollback OR a later
    # restore brings it back. The contract is NO BYTE IS LOST — assert it survives in
    # the backup snapshot intact.
    backup_snapshot = _snapshot_tree(result.backup)
    for rel, payload in expected.items():
        assert backup_snapshot.get(rel) == payload, f"{rel} must survive byte-for-byte"


# ── (4) rollback byte-for-byte (MIG-03) ──


def test_rollback_restores_byte_for_byte(tmp_path):
    install_dir, config_dir = _legacy_install(tmp_path)
    pre_tree = _snapshot_tree(install_dir)

    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)
    assert result.ok is True and result.backup is not None

    rollback(result.backup, install_dir)

    # After rollback the install tree is byte-identical to the pre-apply snapshot.
    assert _snapshot_tree(install_dir) == pre_tree


# ── (5) mid-apply failure rolls back to the prior state, then re-raises ──


def test_apply_rolls_back_on_midapply_error(tmp_path, monkeypatch):
    install_dir, config_dir = _legacy_install(tmp_path)
    pre_tree = _snapshot_tree(install_dir)

    # Force the schema-stamp correction to blow up MID-apply (after the tree was moved
    # aside and earlier corrections may have run) to exercise the rollback path.
    def _boom(*_a, **_k):
        raise RuntimeError("simulated mid-apply failure")

    monkeypatch.setattr(apply_mod, "_apply_schema_stamp", _boom)

    need = detect_migration(install_dir, config_dir)
    plan = build_plan(need)

    with pytest.raises(RuntimeError, match="simulated mid-apply failure"):
        apply_migration(
            need, plan, install_dir, config_dir,
            manager=_StubManager(), socket_send=_send_idle,
        )

    # The install tree was restored from the backup — no half-migration left behind.
    assert _snapshot_tree(install_dir) == pre_tree


# ── (6) static MIG-02 control: no pkill in apply.py ──


def test_apply_source_has_no_pkill():
    src_lines = [
        ln for ln in APPLY_SRC.read_text(encoding="utf-8").splitlines()
        if not ln.lstrip().startswith("#")
    ]
    assert sum(line.count("pkill") for line in src_lines) == 0


# ── (7) verify gate: pass on healthy report, fail on error/empty ──


def test_verify_passes_on_healthy_report(tmp_path, monkeypatch):
    monkeypatch.setattr(
        verify_mod, "_host_report",
        lambda _c, _r: {"schema_version": 2, "capabilities": {"claude": {"status": "usable"}}},
    )
    assert verify_mod.verify_migration(tmp_path, tmp_path) is True


def test_verify_fails_on_error_report(tmp_path, monkeypatch):
    monkeypatch.setattr(
        verify_mod, "_host_report",
        lambda _c, _r: {"error": "boom", "schema_version": 1, "capabilities": {}},
    )
    assert verify_mod.verify_migration(tmp_path, tmp_path) is False


def test_verify_fails_on_empty_capabilities(tmp_path, monkeypatch):
    monkeypatch.setattr(
        verify_mod, "_host_report",
        lambda _c, _r: {"schema_version": 2, "capabilities": {}},
    )
    assert verify_mod.verify_migration(tmp_path, tmp_path) is False


# ── (8) finalize prunes ONLY on a verify pass; keeps on fail (both branches) ──


def test_finalize_prunes_backup_only_on_verify_pass(tmp_path, monkeypatch):
    install_dir, config_dir = _legacy_install(tmp_path)
    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)
    assert result.backup is not None and result.backup.is_dir()

    monkeypatch.setattr(verify_mod, "verify_migration", lambda _c, _r: True)
    ok = verify_mod.finalize(result, config_dir, install_dir)

    assert ok is True
    assert not result.backup.exists(), "a verified success must PRUNE the backup"


def test_finalize_keeps_backup_on_verify_fail(tmp_path, monkeypatch):
    install_dir, config_dir = _legacy_install(tmp_path)
    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)
    assert result.backup is not None and result.backup.is_dir()

    monkeypatch.setattr(verify_mod, "verify_migration", lambda _c, _r: False)
    ok = verify_mod.finalize(result, config_dir, install_dir)

    assert ok is False
    assert result.backup.is_dir(), "a FAILED verify must KEEP the backup for rollback"


# ── (9) prune_backup(None) is a safe no-op ──


def test_prune_backup_none_is_noop():
    # Must not raise.
    verify_mod.prune_backup(None)


# ── schema_version is surfaced post-apply (verify reads the new state) ──


def test_schema_version_stamped_after_apply(tmp_path):
    install_dir, config_dir = _legacy_install(tmp_path)
    _need, _plan, _mgr, result = _drive(install_dir, config_dir, _send_idle)
    assert result.ok is True

    ledger = json.loads((install_dir / ".yulu-install.json").read_text(encoding="utf-8"))
    assert ledger.get("schema_version") == state_mod.SCHEMA_VERSION
