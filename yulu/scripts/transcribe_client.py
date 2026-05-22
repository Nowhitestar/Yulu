"""Synchronous RPC client for the stt_daemon.

Used by transcribe.py and any other Python caller that needs file-level
transcription. Hides the asyncio surface behind a blocking function.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from pathlib import Path
from typing import Any, Optional

DEFAULT_SOCKET = Path.home() / ".config" / "yulu" / "stt_daemon.sock"


class DaemonUnavailable(Exception):
    """The daemon socket cannot be reached / connect timed out."""


class DaemonEOF(Exception):
    """Daemon closed the connection without a response."""


class DaemonError(Exception):
    """Daemon returned an error event."""


async def _send_once(
    socket_path: Path,
    request: dict,
    *,
    timeout: float,
    response_timeout: float,
) -> dict:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_unix_connection(str(socket_path)),
            timeout=timeout,
        )
    except (FileNotFoundError, ConnectionRefusedError) as exc:
        raise DaemonUnavailable(str(exc)) from exc
    except asyncio.TimeoutError as exc:
        raise DaemonUnavailable("connect timeout") from exc

    try:
        writer.write((json.dumps(request) + "\n").encode())
        await writer.drain()
        try:
            line = await asyncio.wait_for(reader.readline(), timeout=response_timeout)
        except asyncio.TimeoutError as exc:
            raise DaemonUnavailable("response timeout") from exc
        if not line:
            raise DaemonEOF("socket closed before response")
        return json.loads(line.decode())
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except (ConnectionResetError, BrokenPipeError):
            pass


def _run_with_retry(
    socket_path: Path,
    request: dict,
    *,
    connect_timeout_sec: float,
    response_timeout_sec: float,
) -> dict:
    last_exc: Optional[Exception] = None
    for attempt in (1, 2):
        try:
            return asyncio.run(_send_once(
                socket_path, request,
                timeout=connect_timeout_sec,
                response_timeout=response_timeout_sec,
            ))
        except DaemonEOF as exc:
            last_exc = exc
            continue
        except DaemonUnavailable:
            raise
    raise DaemonUnavailable(f"retries exhausted: {last_exc}")


def transcribe_file(
    *,
    audio_path: str,
    engine: str = "mlx",
    language: str = "zh",
    meeting_title: Optional[str] = None,
    session_id: Optional[str] = None,
    kind: str = "final_transcribe",
    word_timestamps: bool = False,
    condition_on_previous: bool = True,
    hallucination_silence_threshold: float = 2.0,
    timeout_sec: int = 7200,
    socket_path: Optional[Path] = None,
    connect_timeout_sec: float = 5.0,
    response_timeout_sec: float = 7200.0,
) -> dict[str, Any]:
    """Synchronously transcribe one audio file via the running stt_daemon.

    Returns the daemon's `transcribe_result` payload (dict). Raises
    `DaemonUnavailable` if the daemon is not running. Retries once if the
    daemon closes the connection mid-request (covers daemon-restart races).
    """
    socket_path = Path(socket_path or DEFAULT_SOCKET)
    request = {
        "type": "transcribe",
        "job_id": str(uuid.uuid4()),
        "kind": kind,
        "engine": engine,
        "language": language,
        "audio_path": str(Path(audio_path).resolve()),
        "audio_offset_bytes": 0,
        "audio_length_bytes": None,
        "audio_format": "wav-pcm-s16le-16k-mono",
        "meeting_title": meeting_title,
        "session_id": session_id,
        "word_timestamps": word_timestamps,
        "condition_on_previous": condition_on_previous,
        "hallucination_silence_threshold": hallucination_silence_threshold,
        "timeout_sec": timeout_sec,
    }
    response = _run_with_retry(
        socket_path, request,
        connect_timeout_sec=connect_timeout_sec,
        response_timeout_sec=response_timeout_sec,
    )
    if response.get("type") == "error":
        raise DaemonError(response.get("message", "daemon error"))
    if response.get("type") != "transcribe_result":
        raise DaemonError(f"unexpected response: {response.get('type')}")
    return response
