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

    def runtime_dir(self) -> Path:
        """Machine-local runtime root (sockets/PIDs/locks).

        Equals ``config_dir()`` today. Kept as a distinct method so Phase 5
        (DATA-02 runtime/content split) can diverge it without touching callers.
        """
        return self.config_dir()

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
