#!/usr/bin/env python3
"""Realtime transcription via stt_daemon subscription.

Replaces the previous in-process mlx-whisper implementation. Subscribes
to the daemon's live session for the given audio file, accumulates the
partial events it pushes back, and writes them to
<audio>.realtime.transcript.txt as they arrive.

Invoked as a subprocess by record_audio.py; honors SIGTERM by sending
unsubscribe_session and exiting cleanly.
"""

from __future__ import annotations

import asyncio
import json
import signal
import sys
import uuid
from pathlib import Path
from typing import Optional


CONFIG_DIR = Path.home() / ".config" / "yulu"
DEFAULT_SOCKET = CONFIG_DIR / "stt_daemon.sock"
CONFIG_PATH = CONFIG_DIR / "config.json"


def _load_config() -> dict:
    if not CONFIG_PATH.exists():
        return {}
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _resolve_engine_lang(cfg: dict) -> tuple[str, str, float]:
    """Resolve engine, language, chunk_sec from config. Defaults: mlx, zh, 10."""
    trans = cfg.get("transcription", {}) if isinstance(cfg.get("transcription"), dict) else {}
    rt = trans.get("realtime", {}) if isinstance(trans.get("realtime"), dict) else {}
    engine = rt.get("engine") or trans.get("final_engine") or "mlx"
    language = rt.get("language") or trans.get("language") or "zh"
    chunk_sec = float(rt.get("chunk_sec") or 10)
    return engine, language, chunk_sec


async def subscribe_loop(
    *,
    audio_path: Path,
    output_path: Path,
    socket_path: Path,
    sid: str,
    engine: str,
    language: str,
    chunk_sec: float,
    stop_event: asyncio.Event,
) -> None:
    """Open a long-lived subscribe_session connection and accumulate partials."""
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    sub = {
        "type": "subscribe_session",
        "sid": sid,
        "mic_path": str(audio_path),
        "sys_path": None,
        "engine": engine,
        "language": language,
        "chunk_sec": chunk_sec,
    }
    writer.write((json.dumps(sub) + "\n").encode())
    await writer.drain()

    ack = await reader.readline()
    if not ack:
        print("daemon closed connection on subscribe", file=sys.stderr)
        return
    print(f"subscribed sid={sid}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    coverage_path = audio_path.with_suffix(".realtime.coverage.json")
    buffer: list[str] = []
    # Track how many audio-seconds the live tail actually transcribed. The
    # voicemail promote-to-final guard compares this against the WAV duration
    # so a realtime transcript that only covered the first minute of an
    # hour-long recording is NOT silently promoted as the final.
    covered_ms = 0

    def _write_coverage() -> None:
        try:
            coverage_path.write_text(
                json.dumps({"covered_ms": covered_ms}), encoding="utf-8"
            )
        except OSError:
            pass

    async def reader_loop() -> None:
        nonlocal covered_ms
        while True:
            line = await reader.readline()
            if not line:
                return
            try:
                msg = json.loads(line.decode())
            except json.JSONDecodeError:
                continue
            mtype = msg.get("type")
            if mtype == "partial":
                source = msg.get("source", "")
                tag = "Me" if source == "mic" else "Them"
                text = (msg.get("text") or "").strip()
                ended_ms = msg.get("ended_ms")
                if isinstance(ended_ms, (int, float)) and ended_ms > covered_ms:
                    covered_ms = int(ended_ms)
                    # M2: persist coverage whenever it advances, even for silent
                    # (text-less) partials, so a recording that ends in silence does
                    # not under-report how much audio the live tail actually covered
                    # (which would trigger an unnecessary full-transcribe fallback).
                    _write_coverage()
                if text:
                    buffer.append(f"[{tag}] {text}")
                    output_path.write_text("\n".join(buffer), encoding="utf-8")
            elif mtype == "final_ready":
                return

    reader_task = asyncio.create_task(reader_loop())
    stop_task = asyncio.create_task(stop_event.wait())
    done, pending = await asyncio.wait(
        [reader_task, stop_task], return_when=asyncio.FIRST_COMPLETED
    )
    for p in pending:
        p.cancel()

    if stop_event.is_set():
        unsub = {"type": "unsubscribe_session", "sid": sid, "reason": "stopped"}
        try:
            writer.write((json.dumps(unsub) + "\n").encode())
            await writer.drain()
        except (ConnectionResetError, BrokenPipeError):
            pass

    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionResetError, BrokenPipeError):
        pass


async def _async_main(audio_path: Path, title: str) -> int:
    socket_path = DEFAULT_SOCKET
    if not socket_path.exists():
        print(f"stt_daemon socket not found at {socket_path}", file=sys.stderr)
        return 2

    cfg = _load_config()
    engine, language, chunk_sec = _resolve_engine_lang(cfg)
    sid = f"rt-{uuid.uuid4().hex[:12]}"
    output_path = audio_path.with_suffix(".realtime.transcript.txt")

    stop_event = asyncio.Event()
    loop = asyncio.get_running_loop()

    def _handle_sig(sig):  # noqa: ARG001
        if not stop_event.is_set():
            stop_event.set()

    for s in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(s, _handle_sig, s)
        except NotImplementedError:
            pass

    print(f"realtime_transcribe: title={title!r} audio={audio_path} engine={engine} chunk_sec={chunk_sec}")
    try:
        await subscribe_loop(
            audio_path=audio_path,
            output_path=output_path,
            socket_path=socket_path,
            sid=sid,
            engine=engine,
            language=language,
            chunk_sec=chunk_sec,
            stop_event=stop_event,
        )
    except (ConnectionRefusedError, FileNotFoundError) as exc:
        print(f"daemon unavailable: {exc}", file=sys.stderr)
        return 3
    print("realtime_transcribe exiting")
    return 0


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    if len(argv) < 1:
        print("Usage: realtime_transcribe.py <audio.wav> [title]", file=sys.stderr)
        return 1
    audio_path = Path(argv[0]).expanduser().resolve()
    title = argv[1] if len(argv) > 1 else audio_path.stem
    if not audio_path.parent.exists():
        print(f"audio parent dir missing: {audio_path.parent}", file=sys.stderr)
        return 1
    return asyncio.run(_async_main(audio_path, title))


if __name__ == "__main__":
    sys.exit(main())
