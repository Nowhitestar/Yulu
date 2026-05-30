"""macOS arm of the ``DaemonManager`` seam (PLAT-03 / D-04).

Wraps ``launchctl`` and renders a ``ServiceSpec`` into a launchd property list,
keeping every launchd-specific name (the plist keys, the ``launchctl`` verbs)
INSIDE this module — the frozen ABC and ``ServiceSpec`` stay platform-neutral so
a systemd arm could re-implement the same four methods (D-09).

Mirrors the existing in-repo launchctl flow (dev_install.py:_unload/_load,
191-198) and the "is it loaded?" detection pattern (doctor.py:220-222), but
behind the neutral interface and returning neutral status strings.

Security (threat register §02):
  - T-02-01: every subprocess call is list-form ``subprocess.run([...])`` — the
    shell is never invoked, and no value is f-string-interpolated into a command.
  - T-02-03: ``status`` returns only "running"/"stopped"/"unknown", never raw
    launchctl output/exit codes that could echo environment or paths.

stdlib only. Darwin-gated per the D-08 idiom shared with ``MacOSPathResolver``.
"""

from __future__ import annotations

import platform
import plistlib
import subprocess
from pathlib import Path

from yulu_platform.base import DaemonManager, ServiceSpec

# Platform-neutral status vocabulary the ABC promises (never a launchctl code).
_STATUS_RUNNING = "running"
_STATUS_STOPPED = "stopped"
_STATUS_UNKNOWN = "unknown"


class MacOSDaemonManager(DaemonManager):
    """Install and supervise launchd jobs behind the neutral ``DaemonManager`` ABC."""

    def __init__(self) -> None:
        if platform.system() != "Darwin":  # D-08 Darwin gate (shared with MacOSPathResolver)
            raise RuntimeError("MacOSDaemonManager requires macOS")
        self._agents = Path.home() / "Library/LaunchAgents"

    def install(self, spec: ServiceSpec) -> None:
        """Render ``spec`` → a launchd plist and write it to ``~/Library/LaunchAgents``.

        The launchd key names (Label, ProgramArguments, KeepAlive, RunAtLoad,
        WorkingDirectory, EnvironmentVariables) appear ONLY here — never in the
        ABC or ``ServiceSpec`` (D-09).
        """
        job: dict[str, object] = {
            "Label": spec.name,
            "ProgramArguments": list(spec.program),
            "KeepAlive": spec.keep_alive,
            "RunAtLoad": spec.keep_alive,
        }
        if spec.working_dir is not None:
            job["WorkingDirectory"] = str(spec.working_dir)
        if spec.environment is not None:
            job["EnvironmentVariables"] = dict(spec.environment)

        self._agents.mkdir(parents=True, exist_ok=True)
        dest = self._agents / f"{spec.name}.plist"
        with dest.open("wb") as fh:
            plistlib.dump(job, fh)

    def load(self, name: str) -> None:
        """``launchctl load <plist>`` — list-form subprocess (T-02-01)."""
        subprocess.run(
            ["launchctl", "load", str(self._agents / f"{name}.plist")],
            check=False,
        )

    def unload(self, name: str) -> None:
        """``launchctl unload <plist>`` — list-form subprocess (T-02-01)."""
        subprocess.run(
            ["launchctl", "unload", str(self._agents / f"{name}.plist")],
            check=False,
        )

    def status(self, name: str) -> str:
        """Neutral status: "running" if loaded, "stopped" if not, "unknown" on failure.

        Parses ``launchctl list`` stdout (doctor.py:220-222 pattern); never
        surfaces a raw launchctl exit code or output line (D-09 / T-02-03).
        """
        try:
            result = subprocess.run(
                ["launchctl", "list"],
                capture_output=True,
                text=True,
                check=False,
            )
        except OSError:
            return _STATUS_UNKNOWN
        if result.returncode != 0:
            return _STATUS_UNKNOWN
        for line in result.stdout.splitlines():
            if name in line:
                return _STATUS_RUNNING
        return _STATUS_STOPPED
