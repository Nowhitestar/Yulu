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
            # Large StreamReader limit (asyncio default is 64 KiB). A full transcript
            # of a long recording is ONE JSON line that easily exceeds 64 KiB, and the
            # default limit makes reader.readline() raise "Separator is not found, and
            # chunk exceed the limit" — which silently broke full (re)transcription of
            # hour-long recordings. 64 MiB covers any realistic single-recording payload.
            asyncio.open_unix_connection(str(socket_path), limit=2 ** 26),
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
    channel_split: bool = False,
) -> dict[str, Any]:
    """Synchronously transcribe one audio file via the running stt_daemon.

    Returns the daemon's `transcribe_result` payload (dict). Raises
    `DaemonUnavailable` if the daemon is not running. Retries once if the
    daemon closes the connection mid-request (covers daemon-restart races).

    When `channel_split=True`, the daemon classifies the WAV via WavLayout
    and may return a `channels` dict with per-channel results (DUAL_TRACK).
    MONO / LEGACY_STEREO inputs still return a single `text`/`segments` pair.
    Defaults to False to keep existing callers behaving exactly as before.
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
        "channel_split": channel_split,
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


def request_final_transcribe(
    *,
    wav: str,
    title: Optional[str] = None,
    language: str = "zh",
    engine: str = "mlx",
    channel_split: bool = False,
    session_id: Optional[str] = None,
    socket_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Thin wrapper around :func:`transcribe_file` for post-recording callers.

    Uses the `final_transcribe` kind and returns the raw daemon payload. The
    Phase 3 orchestrator in `transcribe.py` calls this with
    `channel_split=True` so dual-track WAVs come back with `channels` set.
    """
    return transcribe_file(
        audio_path=wav,
        engine=engine,
        language=language,
        meeting_title=title,
        session_id=session_id,
        kind="final_transcribe",
        channel_split=channel_split,
        socket_path=socket_path,
    )


def request_diarize(
    *,
    wav: str,
    num_speakers: Optional[int] = None,
    threshold: Optional[float] = None,
    language: Optional[str] = None,
    timeout_sec: int = 7200,
    socket_path: Optional[Path] = None,
    connect_timeout_sec: float = 5.0,
    response_timeout_sec: float = 7200.0,
) -> dict[str, Any]:
    """Ask the running stt_daemon to diarize one audio file (v0.6, Phase 13).

    Mirrors :func:`request_final_transcribe` but speaks the ``diarize`` message and returns the
    daemon's ``diarize_result`` payload (a dict with ``turns``: ``[{start, end, speaker_idx,
    speaker}]``). ``num_speakers`` / ``threshold`` carry the Phase-12 count-strategy decision for
    THIS call (None / <=0 ⇒ auto threshold clustering).

    Raises:
        DaemonUnavailable: the daemon socket can't be reached (degrade to no-diarization).
        DaemonError: the daemon returned an error event — e.g. ``diarization not configured`` when
            no backend is built, or sherpa missing (the live-runtime Python-3.14 case). Callers in
            ``transcribe.py`` catch BOTH and fall back to today's plain transcript.
    """
    socket_path = Path(socket_path or DEFAULT_SOCKET)
    request = {
        "type": "diarize",
        "job_id": str(uuid.uuid4()),
        "audio_path": str(Path(wav).resolve()),
        "num_speakers": num_speakers,
        "threshold": threshold,
        "language": language,
        "timeout_sec": timeout_sec,
    }
    response = _run_with_retry(
        socket_path, request,
        connect_timeout_sec=connect_timeout_sec,
        response_timeout_sec=response_timeout_sec,
    )
    if response.get("type") == "error":
        raise DaemonError(response.get("message", "daemon error"))
    if response.get("type") != "diarize_result":
        raise DaemonError(f"unexpected response: {response.get('type')}")
    return response
