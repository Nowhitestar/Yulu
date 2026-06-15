"""E2E tests against a real mlx-whisper model. Opt-in via `pytest -m e2e`.

Skipped by default. To run locally:
  pytest -m e2e tests/test_e2e_stt_daemon.py -v
Requires:
  - mlx-whisper installed in the python on PATH
  - tests/fixtures/audio/tiny_10s.wav present (you provide it)
"""

import asyncio
import importlib
import json
import os
import sys
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))
from socket_helpers import short_socket_dir

FIXTURE = ROOT / "tests" / "fixtures" / "audio" / "tiny_10s.wav"


pytestmark = pytest.mark.e2e
RUN_E2E = os.environ.get("YULU_RUN_E2E") == "1"


def _mlx_available() -> bool:
    try:
        importlib.import_module("mlx_whisper")
        return True
    except (ImportError, RuntimeError):
        return False


@pytest.mark.skipif(not RUN_E2E, reason="set YULU_RUN_E2E=1 to run real MLX e2e tests")
@pytest.mark.skipif(RUN_E2E and not _mlx_available(), reason="mlx_whisper not installed")
@pytest.mark.skipif(not FIXTURE.exists(), reason="fixture audio missing — add tests/fixtures/audio/tiny_10s.wav")
def test_real_mlx_round_trip(tmp_path):
    from vocab import VocabRepo, Scope, open_db
    from stt_daemon.app import STTDaemonApp
    from stt_daemon.config import DaemonConfig
    from stt_daemon.backends.mlx import MlxWhisperBackend

    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))  # ensure schema
    # AF_UNIX path-length limit on macOS: allocate the socket in a short /tmp/
    # dir (pytest's tmp_path is under /private/var/folders/... which exceeds the
    # 104-byte limit).
    sock_dir = short_socket_dir()
    cfg = DaemonConfig(
        socket_path=sock_dir / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MlxWhisperBackend(model="mlx-community/whisper-large-v3-mlx", language="zh")}
    app = STTDaemonApp(cfg, backends=backends)

    async def go():
        await app.start()
        try:
            reader, writer = await asyncio.open_unix_connection(str(cfg.socket_path))
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "final_transcribe",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(FIXTURE),
                "audio_offset_bytes": 0,
                "audio_length_bytes": None,
                "audio_format": "wav-pcm-s16le-16k-mono",
                "meeting_title": "E2E",
                "session_id": None,
                "word_timestamps": False,
                "condition_on_previous": True,
                "hallucination_silence_threshold": 2.0,
                "timeout_sec": 7200,
            }
            writer.write((json.dumps(req) + "\n").encode())
            await writer.drain()
            line = await reader.readline()
            writer.close()
            await writer.wait_closed()
            return json.loads(line)
        finally:
            await app.stop()

    payload = asyncio.run(go())
    assert payload["status"] == "ok"
    assert len(payload["text"]) > 0
