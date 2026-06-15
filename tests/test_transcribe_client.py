import asyncio
import json
import sys
import threading
import time
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend
from transcribe_client import transcribe_file, DaemonUnavailable
from socket_helpers import short_socket_dir


def _spawn_cfg(tmp_path, text="ok output"):
    """Build a DaemonConfig + backends; AF_UNIX-safe socket path."""
    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    sock_dir = short_socket_dir()
    cfg = DaemonConfig(
        socket_path=sock_dir / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text=text), "whisper": MockSTTBackend(canned_text=text)}
    return cfg, backends


def _run_daemon_in_thread(cfg, backends):
    """Start the daemon in a background thread with its own event loop.
    Returns (thread, loop, stop_event). Wait briefly for socket to appear."""
    loop = asyncio.new_event_loop()
    started = threading.Event()
    stop = threading.Event()
    app_ref = {}

    def _worker():
        asyncio.set_event_loop(loop)
        app = STTDaemonApp(cfg, backends=backends)
        app_ref["app"] = app
        loop.run_until_complete(app.start())
        started.set()

        async def _wait_stop():
            while not stop.is_set():
                await asyncio.sleep(0.05)
            await app.stop()

        loop.run_until_complete(_wait_stop())
        loop.close()

    t = threading.Thread(target=_worker, daemon=True)
    t.start()
    started.wait(timeout=5.0)
    # Wait until socket exists (start() schedules listen).
    deadline = time.time() + 5.0
    while time.time() < deadline and not cfg.socket_path.exists():
        time.sleep(0.05)
    return t, loop, stop


def test_transcribe_file_round_trip(tmp_path):
    cfg, backends = _spawn_cfg(tmp_path, text="my transcript")
    t, loop, stop = _run_daemon_in_thread(cfg, backends)
    try:
        audio = tmp_path / "x.wav"
        audio.write_bytes(b"RIFFstub")
        result = transcribe_file(
            audio_path=str(audio),
            engine="mlx",
            language="zh",
            meeting_title="T",
            socket_path=cfg.socket_path,
        )
        assert result["status"] == "ok"
        assert "my transcript" in result["text"]
    finally:
        stop.set()
        t.join(timeout=5.0)


def test_transcribe_file_daemon_unavailable(tmp_path):
    audio = tmp_path / "x.wav"
    audio.write_bytes(b"R")
    # Use /tmp to stay within AF_UNIX 104-byte path limit on macOS.
    missing_sock = short_socket_dir(require_bind=False) / "missing.sock"
    with pytest.raises(DaemonUnavailable):
        transcribe_file(
            audio_path=str(audio),
            engine="mlx",
            language="zh",
            socket_path=missing_sock,
            connect_timeout_sec=0.5,
        )


def test_transcribe_file_retries_once_on_eof(tmp_path, monkeypatch):
    call_count = {"n": 0}
    import transcribe_client as tc

    real = tc._send_once

    async def flaky(socket_path, request, *, timeout, response_timeout):
        call_count["n"] += 1
        if call_count["n"] == 1:
            raise tc.DaemonEOF("simulated")
        return await real(socket_path, request, timeout=timeout, response_timeout=response_timeout)

    monkeypatch.setattr(tc, "_send_once", flaky)

    cfg, backends = _spawn_cfg(tmp_path, text="second try")
    t, loop, stop = _run_daemon_in_thread(cfg, backends)
    try:
        audio = tmp_path / "x.wav"
        audio.write_bytes(b"RIFF")
        result = transcribe_file(
            audio_path=str(audio),
            engine="mlx",
            language="zh",
            socket_path=cfg.socket_path,
        )
        assert result["status"] == "ok"
        assert call_count["n"] == 2
    finally:
        stop.set()
        t.join(timeout=5.0)
