#!/usr/bin/env python3
"""The transactional, destructive half of the migration pipeline (MIG-01, MIG-02, MIG-03, D-03, D-04).

``apply_migration`` executes a dry-run-proven :class:`migrate.plan.MigrationPlan`
against an existing v0.5.x ``~/.yulu`` install — TRANSACTIONALLY, so the user's
irreplaceable data (recordings/transcripts/vocab/prompts/summaries) is NEVER lost
and NEVER left half-migrated:

  1. RECORDING-GUARD FIRST (MIG-02 / D-02). Before touching anything, call
     ``migrate.guard.stop_daemons_guarded`` — a live recording raises
     :class:`migrate.guard.RecordingActive`, which we turn into a REFUSED
     ``MigrationResult`` (``ok=False``) with ZERO mutation: no backup taken, no
     daemon stopped, no config rewritten, no in-flight WAV truncated. The guard
     does the daemon clean-stop (``launchctl unload``); there is NO forced-kill
     path (D-06 removed the orphan that historically forced one).

  2. BACKUP BEFORE ANY MUTATION (MIG-03 / D-03). Reuse
     ``release_installer.move_existing_runtime_to_backup`` to move the ``~/.yulu``
     INSTALL TREE aside (byte-for-byte, ``shutil.move``), and snapshot
     ``config.json`` aside too — so ``rollback`` can restore the prior state
     byte-for-byte. The backup is the recovery boundary (T-07-08): any exception
     mid-apply restores from it and re-raises (mirrors
     ``release_installer.install_release_from_urls``) — never a half-migration.

  3. APPLY THE IN-TRANSIT CORRECTIONS (D-04), dispatching on each ``PlanStep.name``:
     * ``drop_mlx_python``      — ``pop("python", None)`` from ``transcription.mlx``
       in ``config.json`` (the dead field; Phase 1 removed the venv).
     * ``route_recording_dir``  — if ``audio.output_dir`` is the hardcoded
       ``~/Movies/Yulu`` default, rewrite it to the PathResolver ``data_dir``;
       a user's already-custom output_dir is LEFT UNTOUCHED (never reconfigure).
     * ``stamp_schema_version`` — ``provision.state.mark`` stamps ``schema_version``
       AND PRESERVES the installer ``source`` (Pitfall 3 / T-07-10).

The config rewrite mirrors ``provision.state._atomic_write`` (mkstemp + os.replace
in the same dir) so a kill mid-write leaves the OLD config intact, never a torn file.

``rollback(backup, install_dir)`` wraps ``release_installer.restore_backup`` (moves
the backup tree back byte-for-byte) and, when a config snapshot was taken, restores
``config.json`` too.

NAMING (the easy-to-confuse pair this module is careful about):
  * ``install_dir`` == the ``~/.yulu`` INSTALL TREE — where ``.yulu-install.json``
    and the ``<name>.backup-*`` sibling live (``release_installer``'s ``runtime_dir``
    sense). Backup + ledger stamp target THIS dir.
  * ``config_dir`` == ``~/.config/yulu`` — where ``config.json`` lives. The
    config corrections target ``config_dir/config.json``. DISTINCT from install_dir.

stdlib only. Every cross-module import that touches macOS-only surface
(``record_audio``/PathResolver via guard, the daemon manager) is reached lazily +
guarded through ``migrate.guard`` so THIS module imports cleanly off-Darwin. The
``release_installer`` and ``provision.state`` reuses are pure stdlib and import
unconditionally. There is NO forced-kill anywhere in this module (the grep gate
asserts zero occurrences of the forced-kill token across migrate/).
"""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Optional

import release_installer
from provision import state

from migrate.guard import RecordingActive, stop_daemons_guarded
from migrate.plan import (
    KIND_CONFIG_CORRECTION,
    KIND_PATH_ROUTE,
    KIND_SCHEMA_STAMP,
    MigrationPlan,
)

# The config file the in-transit corrections edit (under ``config_dir``, NOT the
# install tree). Matches detect._CONFIG_NAME / path_resolver's config.json.
_CONFIG_NAME = "config.json"

# The hardcoded recording root the path_route correction reroutes. Matches the
# MacOSPathResolver default (``~/Movies/Yulu`` → ``_DEFAULT_DATA_SUBDIR``); only an
# output_dir EQUAL to this legacy literal is rewritten — a custom one is untouched.
_LEGACY_RECORDING_DIR = "~/Movies/Yulu"

# Suffix for the snapshotted config (taken aside next to the backup tree so a
# rollback restores config.json byte-for-byte alongside the install tree).
_CONFIG_BACKUP_SUFFIX = ".config.json.bak"


@dataclass(frozen=True)
class MigrationResult:
    """The outcome of an ``apply_migration`` run — what ``verify.finalize`` and the CLI read.

    ``ok``          — True when the migration applied cleanly (the CLI then verifies
                      and, only on a verify PASS, prunes ``backup``).
    ``backup``      — the ``<name>.backup-*`` install-tree backup dir (``None`` when
                      there was nothing to back up, or on a refused/recording-active
                      run). verify prunes this ONLY on a verified success; a failed
                      verify keeps it so ``yulu rollback`` is always possible.
    ``reasons``     — human-readable outcome notes ("recording active — refused",
                      the applied corrections, ...). Fixed strings, never an
                      interpolated raw path (T-07-12 info-disclosure hygiene).
    ``rolled_back`` — True when an exception mid-apply triggered a restore-from-backup
                      (the tree was returned to its pre-apply state before re-raising).
    """

    ok: bool
    backup: Optional[Path]
    reasons: list[str] = field(default_factory=list)
    rolled_back: bool = False


def _install_metadata_path(install_dir: Path) -> Path:
    """The install tree's ``.yulu-install.json`` ledger (reuses release_installer's name)."""
    return release_installer.install_metadata_path(install_dir)


def _config_backup_path(backup: Optional[Path], install_dir: Path) -> Path:
    """Where the config.json snapshot lives so rollback can restore it byte-for-byte.

    Placed as a sibling of the install-tree backup (``<backup>.config.json.bak``) so a
    single ``<name>.backup-*`` prune removes both, and ``rollback`` can find it from
    the located backup dir alone. When no tree backup was taken (a missing install
    tree), it falls back next to ``install_dir`` so the snapshot is never orphaned.
    """
    if backup is not None:
        return backup.parent / (backup.name + _CONFIG_BACKUP_SUFFIX)
    return install_dir.parent / (install_dir.name + _CONFIG_BACKUP_SUFFIX)


def _snapshot_config(config_dir: Path, dest: Path) -> bool:
    """Copy ``config_dir/config.json`` aside (byte-for-byte) for rollback. Returns
    True iff a config existed and was snapshotted; a missing config is fine (no-op)."""
    src = config_dir / _CONFIG_NAME
    if not src.is_file():
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(str(src), str(dest))
    return True


def _atomic_write_json(path: Path, doc: dict) -> None:
    """Atomic JSON write mirroring ``provision.state._atomic_write`` (mkstemp + os.replace).

    Same-directory temp file so ``os.replace`` is an atomic same-filesystem rename; a
    kill between the write and the replace leaves the OLD config fully intact (never a
    torn file). indent=2 / ensure_ascii=False / trailing newline match the repo idiom.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def _load_config(config_dir: Path) -> Optional[dict]:
    """Read ``config_dir/config.json`` → dict, or ``None`` when absent/corrupt/non-dict.

    A correction that finds no usable config simply no-ops (the install may legitimately
    lack one); never raises on a parse error.
    """
    cfg_path = config_dir / _CONFIG_NAME
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def _resolver_data_dir() -> Optional[str]:
    """The PathResolver-derived recording root as a ``~``-style string, or ``None``
    off-Darwin / when the resolver is unavailable.

    Lazy + guarded (mirrors detect._default_config_dir): importing the macOS resolver
    must never break this stdlib module on another platform. We re-collapse a
    home-prefixed absolute path back to ``~/...`` so the rewritten config stays
    portable and matches how audio_daemon.swift reads a leading ``~/``.
    """
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        data_dir = MacOSPathResolver().data_dir()
    except Exception:
        return None
    data_dir = Path(data_dir)
    home = Path.home()
    try:
        rel = data_dir.relative_to(home)
        return "~/" + str(rel)
    except ValueError:
        return str(data_dir)


def _apply_drop_mlx_python(config_dir: Path, reasons: list[str]) -> None:
    """D-04: drop the dead ``transcription.mlx.python`` field, preserving the rest.

    Guards every level (missing transcription / mlx / python) so a config without the
    field is an untouched no-op. Writes back atomically only when the field was present.
    """
    data = _load_config(config_dir)
    if data is None:
        return
    transcription = data.get("transcription")
    if not isinstance(transcription, dict):
        return
    mlx = transcription.get("mlx")
    if not isinstance(mlx, dict):
        return
    if "python" not in mlx:
        return
    mlx.pop("python", None)
    _atomic_write_json(config_dir / _CONFIG_NAME, data)
    reasons.append("dropped dead transcription.mlx.python")


def _apply_route_recording_dir(config_dir: Path, reasons: list[str]) -> None:
    """D-04: reroute a hardcoded ``~/Movies/Yulu`` output_dir through PathResolver.

    Only an ``audio.output_dir`` EQUAL to the legacy ``~/Movies/Yulu`` literal is
    rewritten (to the resolver ``data_dir``); a user's already-custom path — or an
    absent output_dir — is LEFT UNTOUCHED (never reconfigure the chosen folder). Off
    Darwin (resolver unavailable) the correction degrades to a no-op.
    """
    data = _load_config(config_dir)
    if data is None:
        return
    audio = data.get("audio")
    if not isinstance(audio, dict):
        return
    current = audio.get("output_dir")
    if current != _LEGACY_RECORDING_DIR:
        return  # custom / absent — leave the user's choice alone.
    routed = _resolver_data_dir()
    if routed is None or routed == current:
        return  # resolver unavailable, or it resolves to the same literal — no-op.
    audio["output_dir"] = routed
    _atomic_write_json(config_dir / _CONFIG_NAME, data)
    reasons.append("routed ~/Movies/Yulu recording dir via PathResolver")


def _apply_schema_stamp(install_dir: Path, reasons: list[str]) -> None:
    """D-04 / Pitfall 3: stamp ``schema_version`` while PRESERVING the installer ``source``.

    Delegates to ``provision.state.mark`` — the single function that adds
    ``schema_version`` + a ``steps`` entry and preserves ``source``/``version``/etc.
    via setdefault. We never hand-write the ledger (dropping ``source`` would flip the
    next update into the swiftc dev branch — T-07-10).
    """
    state.mark(_install_metadata_path(install_dir), "migrate", "ok")
    reasons.append(f"stamped schema_version={state.SCHEMA_VERSION} (source preserved)")


def apply_migration(
    need,
    plan: MigrationPlan,
    runtime_dir: Path,
    config_dir: Path,
    *,
    manager: Optional[object] = None,
    socket_send: Optional[Callable[[dict], Optional[dict]]] = None,
) -> MigrationResult:
    """Transactionally apply ``plan`` to the v0.5.x install — backup-first, guarded, reversible.

    Order (the transactional contract):

      1. ``stop_daemons_guarded`` FIRST — on :class:`RecordingActive`, return a REFUSED
         result (``ok=False``, ``backup=None``) WITHOUT mutating anything (T-07-11).
      2. Take the backup BEFORE any mutation: move the install tree aside
         (``move_existing_runtime_to_backup``) and snapshot ``config.json``.
      3. Walk ``plan.steps`` dispatching on ``kind`` (config_correction / path_route /
         schema_stamp), applying the in-transit corrections (D-04).
      4. Return ``MigrationResult(ok=True, backup=<backup>, ...)`` carrying the backup
         path for ``verify.finalize`` to prune ONLY on a verified success.

    On ANY exception during steps 2–3, restore from the backup and re-raise (mirrors
    ``install_release_from_urls``) — the user is left with their old state, never a
    half-migration (T-07-08).

    Args:
        need:        the ``migrate.detect.MigrationNeed`` (carried for symmetry; the
                     plan already encodes the corrections).
        plan:        the dry-run-proven ``MigrationPlan`` to execute.
        runtime_dir: the ``~/.yulu`` INSTALL TREE (== ``install_dir``; backup + ledger
                     stamp target). NOT the ``~/.config/yulu`` config dir.
        config_dir:  the ``~/.config/yulu`` config root (``config.json`` corrections).
        manager:     injected daemon manager (passed straight to the guard; tests mock it).
        socket_send: injected recording-status probe (passed to the guard; tests mock it).
    """
    install_dir = Path(runtime_dir)
    config_dir = Path(config_dir)
    reasons: list[str] = []

    # ── 1. RECORDING-GUARD FIRST (MIG-02). Refuse — zero mutation — if recording. ──
    try:
        stop_daemons_guarded(None, manager, socket_send)
    except RecordingActive as exc:
        # Data-loss prevention, not a failure: NOTHING backed up, NOTHING mutated,
        # NO daemon stopped. The CLI surfaces this as a non-zero "retry after stop".
        return MigrationResult(
            ok=False,
            backup=None,
            reasons=["recording active — refused", str(exc)],
            rolled_back=False,
        )

    # ── 2. BACKUP BEFORE ANY MUTATION (MIG-03). Tree aside + config snapshot. ──
    # ``move_existing_runtime_to_backup`` moves the install tree to a pristine
    # ``<name>.backup-*`` sibling (the byte-for-byte rollback snapshot). We then
    # restore a WORKING COPY back into install_dir and correct it IN PLACE — so the
    # backup stays pristine for ``rollback`` while the live tree (with the user's
    # data AND its original ``.yulu-install.json`` ``source``) remains intact for the
    # schema stamp. On a verified success the pristine backup is pruned and the
    # corrected live tree (data intact) remains: NO data loss, ``source`` preserved.
    backup = release_installer.move_existing_runtime_to_backup(install_dir)
    config_backup = _config_backup_path(backup, install_dir)
    snapshotted = _snapshot_config(config_dir, config_backup)

    if backup is not None:
        # Working copy back into place — the live tree carries the prior ledger (and
        # thus ``source``), so the schema stamp preserves it (Pitfall 3 / T-07-10).
        shutil.copytree(str(backup), str(install_dir))
    else:
        # No prior tree to back up (a pre-ledger / absent install): create the dir so
        # the schema stamp has a home. ``state.mark`` then writes a fresh ledger.
        install_dir.mkdir(parents=True, exist_ok=True)

    try:
        # ── 3. APPLY THE IN-TRANSIT CORRECTIONS (D-04) in plan order. ──
        for step in plan.steps:
            if step.kind == KIND_CONFIG_CORRECTION:
                _apply_drop_mlx_python(config_dir, reasons)
            elif step.kind == KIND_PATH_ROUTE:
                _apply_route_recording_dir(config_dir, reasons)
            elif step.kind == KIND_SCHEMA_STAMP:
                _apply_schema_stamp(install_dir, reasons)
            # An unknown kind is a contract break (build_plan only emits the three);
            # skip defensively rather than execute anything arbitrary (T-07-13).
    except Exception:
        # ── TRANSACTIONAL ROLLBACK: restore the prior state, then re-raise. ──
        try:
            if backup is not None:
                release_installer.restore_backup(backup, install_dir)
            elif install_dir.is_dir():
                shutil.rmtree(install_dir)
            if snapshotted:
                _restore_config_snapshot(config_backup, config_dir)
        except Exception:
            # A failed rollback must not mask the original error; re-raise the latter.
            pass
        raise

    return MigrationResult(ok=True, backup=backup, reasons=reasons, rolled_back=False)


def _restore_config_snapshot(config_backup: Path, config_dir: Path) -> None:
    """Move the snapshotted ``config.json`` back into ``config_dir`` (byte-for-byte)."""
    if not config_backup.is_file():
        return
    config_dir.mkdir(parents=True, exist_ok=True)
    shutil.move(str(config_backup), str(config_dir / _CONFIG_NAME))


def rollback(backup: Path, install_dir: Path) -> None:
    """Restore the prior state from ``backup`` — byte-for-byte (MIG-03, ``yulu rollback``).

    Wraps ``release_installer.restore_backup`` (moves the backup tree back over
    ``install_dir`` via ``shutil.move``). When a sibling ``config.json`` snapshot exists
    (``<backup>.config.json.bak``), it is restored too so the config returns to its
    pre-migration content. After a successful restore the install tree and config are
    byte-identical to the pre-apply snapshot.
    """
    backup = Path(backup)
    install_dir = Path(install_dir)
    release_installer.restore_backup(backup, install_dir)
    config_backup = backup.parent / (backup.name + _CONFIG_BACKUP_SUFFIX)
    if config_backup.is_file():
        # The config lives under config_dir (~/.config/yulu), distinct from install_dir.
        # Restore it next to where detect/apply read it: the resolver config_dir. Tests
        # pass an explicit pair; production resolves it lazily + guarded.
        _restore_config_snapshot(config_backup, _default_config_dir())


def _default_config_dir() -> Path:
    """Resolve ``~/.config/yulu`` lazily + guarded (mirrors detect._default_config_dir).

    Only ``rollback`` (the production CLI path) hits this; tests restore config via
    ``_restore_config_snapshot`` with an explicit dir.
    """
    try:
        from yulu_platform.macos.path_resolver import MacOSPathResolver

        return Path(MacOSPathResolver().config_dir())
    except Exception:
        return Path.home() / ".config" / "yulu"
