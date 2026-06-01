#!/usr/bin/env python3
"""Post-migration health gate + prune-backup-ONLY-on-success (MIG-01 verify, MIG-03, D-03).

After ``migrate.apply.apply_migration`` mutates the install, ``verify_migration``
re-detects host capability through the Phase-3 ``doctor`` host_capabilities report
and decides whether the migration is HEALTHY. ``finalize`` then gates the backup's
fate on that verdict — the headline CONCERNS §2e "backups never cleaned" fix done
SAFELY:

  * verify PASSES  → ``prune_backup`` reclaims the ``<name>.backup-*`` dir (bounded
    lifecycle — the §2e fix).
  * verify FAILS   → the backup is KEPT and the CLI points the user to
    ``yulu rollback`` (D-03: never a half-migrated state left silently; a failed
    verify must NEVER prune).

THE HEALTH PREDICATE (hardened per the checker note)
----------------------------------------------------
``doctor._host_capabilities`` returns ``{schema_version, capabilities, [error]}`` and
degrades to ``{"error": str(exc), "schema_version": 1, "capabilities": {}}`` on any
failure. A report is HEALTHY iff it carries NO ``error`` AND a non-empty
``capabilities`` map. We test ``report.get("error") is None`` (not merely ``"error"
not in report``) so the gate stays correct even if a future doctor revision adds an
explicit ``error: None`` to its success dict.

RESOLVE-NOT-EXECUTE (T-07-12)
-----------------------------
The doctor is reached by calling ``doctor._host_capabilities(config_dir,
runtime_root)`` DIRECTLY — a Python call with ``Path`` arguments, never a shell with
an interpolated path. No config path is ever echoed into a command line. (The
indirection lives in the module-level ``_host_report`` seam so tests can inject a
report without a real doctor / capabilities stack.)

stdlib only (``shutil`` for the prune; the doctor import is lazy + guarded).
"""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, Optional


def _host_report(config_dir: Path, runtime_root: Path) -> dict[str, Any]:
    """Obtain the post-migration ``host_capabilities`` report — resolve, never execute.

    Calls ``doctor._host_capabilities`` directly (a Python call with ``Path`` args; no
    shell, no path interpolation — T-07-12). The import is lazy + guarded (mirroring
    ``capabilities.probes`` usage in doctor) so this module imports cleanly off-Darwin
    and a doctor/capabilities import failure degrades to an ERROR report — which
    ``verify_migration`` treats as unhealthy (fail-closed: a verify we cannot run does
    NOT pass, so the backup is retained).

    This is the single seam tests monkeypatch to inject a healthy/unhealthy report.
    """
    try:
        import doctor

        return doctor._host_capabilities(Path(config_dir), Path(runtime_root))
    except Exception as exc:  # noqa: BLE001 — a verify we cannot run is unhealthy.
        return {"error": str(exc), "schema_version": 1, "capabilities": {}}


def verify_migration(config_dir: Path, runtime_root: Path) -> bool:
    """Return True iff the post-migration ``doctor`` host_capabilities report is healthy.

    Healthy == NO ``error`` (``report.get("error") is None`` — robust to a future
    ``error: None`` success dict) AND a non-empty ``capabilities`` map. This reads the
    POST-apply state (the schema_version stamp is already on disk), so a successful
    migration's report reflects the new schema. Any malformed report (missing keys,
    not a dict) is treated as unhealthy → False (fail-closed).
    """
    report = _host_report(config_dir, runtime_root)
    if not isinstance(report, dict):
        return False
    if report.get("error") is not None:
        return False
    capabilities = report.get("capabilities")
    return bool(capabilities)


def prune_backup(backup: Optional[Path]) -> None:
    """Remove the migration backup directory — called ONLY on a verified success.

    A ``None`` backup (nothing was backed up / a refused run) is a safe no-op. Removal
    is guarded so a vanished/already-pruned backup never raises. Also removes the
    sibling ``<backup>.config.json.bak`` snapshot when present (apply.py places the
    config snapshot there) so the prune reclaims the whole backup footprint.
    """
    if backup is None:
        return
    backup = Path(backup)
    try:
        if backup.is_dir():
            shutil.rmtree(backup)
        elif backup.exists():
            backup.unlink()
    except OSError:
        # An already-gone / unreadable backup is not a failure — the lifecycle goal is
        # "no orphaned backup after a verified success"; a missing one already satisfies it.
        pass
    # Reclaim the config snapshot sibling too (best-effort).
    config_snap = backup.parent / (backup.name + ".config.json.bak")
    try:
        if config_snap.is_file():
            config_snap.unlink()
    except OSError:
        pass


def finalize(result, config_dir: Path, runtime_root: Path) -> bool:
    """Verify the migration and prune the backup ONLY on a verified success (D-03).

    The CLI calls this after ``apply_migration``:
      * ``result.ok`` AND ``verify_migration(...)`` → ``prune_backup(result.backup)``
        and return True (the §2e bounded-lifecycle reclaim).
      * otherwise → LEAVE the backup in place and return False (the caller then prints
        "backup retained; run ``yulu rollback``").

    The prune is reached on the success path ONLY — a refused/failed/unverified run
    KEEPS the backup so ``yulu rollback`` is always possible (never a silent
    half-migration with a discarded backup).
    """
    if not getattr(result, "ok", False):
        return False
    if not verify_migration(config_dir, runtime_root):
        return False
    prune_backup(getattr(result, "backup", None))
    return True
