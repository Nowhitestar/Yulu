"""macOS arm of the ``DependencyManager`` seam (PLAT-05 / D-08).

Wraps Homebrew behind the frozen ``DependencyManager`` ABC — named only by the
dependency, never by the package manager in any signature (D-09). ``is_available``
reports presence (``brew list`` or, for binaries, ``shutil.which``); ``install``
provisions via ``brew install``.

Scope boundary (02-RESEARCH §502, REQUIREMENTS): this seam NEVER auto-installs
Homebrew itself. If brew is absent, ``is_available`` returns ``False`` (it does not
raise) and ``install`` raises a fixed ``RuntimeError`` — bootstrapping Homebrew is
out of scope for this milestone.

Every brew call is gated behind a Darwin check (D-08, shared constructor idiom with
the Wave-1 seams) and is list-form ``subprocess.run([...])`` — the shell is never
invoked and no external value is interpolated into a command (threat T-02-05).
Errors surface a fixed message; raw brew stderr is never echoed back (threat T-02-07).

stdlib only (platform, shutil, subprocess).
"""

from __future__ import annotations

import platform
import shutil
import subprocess

from yulu_platform.base import DependencyManager

# The package manager binary this seam wraps. Confined to this module body.
_BREW = "brew"
_NOT_AVAILABLE_MSG = "Homebrew not available; cannot install dependencies"
_BREW_DETECT_TIMEOUT_SECONDS = 5


class MacOSDependencyManager(DependencyManager):
    """Detect and provision external dependencies via Homebrew, behind the neutral ABC."""

    def __init__(self) -> None:
        if platform.system() != "Darwin":  # D-08 Darwin gate (shared with the Wave-1 seams)
            raise RuntimeError("MacOSDependencyManager requires macOS")

    def is_available(self, name: str) -> bool:
        """True if ``name`` is installed (on PATH or ``brew list``); False otherwise.

        Checks ``shutil.which`` first for plain binaries. Only if PATH misses does
        it try ``brew list <name>`` with a short timeout. If neither path finds it,
        returns ``False`` rather than raising (threat T-02-07: no raw brew stderr
        surfaced).
        """
        if shutil.which(name):
            return True
        if shutil.which(_BREW):
            try:
                result = subprocess.run(
                    [_BREW, "list", name],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=_BREW_DETECT_TIMEOUT_SECONDS,
                )
            except (OSError, subprocess.TimeoutExpired):
                result = None
            if result is not None and result.returncode == 0:
                return True
        # Fallback: a brew-managed formula often also exposes a same-named binary,
        # and some deps are plain binaries not tracked by brew.
        return False

    def install(self, name: str) -> None:
        """``brew install <name>`` (list-form). Raises if Homebrew is absent.

        Never bootstraps Homebrew itself (02-RESEARCH §502 / REQUIREMENTS) — a fixed
        ``RuntimeError`` is raised instead so no raw shell error leaks (threat T-02-07).
        """
        if platform.system() != "Darwin" or not shutil.which(_BREW):  # D-08 + scope guard
            raise RuntimeError(_NOT_AVAILABLE_MSG)
        # List-form only; ``name`` is the dependency identifier, never interpolated
        # into a shell string (threat T-02-05).
        subprocess.run([_BREW, "install", name], check=True)
