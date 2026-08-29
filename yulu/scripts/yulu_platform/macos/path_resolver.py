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
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping

from yulu_platform.base import PathResolver

# Platform defaults — the literals this seam centralizes (dev_install.py:22, doctor.py:23,
# audio_daemon.swift defaultRecordingDir).
_DEFAULT_CONFIG_SUBDIR = ".config/yulu"
_DEFAULT_DATA_SUBDIR = "Movies/Yulu"


@dataclass(frozen=True)
class ApplicationDataPaths:
    """Standard writable roots plus the explicit legacy compatibility reader."""

    durable_data_dir: Path
    config_file: Path
    models_dir: Path
    cache_dir: Path
    ipc_dir: Path
    logs_dir: Path
    media_library_dir: Path
    legacy_read_only_data_dir: Path
    config_read_files: tuple[Path, ...]


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

    def application_paths(
        self,
        *,
        home: Path | None = None,
        environment: Mapping[str, str] | None = None,
    ) -> ApplicationDataPaths:
        """Resolve Phase 13's standard cross-runtime mutable-data contract.

        ``config_dir``/``runtime_dir`` intentionally retain their pre-migration
        behavior until the dedicated caller migrations in #162 and #163. This
        expanded contract makes every new write authority standard while keeping
        the old root available only in ``config_read_files``.
        """
        home = home or Path.home()
        environment = environment if environment is not None else os.environ
        if not home.is_absolute():
            raise ValueError("Yulu application path home must be absolute")
        default_durable = home / "Library/Application Support/Yulu"
        default_cache = home / "Library/Caches/Yulu"
        default_logs = home / "Library/Logs/Yulu"
        default_media = home / _DEFAULT_DATA_SUBDIR
        default_legacy = home / _DEFAULT_CONFIG_SUBDIR
        default_legacy_canonical = self._required_canonical(
            default_legacy, "YULU_LEGACY_READ_ONLY_DATA_DIR"
        )
        default_media_canonical = self._required_canonical(
            default_media, "YULU_MEDIA_LIBRARY_DIR"
        )

        durable_data_dir = self._choose_path(
            "YULU_APPLICATION_SUPPORT_DIR",
            default_durable,
            environment,
            home,
            lambda candidate: not self._overlaps(candidate, default_legacy_canonical)
            and not self._overlaps(candidate, default_media_canonical),
        )
        durable_canonical = durable_data_dir
        config_file = durable_data_dir / "config.json"
        cache_dir = self._choose_path(
            "YULU_CACHE_DIR",
            default_cache,
            environment,
            home,
            lambda candidate: not self._overlaps(candidate, durable_canonical)
            and not self._overlaps(candidate, default_legacy_canonical)
            and not self._overlaps(candidate, default_media_canonical),
        )
        cache_canonical = cache_dir
        logs_dir = self._choose_path(
            "YULU_LOG_DIR",
            default_logs,
            environment,
            home,
            lambda candidate: not self._overlaps(candidate, durable_canonical)
            and not self._overlaps(candidate, cache_canonical)
            and not self._overlaps(candidate, default_legacy_canonical)
            and not self._overlaps(candidate, default_media_canonical),
        )
        logs_canonical = logs_dir
        models_dir = self._choose_path(
            "YULU_MODELS_DIR",
            durable_data_dir / "Models",
            environment,
            home,
            lambda candidate: self._is_strictly_nested(
                candidate, durable_canonical
            ),
        )
        ipc_dir = self._choose_path(
            "YULU_IPC_DIR",
            cache_dir,
            environment,
            home,
            lambda candidate: self._is_same_or_nested(candidate, cache_canonical),
        )
        legacy_read_only_data_dir = self._choose_path(
            "YULU_LEGACY_READ_ONLY_DATA_DIR",
            default_legacy,
            environment,
            home,
            lambda candidate: not self._overlaps(candidate, durable_canonical)
            and not self._overlaps(candidate, cache_canonical)
            and not self._overlaps(candidate, logs_canonical)
            and not self._overlaps(candidate, default_media_canonical),
        )
        legacy_canonical = legacy_read_only_data_dir
        config_read_files = (
            config_file,
            legacy_read_only_data_dir / "config.json",
        )
        media_candidates = (
            self._absolute_path(environment.get("YULU_MEDIA_LIBRARY_DIR"), home),
            *(self._media_from_config(path, home) for path in config_read_files),
            default_media,
        )
        media_library_dir = None
        for candidate in media_candidates:
            resolved = self._try_canonical(candidate) if candidate is not None else None
            if (
                resolved is not None
                and not self._overlaps(resolved, durable_canonical)
                and not self._overlaps(resolved, cache_canonical)
                and not self._overlaps(resolved, logs_canonical)
                and not self._overlaps(resolved, legacy_canonical)
            ):
                media_library_dir = resolved
                break
        if media_library_dir is None:
            raise RuntimeError("no safe Yulu Media Library path")
        return ApplicationDataPaths(
            durable_data_dir=durable_data_dir,
            config_file=config_file,
            models_dir=models_dir,
            cache_dir=cache_dir,
            ipc_dir=ipc_dir,
            logs_dir=logs_dir,
            media_library_dir=media_library_dir,
            legacy_read_only_data_dir=legacy_read_only_data_dir,
            config_read_files=config_read_files,
        )

    @classmethod
    def _choose_path(
        cls,
        name: str,
        fallback: Path,
        environment: Mapping[str, str],
        home: Path,
        safe,
    ) -> Path:
        configured = cls._absolute_path(environment.get(name), home)
        candidate = cls._try_canonical(configured) if configured is not None else None
        if candidate is not None and safe(candidate):
            return candidate
        resolved_fallback = cls._required_canonical(fallback, name)
        if not safe(resolved_fallback):
            raise RuntimeError(f"unsafe Yulu standard path: {name}")
        return resolved_fallback

    @staticmethod
    def _absolute_path(raw: str | None, home: Path) -> Path | None:
        value = raw.strip() if isinstance(raw, str) else ""
        if not value or "\0" in value:
            return None
        candidate = home / value[2:] if value.startswith("~/") else Path(value)
        return Path(os.path.normpath(candidate)) if candidate.is_absolute() else None

    @staticmethod
    def _canonical(path: Path) -> Path:
        existing = path
        missing: list[str] = []
        while True:
            try:
                existing.lstat()
                break
            except FileNotFoundError:
                parent = existing.parent
                if parent == existing:
                    raise
                missing.insert(0, existing.name)
                existing = parent
        resolved = existing.resolve(strict=True)
        if not resolved.is_dir():
            raise NotADirectoryError(resolved)
        return resolved.joinpath(*missing)

    @classmethod
    def _try_canonical(cls, path: Path) -> Path | None:
        try:
            return cls._canonical(path)
        except (OSError, RuntimeError, ValueError):
            return None

    @classmethod
    def _required_canonical(cls, path: Path, name: str) -> Path:
        resolved = cls._try_canonical(path)
        if resolved is None:
            raise RuntimeError(f"unsafe Yulu standard path: {name}")
        return resolved

    @staticmethod
    def _comparison_components(value: Path) -> tuple[str, ...]:
        return tuple(
            unicodedata.normalize(
                "NFC", unicodedata.normalize("NFC", component).lower()
            )
            for component in value.parts
        )

    @classmethod
    def _has_comparison_root(cls, path: Path, root: Path, *, strict: bool) -> bool:
        path_components = cls._comparison_components(path)
        root_components = cls._comparison_components(root)
        minimum_length = len(root_components) + (1 if strict else 0)
        return len(path_components) >= minimum_length and path_components[
            : len(root_components)
        ] == root_components

    @classmethod
    def _is_same_or_nested(cls, path: Path, root: Path) -> bool:
        return cls._has_comparison_root(path, root, strict=False)

    @classmethod
    def _is_strictly_nested(cls, path: Path, root: Path) -> bool:
        return cls._has_comparison_root(path, root, strict=True)

    @classmethod
    def _overlaps(cls, left: Path, right: Path) -> bool:
        return cls._is_same_or_nested(left, right) or cls._is_same_or_nested(right, left)

    @classmethod
    def _media_from_config(cls, config_file: Path, home: Path) -> Path | None:
        try:
            data = json.loads(config_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None
        if not isinstance(data, dict) or not isinstance(data.get("audio"), dict):
            return None
        raw = data["audio"].get("output_dir")
        return cls._absolute_path(raw, home) if isinstance(raw, str) else None

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
    #   • data_dir()     = CONFIGURABLE content (recordings/transcripts/summaries).
    #     Reads ``audio.output_dir``; this is the only thing the picker moves.
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
