"""macOS platform arm — concrete impls of the frozen ``yulu_platform`` seams (D-17)."""

from __future__ import annotations

from .daemon_manager import MacOSDaemonManager
from .path_resolver import MacOSPathResolver

__all__ = ["MacOSDaemonManager", "MacOSPathResolver"]
