"""macOS platform arm — concrete impls of the frozen ``yulu_platform`` seams (D-17)."""

from __future__ import annotations

from .audio_capture import MacOSAudioCaptureController
from .daemon_manager import MacOSDaemonManager
from .dependency_manager import MacOSDependencyManager
from .path_resolver import MacOSPathResolver
from .permission_model import MacOSPermissionModel

__all__ = [
    "MacOSAudioCaptureController",
    "MacOSDaemonManager",
    "MacOSDependencyManager",
    "MacOSPathResolver",
    "MacOSPermissionModel",
]
