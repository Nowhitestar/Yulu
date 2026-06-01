"""macOS arm of the ``PermissionModel`` seam (PLAT-05 / D-08).

Reports capture-permission status behind the frozen ``PermissionModel`` ABC.
``check`` takes an ABSTRACT capability token ("microphone", "system-audio-capture")
— never a consent-database scope string (D-09). It reads the live daemon's
``sysReady``/``micReady`` over the existing ``audio_daemon.sock`` ``{"action":"status"}``
probe (the same read doctor.py:60-85 already performs); there is no public API to
query the tap authorization directly, so liveness IS the signal (02-RESEARCH §82-87).

This seam only REPORTS status and at most RESETS a stale grant (``reset()``); it
never attempts to GRANT capture permission — impossible by macOS design and
explicitly forbidden (ASVS V4, 02-RESEARCH §560-575). ``check()`` has no grant path.

Every consent-database (``tccutil``) interaction is gated behind a Darwin check
(D-08), shares the constructor idiom with the Wave-1 seams, and is list-form
``subprocess.run([...])`` — the shell is never invoked and no external value is
interpolated into a command (threat T-02-05).

The platform scope name lives ONLY inside ``reset()``'s body via the private
token→service map — it never appears in any method signature (D-09).

stdlib only (platform, subprocess, socket, json, pathlib).
"""

from __future__ import annotations

import json
import platform
import socket
import subprocess
from pathlib import Path

from yulu_platform.base import PermissionModel

# Platform-neutral status vocabulary the ABC promises (never a raw TCC verdict).
_GRANTED = "granted"
_DENIED = "denied"
_UNKNOWN = "unknown"

# Abstract capability token → the daemon-status field that reflects it.
# Tokens are the ONLY values a caller passes; scope names stay internal.
_TOKEN_TO_STATUS_FIELD = {
    "microphone": "micReady",
    "system-audio-capture": "sysReady",
}

# Abstract capability token → the consent-database service to reset.
# This map (and the scope strings in it) is confined to this module body and is
# consulted ONLY by ``reset()`` — no scope name reaches a public signature (D-09).
_TOKEN_TO_RESET_SERVICE = {
    "microphone": "Microphone",
    "system-audio-capture": "ScreenCapture",
}

# The daemon control-channel socket and the audio daemon's bundle identifier.
_SOCKET_SUBPATH = ".config/yulu/audio_daemon.sock"
_BUNDLE_ID = "com.yulu.audiodaemon"


class MacOSPermissionModel(PermissionModel):
    """Report (and at most reset) capture permissions behind the neutral ABC."""

    def __init__(self) -> None:
        if platform.system() != "Darwin":  # D-08 Darwin gate (shared with the Wave-1 seams)
            raise RuntimeError("MacOSPermissionModel requires macOS")

    def check(self, capability: str) -> str:
        """Neutral status for an abstract capability token.

        "microphone" → micReady, "system-audio-capture" → sysReady, read from the
        daemon's ``{"action":"status"}`` reply. Returns "granted"/"denied"/"unknown".
        An unknown token, an absent socket, or a probe failure all degrade to
        "unknown" — never a crash (threat T-02-07: no raw error surfaced).
        """
        field = _TOKEN_TO_STATUS_FIELD.get(capability)
        if field is None:
            return _UNKNOWN

        status = self._probe_daemon()
        if status is None:
            return _UNKNOWN

        ready = status.get(field)
        if ready is True:
            return _GRANTED
        if ready is False:
            return _DENIED
        return _UNKNOWN

    def reset(self, capability: str) -> None:
        """Reset a stale grant for an abstract capability token (Darwin-gated).

        Maps the token to its consent-database service INTERNALLY and runs the
        reset list-form (threat T-02-05). No-ops for an unknown token. The scope
        string never leaves this method body (D-09). This only clears stale state
        so the user can re-approve in System Settings; it cannot grant access.
        """
        if platform.system() != "Darwin":  # D-08: never shell out off Darwin
            return
        service = _TOKEN_TO_RESET_SERVICE.get(capability)
        if service is None:
            return
        # List-form only; the two args are fixed internal strings, not caller input.
        subprocess.run(["tccutil", "reset", service, _BUNDLE_ID], check=False)

    def _probe_daemon(self, timeout: float = 3.0) -> dict | None:
        """Read the daemon's status over the Unix socket; None on any failure.

        Ports the connect/sendall/SHUT_WR/recv sequence from doctor.py:64-73 —
        the read-only ``{"action":"status"}`` probe (threat T-02-08: no other
        action is sent). Never raises; a missing socket or bad reply → None.
        """
        sock_path = Path.home() / _SOCKET_SUBPATH
        if not sock_path.exists():
            return None
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
                s.settimeout(timeout)
                s.connect(str(sock_path))
                s.sendall(b'{"action":"status"}\n')
                s.shutdown(socket.SHUT_WR)
                data = s.recv(4096)
            parsed = json.loads(data.decode("utf-8", errors="replace"))
        except Exception:
            return None
        return parsed if isinstance(parsed, dict) else None
