#!/usr/bin/env python3
"""Read-only v0.5.x detection — the front of the migration pipeline (MIG-01, D-01, D-07).

``detect_migration`` decides whether an existing ``~/.yulu`` install needs the
seamless auto-migration. The signal is the Phase-6 ``.yulu-install.json``
``schema_version`` key cross-checked against the legacy v0.5.x layout:

  * ``schema_version == provision.state.SCHEMA_VERSION``  → UP-TO-DATE (no-op; a
    migration must never re-run destructively against a current install).
  * ``schema_version`` ABSENT  → v0.5.x (the field is a Phase-6 addition; a
    Phase-1-only ledger has ``schema`` but no ``schema_version``). ``from_schema``
    is ``None``.
  * ``schema_version < current``  → an intermediate install; ``from_schema`` is
    that older integer.
  * NO ledger at all, but the legacy layout present (a ``config.json`` carrying
    the dead ``transcription.mlx.python`` field, or an existing
    ``~/.config/yulu/venv-mlx-whisper`` directory)  → v0.5.x predating the ledger.

ZERO MUTATION (D-04). Detection is purely read-only: it never writes, creates, or
repairs anything. It also NEVER raises — a corrupt / partially-written /
hand-edited ledger or config degrades to ``needs_migration=True`` (the safe
default: a fresh walk re-checks everything), exactly mirroring
``release_installer.read_install_metadata`` and ``provision.state.load``. This is
the Phase-7 D-08 referenced in ``provision/state.py`` ("cleaning up the legacy
``venv-mlx-whisper`` / stale config is Phase 7"): detect NAMES the legacy markers;
``apply`` (Plan 03) removes them.

NOTE on the two roots (the easy-to-confuse pair):
  * ``runtime_dir`` here == the ``~/.yulu`` INSTALL TREE — where the installer
    writes ``.yulu-install.json`` (``release_installer``'s ``runtime_dir`` sense).
  * ``config_dir`` == ``~/.config/yulu`` — where ``config.json`` and the legacy
    ``venv-mlx-whisper`` live (``MacOSPathResolver.config_dir()`` / ``runtime_dir()``).
These are DISTINCT directories; the ledger and the config are read from each.

stdlib only. ``SCHEMA_VERSION`` is IMPORTED from ``provision.state`` (the single
source of the current ledger schema) — never a duplicated ``2`` literal.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

import release_installer
from provision.state import SCHEMA_VERSION

# The legacy venv the Phase-1 work stopped CREATING (D-02) but intentionally did
# NOT delete on existing installs; and the dead config field that pointed at it.
# detect names them as corroborating reasons — apply (Plan 03) removes them.
_LEGACY_VENV_DIRNAME = "venv-mlx-whisper"
_CONFIG_NAME = "config.json"


@dataclass(frozen=True)
class MigrationNeed:
    """Read-only verdict consumed by ``migrate.plan.build_plan`` (the Plan-03 driver).

    ``needs_migration`` — True when the install is v0.5.x / pre-current schema.
    ``from_schema``      — the install's current ``schema_version`` (``None`` ==
                           absent == v0.5.x predating the Phase-6 ledger).
    ``to_schema``        — the migration target, always ``state.SCHEMA_VERSION``.
    ``reasons``          — human-readable triggers ("schema_version absent",
                           "legacy transcription.mlx.python in config", ...);
                           EMPTY when up-to-date. Reasons are fixed strings, never
                           an interpolated raw file path from a parse failure
                           (threat T-07-03 — no info disclosure on error paths).
    """

    needs_migration: bool
    from_schema: int | None
    to_schema: int
    reasons: list[str] = field(default_factory=list)


def _default_config_dir() -> Path:
    """Resolve ``~/.config/yulu`` via the platform PathResolver, lazily + guarded.

    Mirrors ``provision.state.default_ledger_path``: the import is lazy so this
    module stays stdlib-pure and cheap, and degrades to ``~/.config/yulu`` on any
    failure (unusual platform / resolver unavailable). Tests always pass an
    explicit ``config_dir`` and never hit this.
    """
    try:
        from yulu_platform import get_platform

        return Path(get_platform().path_resolver().config_dir())
    except Exception:
        return Path.home() / ".config" / "yulu"


def _config_has_legacy_mlx_python(config_dir: Path) -> bool:
    """True iff ``config_dir/config.json`` carries ``transcription.mlx.python``.

    Read-only, never raises: any I/O or parse error (missing / corrupt / hand-edited
    file) degrades to ``False`` (the ledger-schema signal already drives the verdict;
    this is corroborating only).
    """
    cfg_path = config_dir / _CONFIG_NAME
    try:
        data = json.loads(cfg_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(data, dict):
        return False
    transcription = data.get("transcription")
    if not isinstance(transcription, dict):
        return False
    mlx = transcription.get("mlx")
    if not isinstance(mlx, dict):
        return False
    return "python" in mlx


def _legacy_venv_present(config_dir: Path) -> bool:
    """True iff the dead ``~/.config/yulu/venv-mlx-whisper`` directory still exists."""
    try:
        return (config_dir / _LEGACY_VENV_DIRNAME).is_dir()
    except OSError:
        return False


def detect_migration(runtime_dir: Path, config_dir: Path | None = None) -> MigrationNeed:
    """Decide whether ``runtime_dir`` (``~/.yulu``) needs the v0.5.x migration.

    Reads the ledger via ``release_installer.read_install_metadata(runtime_dir)``
    (which already degrades a corrupt JSON → ``{}``) and compares its
    ``schema_version`` against the imported ``SCHEMA_VERSION``:

      * ``== SCHEMA_VERSION`` → up-to-date (``needs_migration=False``, no reasons).
      * ``< SCHEMA_VERSION``  → migrate, ``from_schema`` == the older int.
      * absent                → v0.5.x; ALSO probe the legacy markers
        (``transcription.mlx.python`` in ``config.json``, the ``venv-mlx-whisper``
        dir) and record each present one as a corroborating reason.

    NEVER raises — wraps the whole body so any unexpected error degrades to
    ``needs_migration=True`` (the safe default; a fresh walk re-checks everything).
    Performs ZERO mutation.

    Args:
        runtime_dir: the ``~/.yulu`` install tree (where ``.yulu-install.json`` lives).
        config_dir:  the ``~/.config/yulu`` config root (``config.json`` + the legacy
                     venv). Defaults to the platform PathResolver's config dir.
    """
    runtime_dir = Path(runtime_dir)
    config_dir = Path(config_dir) if config_dir is not None else _default_config_dir()
    reasons: list[str] = []

    try:
        ledger = release_installer.read_install_metadata(runtime_dir)
        raw_schema = ledger.get("schema_version") if isinstance(ledger, dict) else None
        from_schema = raw_schema if isinstance(raw_schema, int) else None

        # ── current install: schema_version stamped at the target → up-to-date ──
        if from_schema is not None and from_schema >= SCHEMA_VERSION:
            return MigrationNeed(
                needs_migration=False,
                from_schema=from_schema,
                to_schema=SCHEMA_VERSION,
                reasons=[],
            )

        # ── intermediate install: a stamped but older schema_version ──
        if from_schema is not None:
            reasons.append(
                f"schema_version {from_schema} is older than current {SCHEMA_VERSION}"
            )
            return MigrationNeed(
                needs_migration=True,
                from_schema=from_schema,
                to_schema=SCHEMA_VERSION,
                reasons=reasons,
            )

        # ── v0.5.x: schema_version absent. Corroborate with the legacy markers. ──
        reasons.append("schema_version absent (pre-Phase-6 install)")
        if _config_has_legacy_mlx_python(config_dir):
            reasons.append("legacy transcription.mlx.python in config")
        if _legacy_venv_present(config_dir):
            reasons.append("legacy venv-mlx-whisper directory present")

        return MigrationNeed(
            needs_migration=True,
            from_schema=None,
            to_schema=SCHEMA_VERSION,
            reasons=reasons,
        )
    except Exception:
        # Never crash on a tampered / partially-written tree (threat T-07-01):
        # degrade to "needs migration" — a fresh, safe walk re-checks everything.
        return MigrationNeed(
            needs_migration=True,
            from_schema=None,
            to_schema=SCHEMA_VERSION,
            reasons=["detection degraded to safe default (read error)"],
        )
