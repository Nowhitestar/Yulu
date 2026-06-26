"""macOS audio capture controller backed by the existing audio daemon socket."""

from __future__ import annotations

import json
import platform
import socket
from pathlib import Path
from typing import Callable, Optional

from yulu_platform.base import AudioCaptureController

SocketSend = Callable[[dict], Optional[dict]]


class MacOSAudioCaptureController(AudioCaptureController):
    """Control capture through ``audio_daemon.sock`` behind a neutral seam.

    The socket path and JSON action names are macOS-arm details. Callers use the
    neutral ``start``/``stop``/``status``/``windows`` methods; this adapter
    translates them to the existing daemon protocol without changing that
    protocol or the Swift daemon.
    """

    def __init__(
        self,
        socket_path: Path | None = None,
        *,
        socket_send: SocketSend | None = None,
        timeout: float = 15.0,
    ) -> None:
        if platform.system() != "Darwin":
            raise RuntimeError("MacOSAudioCaptureController requires macOS")
        self.socket_path = socket_path or Path.home() / ".config/yulu/audio_daemon.sock"
        self.timeout = timeout
        self._socket_send = socket_send

    def start(self, payload: dict) -> dict | None:
        return self._send({**payload, "action": "start"})

    def stop(self) -> dict | None:
        return self._send({"action": "stop"})

    def status(self) -> dict | None:
        return self._send({"action": "status"})

    def windows(self) -> dict | None:
        return self._send({"action": "windows"})

    def _send(self, command: dict) -> dict | None:
        if self._socket_send is not None:
            return self._socket_send(command)
        if not self.socket_path.exists():
            return None
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(self.timeout)
                sock.connect(str(self.socket_path))
                sock.sendall(json.dumps(command).encode())
                sock.shutdown(socket.SHUT_WR)
                data = b""
                while True:
                    chunk = sock.recv(4096)
                    if not chunk:
                        break
                    data += chunk
            return json.loads(data.decode()) if data else None
        except Exception:
            return None
