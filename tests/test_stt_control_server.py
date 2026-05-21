import asyncio
import json
import sys
import tempfile
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import MockSTTBackend


def _short_sock_dir():
    """Return a short socket dir under /tmp to stay within macOS AF_UNIX 104-char limit."""
    return Path(tempfile.mkdtemp(dir="/tmp"))


def _build_app(tmp_path):
    db = tmp_path / "vocab.sqlite"
    repo = VocabRepo(open_db(db))
    repo.add(term="Kubernetes", canonical="Kubernetes", scope=Scope.PROMPT)
    repo.add(term="github", canonical="GitHub", scope=Scope.BOTH)
    sock_dir = _short_sock_dir()
    cfg = DaemonConfig(
        socket_path=sock_dir / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backends = {"mlx": MockSTTBackend(canned_text="HELLO github world")}
    return STTDaemonApp(cfg, backends=backends)


async def _send(socket_path: Path, lines: list[str]) -> list[str]:
    reader, writer = await asyncio.open_unix_connection(str(socket_path))
    for line in lines:
        writer.write((line if line.endswith("\n") else line + "\n").encode())
    await writer.drain()
    results: list[str] = []
    for _ in lines:
        line = await reader.readline()
        if not line:
            break
        results.append(line.decode())
    writer.close()
    try:
        await writer.wait_closed()
    except (ConnectionResetError, BrokenPipeError):
        pass
    return results


def test_health_returns_loaded(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            results = await _send(app.config.socket_path, ['{"type":"health"}'])
            return results
        finally:
            await app.stop()
    results = asyncio.run(go())
    payload = json.loads(results[0])
    assert payload["type"] == "health_response"
    assert payload["vocab_size"] >= 2


def test_transcribe_applies_vocab(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            # NOTE: the audio_path must exist for the daemon to accept the
            # transcribe request — create a dummy file before the request.
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "final_transcribe",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
                "audio_offset_bytes": 0,
                "audio_length_bytes": None,
                "audio_format": "wav-pcm-s16le-16k-mono",
                "meeting_title": "T",
                "session_id": None,
                "word_timestamps": False,
                "condition_on_previous": True,
                "hallucination_silence_threshold": 2.0,
                "timeout_sec": 7200,
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return results
        finally:
            await app.stop()
    payload = json.loads(asyncio.run(go())[0])
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    # MockSTTBackend returns "HELLO github world"; cache should rewrite to GitHub
    assert "GitHub" in payload["text"]
    # initial_prompt should contain Kubernetes (the only prompt term we added)
    assert payload["vocab_prompt_terms_count"] >= 1


def test_vocab_reload_applies_new_rows(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            # add a new row + send reload
            repo = VocabRepo(open_db(app.config.vocab_db_path))
            repo.add(term="hello", canonical="HELLO!!", scope=Scope.BOTH)
            results = await _send(app.config.socket_path, ['{"type":"vocab_reload"}'])
            payload = json.loads(results[0])
            return payload
        finally:
            await app.stop()
    payload = asyncio.run(go())
    assert payload["type"] == "vocab_reloaded"
    assert payload["replace_rules"] >= 2
