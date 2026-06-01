"""macOS arm of the ``PathResolver`` seam (PLAT-04 / D-06).

Resolves Yulu's base directories with a three-tier precedence —
environment variable → ``config.json`` → platform default — replacing the
hardcoded ``~/.config/yulu`` and ``~/Movies/Yulu`` literals scattered across the
Python callers (dev_install.py:22, doctor.py:23) and Swift (audio_daemon.swift:45-58).

The ``data_dir`` resolution is a faithful port of ``audio_daemon.swift``'s
``loadRecordingDir()``: read ``audio.output_dir`` from ``config.json``, expand a
leading ``~/`` against the home directory, and fall back silently to the default
when the file is missing, unparseable, or the value is empty. Reading
``config.json`` must NEVER raise — a broken/absent file degrades to the default,
mirroring the Swift ``guard`` (and avoiding leaking the bad path, threat T-02-03).

stdlib only. Darwin-gated per the D-08 idiom shared with ``MacOSDaemonManager``.
"""

from __future__ import annotations

import json
import os
import platform
from pathlib import Path

from yulu_platform.base import PathResolver

# Platform defaults — the literals this seam centralizes (dev_install.py:22, doctor.py:23,
# audio_daemon.swift defaultRecordingDir).
_DEFAULT_CONFIG_SUBDIR = ".config/yulu"
_DEFAULT_DATA_SUBDIR = "Movies/Yulu"


class MacOSPathResolver(PathResolver):
    """Resolve config/data/runtime dirs on macOS (env → config.json → default)."""

    def __init__(self) -> None:
        if platform.system() != "Darwin":  # D-08 Darwin gate (shared with MacOSDaemonManager)
            raise RuntimeError("MacOSPathResolver requires macOS")

    def config_dir(self) -> Path:
        """``$YULU_CONFIG_DIR`` if set, else ``~/.config/yulu``."""
        env = os.environ.get("YULU_CONFIG_DIR")
        if env:
            return Path(env).expanduser()
        return Path.home() / _DEFAULT_CONFIG_SUBDIR

    def data_dir(self) -> Path:
        """Recording/output root: env → config.json ``audio.output_dir`` → default.

        Mirrors ``audio_daemon.swift:loadRecordingDir`` — honors a leading ``~/``,
        treats empty/missing/unparseable as "use the default", and never raises.
        """
        env = os.environ.get("YULU_OUTPUT_DIR")
        if env:
            return Path(env).expanduser()

        configured = self._config_output_dir()
        if configured is not None:
            return configured

        return Path.home() / _DEFAULT_DATA_SUBDIR

    # ── Phase 5 DATA-02: the runtime/content split (D-01) ──────────────────────
    #
    # ``runtime_dir()`` and ``data_dir()`` diverge precisely here, by DESIGN:
    #
    #   • runtime_dir()  = LOCKED, machine-local. Sockets (``*.sock``), PIDs/locks
    #     (``.recording.lock``, ``*.pid``), ``.state.json``, ``schedule.json``, and
    #     the WAL-mode SQLite DBs (``vocab.sqlite``/``prompts.sqlite``/``search.sqlite``
    #     + their ``-wal``/``-shm`` sidecars). It is NEVER sourced from user config —
    #     it does not read ``audio.output_dir`` — so a content-folder choice can never
    #     relocate runtime state into a synced folder.
    #   • data_dir()     = CONFIGURABLE content (recordings/transcripts/summaries/
    #     voicemails). Reads ``audio.output_dir``; this is the only thing the picker moves.
    #
    # Why the lock matters (D-01): a sync engine on the runtime dir CORRUPTS, it does
    # not merely inconvenience. SQLite explicitly does not support a cloud-synced live
    # DB — WAL checkpoint + hot-journal relocation corrupts the database (sqlite.org/
    # howtocorrupt.html). And the OS can EVICT (make "dataless") an in-use file mid-write.
    # NB: the lock is NOT justified by "a socket can't exist in a synced folder" — a Unix
    # socket CAN bind under iCloud Drive (verified on-device). The harm is corruption and
    # eviction, never physical impossibility.

    def runtime_dir(self) -> Path:
        """LOCKED machine-local runtime root — NOT configurable (D-01/D-07).

        Holds runtime/state that must never sync: sockets, PIDs, locks,
        ``.state.json``, and the WAL-mode SQLite DBs. NEVER sourced from
        ``audio.output_dir`` — this is exactly where it diverges from
        ``data_dir()`` (data_dir reads config; runtime_dir never does).

        Stays ``== config_dir()`` (``~/.config/yulu``, or ``$YULU_CONFIG_DIR`` for
        tests/dev — still machine-local). It is deliberately NOT relocated to
        ``~/Library/Application Support`` (pure churn against 38+ callers; D-07).
        """
        return self.config_dir()

    def assert_runtime_not_synced(self) -> None:
        """D-01 hard guard: refuse to run if the runtime dir is under a sync root.

        Since ``runtime_dir()`` is not user-configurable, the only way it can land
        under a cloud-sync root is a misconfigured ``$YULU_CONFIG_DIR`` (dev/test) —
        this assertion catches that at startup. Raises ``RuntimeError`` naming the
        detected reason and framing the refusal as machine-local corruption/eviction
        safety (NOT "impossible").

        Imports the cloud detector LAZILY inside a guarded ``try`` (mirroring
        ``capabilities.probes.probe_recording_dir``): ``cloud_detect`` is created by
        a same-wave sibling plan, so on ``ImportError`` (sibling not landed / off
        Darwin) this degrades to a no-op rather than raising spuriously.
        """
        try:
            from yulu_platform.macos.cloud_detect import is_cloud_root
        except Exception:
            # Detector unavailable (sibling plan not landed / off-platform):
            # degrade to no-op — never raise spuriously. The guard re-arms once
            # cloud_detect is importable.
            return None

        result = is_cloud_root(self.runtime_dir())
        if getattr(result, "is_cloud", False):
            raise RuntimeError(
                f"Yulu runtime dir {self.runtime_dir()} is under a cloud-sync root "
                f"({result.reason}). Runtime/state — SQLite DBs (+ WAL), Unix sockets, "
                "locks and PIDs — must be machine-local: a sync engine corrupts a live "
                "SQLite database (WAL checkpoint + hot-journal relocation) and may evict "
                "an in-use file mid-write. Refusing to start. Point $YULU_CONFIG_DIR at a "
                "machine-local path."
            )
        return None

    def _config_output_dir(self) -> Path | None:
        """Read ``audio.output_dir`` from config.json, or ``None`` to use the default.

        Silent fallback on any I/O or parse failure (matches the Swift ``guard``);
        a leading ``~/`` is expanded against ``Path.home()``.
        """
        config_path = self.config_dir() / "config.json"
        try:
            raw_text = config_path.read_text(encoding="utf-8")
            data = json.loads(raw_text)
        except (OSError, ValueError):
            return None

        if not isinstance(data, dict):
            return None
        audio = data.get("audio")
        if not isinstance(audio, dict):
            return None
        raw = audio.get("output_dir")
        if not isinstance(raw, str) or not raw:
            return None

        if raw.startswith("~/"):
            return Path.home() / raw[2:]
        return Path(raw)
