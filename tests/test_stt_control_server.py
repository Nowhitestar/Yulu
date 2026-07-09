import asyncio
import json
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from vocab import VocabRepo, Scope, open_db
from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.protocol import JobKind
from stt_daemon.runtime import MockSTTBackend
from socket_helpers import short_socket_dir


def _short_sock_dir():
    """Return a short socket dir under /tmp to stay within macOS AF_UNIX 104-char limit."""
    return short_socket_dir()


def _build_app(tmp_path, *, backend=None):
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
    backends = {"mlx": backend or MockSTTBackend(canned_text="HELLO github world")}
    return STTDaemonApp(cfg, backends=backends)


def test_mlx_english_translate_keeps_final_backend_when_realtime_available():
    app = object.__new__(STTDaemonApp)
    app.runtime = type("Runtime", (), {"backends": {"mlx": object(), "mlx-realtime": object()}})()

    assert (
        app._resolve_job_engine(
            JobKind.DICTATION,
            "mlx",
            dictation_mode="translate",
            target_language="English",
        )
        == "mlx"
    )
    assert (
        app._resolve_job_engine(
            JobKind.DICTATION,
            "mlx",
            dictation_mode="dictate",
            target_language="",
        )
        == "mlx-realtime"
    )


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


def test_dictation_context_prompt_is_injected_with_vocab(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "dictation",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
                "context_prompt": "可直接粘贴，补齐标点。",
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            backend = app.runtime.backends["mlx"]
            return json.loads(results[0]), backend.last_initial_prompt
        finally:
            await app.stop()
    payload, prompt = asyncio.run(go())
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    assert "可直接粘贴" in prompt
    assert "Kubernetes" in prompt
    assert "GitHub" in payload["text"]
    assert payload["vocab_replacements_count"] >= 1


def test_dictation_options_reach_backend(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "dictation",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
                "dictation_mode": "translate",
                "target_language": "English",
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            backend = app.runtime.backends["mlx"]
            return json.loads(results[0]), backend.last_options
        finally:
            await app.stop()
    payload, options = asyncio.run(go())
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    assert options["job_kind"] == "dictation"
    assert options["dictation_mode"] == "translate"
    assert options["target_language"] == "English"


def test_dictation_mlx_uses_realtime_backend_when_available(tmp_path):
    async def go():
        realtime_backend = MockSTTBackend(canned_text="fast dictation")
        final_backend = MockSTTBackend(canned_text="slow final")
        app = _build_app(
            tmp_path,
            backend=final_backend,
        )
        app.runtime.backends["mlx-realtime"] = realtime_backend
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "dictation",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0]), final_backend.calls, realtime_backend.calls
        finally:
            await app.stop()
    payload, final_calls, realtime_calls = asyncio.run(go())
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    assert payload["engine_used"] == "mlx"
    assert payload["text"] == "fast dictation"
    assert final_calls == 0
    assert realtime_calls == 1


def test_dictation_mlx_translate_to_english_uses_final_backend(tmp_path):
    async def go():
        realtime_backend = MockSTTBackend(canned_text="中文原文")
        final_backend = MockSTTBackend(canned_text="english translation")
        app = _build_app(tmp_path, backend=final_backend)
        app.runtime.backends["mlx-realtime"] = realtime_backend
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "dictation",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
                "dictation_mode": "translate",
                "target_language": "English",
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0]), final_backend.calls, realtime_backend.calls
        finally:
            await app.stop()
    payload, final_calls, realtime_calls = asyncio.run(go())
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    assert payload["text"] == "english translation"
    assert final_calls == 1
    assert realtime_calls == 0


def test_final_transcribe_mlx_keeps_final_backend_when_realtime_available(tmp_path):
    async def go():
        realtime_backend = MockSTTBackend(canned_text="fast dictation")
        final_backend = MockSTTBackend(canned_text="slow final")
        app = _build_app(tmp_path, backend=final_backend)
        app.runtime.backends["mlx-realtime"] = realtime_backend
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "final_transcribe",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0]), final_backend.calls, realtime_backend.calls
        finally:
            await app.stop()
    payload, final_calls, realtime_calls = asyncio.run(go())
    assert payload["type"] == "transcribe_result"
    assert payload["status"] == "ok"
    assert payload["text"] == "slow final"
    assert final_calls == 1
    assert realtime_calls == 0


def test_transcribe_request_timeout_returns_error(tmp_path):
    async def go():
        app = _build_app(tmp_path, backend=MockSTTBackend(canned_text="late", delay_sec=2.0))
        await app.start()
        try:
            audio = tmp_path / "dummy.wav"
            audio.write_bytes(b"RIFFstub")
            req = {
                "type": "transcribe",
                "job_id": str(uuid.uuid4()),
                "kind": "dictation",
                "engine": "mlx",
                "language": "zh",
                "audio_path": str(audio),
                "timeout_sec": 1,
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0])
        finally:
            await app.stop()
    payload = asyncio.run(go())
    assert payload["type"] == "error"
    assert payload["code"] == "INTERNAL"
    assert "timed out after 1s" in payload["message"]


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


import wave


def _write_wav(path, seconds=1.0, rate=16000):
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x10" * n)


def test_subscribe_session_returns_ok(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            wav = tmp_path / "rec.wav"
            _write_wav(wav, seconds=1.0)
            req = {
                "type": "subscribe_session",
                "sid": "test-sid",
                "mic_path": str(wav),
                "sys_path": None,
                "engine": "mlx",
                "language": "zh",
                "chunk_sec": 10,
            }
            results = await _send(app.config.socket_path, [json.dumps(req)])
            return json.loads(results[0])
        finally:
            await app.stop()
    payload = asyncio.run(go())
    assert payload["type"] == "ok"
    assert "subscribed" in payload["detail"]


def test_unsubscribe_session_triggers_final(tmp_path):
    async def go():
        app = _build_app(tmp_path)
        await app.start()
        try:
            wav = tmp_path / "rec.wav"
            _write_wav(wav, seconds=1.0)
            req_sub = {
                "type": "subscribe_session",
                "sid": "fin-sid",
                "mic_path": str(wav),
                "sys_path": None,
                "engine": "mlx",
                "language": "zh",
                "chunk_sec": 10,
            }
            req_unsub = {
                "type": "unsubscribe_session",
                "sid": "fin-sid",
                "reason": "stopped",
            }
            results = await _send(app.config.socket_path, [json.dumps(req_sub), json.dumps(req_unsub)])
            return [json.loads(r) for r in results]
        finally:
            await app.stop()
    payloads = asyncio.run(go())
    assert payloads[0]["type"] == "ok"
    assert payloads[1]["type"] == "ok"
