"""MIG-01 / MIG-03 / D-05 — the ``yulu migrate`` / ``yulu rollback`` CLI driver.

``migrate/cli.py`` composes the four pipeline stages (detect → plan → apply →
verify) behind ``yulu migrate`` + ``yulu rollback``. These tests prove the driver's
control flow WITHOUT re-testing the stages themselves (covered by
test_migrate_apply_rollback.py / test_migrate_corrections.py):

  (1) up-to-date install   → "up-to-date" + exit 0, ZERO mutation (no apply runs);
  (2) --dry-run            → prints the plan, exit 0, mutates NOTHING (no apply, no
                             daemon stop) — the ledger/config are byte-identical;
  (3) a successful migrate → finalize prunes the backup, exit 0;
  (4) a FAILED verify      → "backup retained; run `yulu rollback`", exit non-zero,
                             the backup is KEPT (never pruned on a failed verify);
  (5) a recording-active refusal → exit non-zero, ZERO mutation;
  (6) rollback with no backup    → clear message + exit non-zero;
  (7) rollback restores from the most-recent backup → exit 0, tree byte-for-byte.

Import style mirrors test_migrate_recording_guard.py. The doctor/daemon stack is
never reached: apply's guard takes an injected socket via monkeypatching the CLI's
``apply_migration`` indirection is unnecessary — instead we monkeypatch the verify
gate and (for refusal) the apply call, exactly at the seams the CLI calls.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from migrate import cli as cli_mod  # noqa: E402
from migrate import verify as verify_mod  # noqa: E402
from migrate.apply import MigrationResult  # noqa: E402


def _legacy_pair(tmp_path: Path):
    """A v0.5.x install dir (ledger sans schema_version + data) + a config dir."""
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "source": "release", "version": "0.5.1"}, indent=2) + "\n",
        encoding="utf-8",
    )
    (install_dir / "recordings").mkdir()
    (install_dir / "recordings" / "m.wav").write_bytes(b"audio-bytes")
    config_dir = tmp_path / "cfg"
    config_dir.mkdir()
    (config_dir / "config.json").write_text(
        json.dumps(
            {
                "audio": {"output_dir": "~/Movies/Yulu"},
                "transcription": {"mlx": {"python": "/dead", "model": "m"}},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    return install_dir, config_dir


def _uptodate_pair(tmp_path: Path):
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()
    (install_dir / ".yulu-install.json").write_text(
        json.dumps({"schema": 1, "schema_version": 2, "source": "release"}, indent=2) + "\n",
        encoding="utf-8",
    )
    config_dir = tmp_path / "cfg"
    config_dir.mkdir()
    return install_dir, config_dir


def _snapshot(root: Path) -> dict:
    out = {}
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out[str(p.relative_to(root))] = p.read_bytes()
    return out


# ── (1) up-to-date → no-op, exit 0, zero mutation ──


def test_migrate_uptodate_is_noop(tmp_path, capsys):
    install_dir, config_dir = _uptodate_pair(tmp_path)
    pre = _snapshot(install_dir)

    rc = cli_mod.main(["migrate", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)])

    assert rc == 0
    assert "up-to-date" in capsys.readouterr().out
    assert _snapshot(install_dir) == pre  # nothing mutated


# ── (2) --dry-run → prints plan, exit 0, zero mutation ──


def test_migrate_dry_run_mutates_nothing(tmp_path, capsys):
    install_dir, config_dir = _legacy_pair(tmp_path)
    pre_tree = _snapshot(install_dir)
    pre_cfg = (config_dir / "config.json").read_bytes()

    rc = cli_mod.main(
        ["migrate", "--dry-run", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)]
    )

    out = capsys.readouterr().out
    assert rc == 0
    assert "dry-run" in out
    assert "drop_mlx_python" in out and "stamp_schema_version" in out
    # ZERO mutation: tree + config byte-identical, NO backup created.
    assert _snapshot(install_dir) == pre_tree
    assert (config_dir / "config.json").read_bytes() == pre_cfg
    assert cli_mod._latest_backup(install_dir) is None


# ── (3) successful migrate → backup pruned, exit 0 ──


def test_migrate_success_prunes_backup(tmp_path, monkeypatch, capsys):
    install_dir, config_dir = _legacy_pair(tmp_path)
    # Inject "no recording" so apply's guard clean-stops via a stub manager, and force
    # verify to PASS (the real doctor stack is out of scope for the CLI control-flow test).
    monkeypatch.setattr(cli_mod, "apply_migration", _patched_apply(monkeypatch, recording=False))
    monkeypatch.setattr(verify_mod, "verify_migration", lambda _c, _r: True)

    rc = cli_mod.main(["migrate", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)])

    out = capsys.readouterr().out
    assert rc == 0
    assert "verified" in out.lower()
    assert "pruned" in out.lower()
    assert cli_mod._latest_backup(install_dir) is None  # backup gone


# ── (4) failed verify → backup retained, exit non-zero, points at rollback ──


def test_migrate_failed_verify_retains_backup(tmp_path, monkeypatch, capsys):
    install_dir, config_dir = _legacy_pair(tmp_path)
    monkeypatch.setattr(cli_mod, "apply_migration", _patched_apply(monkeypatch, recording=False))
    monkeypatch.setattr(verify_mod, "verify_migration", lambda _c, _r: False)

    rc = cli_mod.main(["migrate", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)])

    err = capsys.readouterr().err
    assert rc == 1
    assert "rollback" in err.lower()
    assert "retained" in err.lower()
    # The backup MUST still exist (a failed verify never prunes).
    assert cli_mod._latest_backup(install_dir) is not None


# ── (5) recording-active refusal → exit non-zero, zero mutation ──


def test_migrate_recording_refusal_nonzero(tmp_path, monkeypatch, capsys):
    install_dir, config_dir = _legacy_pair(tmp_path)
    pre_tree = _snapshot(install_dir)
    monkeypatch.setattr(cli_mod, "apply_migration", _patched_apply(monkeypatch, recording=True))

    rc = cli_mod.main(["migrate", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)])

    err = capsys.readouterr().err
    assert rc == 1
    assert "recording active" in err.lower()
    assert _snapshot(install_dir) == pre_tree  # nothing mutated
    assert cli_mod._latest_backup(install_dir) is None


# ── (6) rollback with no backup → clear msg + exit non-zero ──


def test_rollback_no_backup_nonzero(tmp_path, capsys):
    install_dir = tmp_path / "dot-yulu"
    install_dir.mkdir()

    rc = cli_mod.main(["rollback", "--runtime-dir", str(install_dir)])

    assert rc == 1
    assert "nothing to roll back" in capsys.readouterr().err.lower()


# ── (7) rollback restores from the most-recent backup, byte-for-byte ──


def test_rollback_restores_latest_backup(tmp_path, monkeypatch):
    install_dir, config_dir = _legacy_pair(tmp_path)
    pre_tree = _snapshot(install_dir)

    # Apply for real (idle) to produce a pristine backup + corrected tree.
    monkeypatch.setattr(cli_mod, "apply_migration", _patched_apply(monkeypatch, recording=False))
    monkeypatch.setattr(verify_mod, "verify_migration", lambda _c, _r: False)  # keep backup
    cli_mod.main(["migrate", "--runtime-dir", str(install_dir), "--config-dir", str(config_dir)])
    assert cli_mod._latest_backup(install_dir) is not None

    rc = cli_mod.main(["rollback", "--runtime-dir", str(install_dir)])
    assert rc == 0
    # The tree is restored byte-for-byte to its pre-apply snapshot.
    assert _snapshot(install_dir) == pre_tree


# ── helper: wrap the real apply_migration but inject a recording-status socket ──


def _patched_apply(monkeypatch, *, recording: bool):
    """Return a drop-in ``apply_migration`` that injects an idle/recording socket and a
    stub manager so the real transactional apply runs without the live daemon stack."""
    from migrate.apply import apply_migration as real_apply

    class _Mgr:
        def unload(self, _label):
            pass

    def _send(_cmd):
        return {"recording": recording}

    def _wrapped(need, plan, runtime_dir, config_dir, *, manager=None, socket_send=None):
        return real_apply(
            need, plan, runtime_dir, config_dir,
            manager=_Mgr(), socket_send=_send,
        )

    return _wrapped
