import asyncio
import json
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.live_session import LiveSession, LiveSessionManager, TailState
from stt_daemon.protocol import JobKind, PartialEvent
from stt_daemon.runtime import MockSTTBackend, STTRuntime
from stt_daemon.scheduler import STTScheduler
from stt_daemon.vocab_cache import VocabCache


def _write_wav(path: Path, samples_per_second: int = 16000, seconds: float = 1.0) -> None:
    """Write a valid 16kHz mono PCM WAV with constant tone."""
    n = int(samples_per_second * seconds)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)  # 16-bit
        wf.setframerate(samples_per_second)
        wf.writeframes(b"\x00\x10" * n)


def _append_pcm(path: Path, seconds: float, samples_per_second: int = 16000) -> None:
    """Append more PCM bytes to an existing WAV without fixing header."""
    n = int(samples_per_second * seconds)
    with open(path, "ab") as f:
        f.write(b"\x00\x10" * n)


def _build_minimal_app(tmp_path):
    backend = MockSTTBackend(canned_text="partial-chunk", delay_sec=0.0)
    runtime = STTRuntime(backends={"mlx": backend})
    scheduler = STTScheduler(runtime=runtime)
    cache = VocabCache(tmp_path / "vocab.sqlite")
    cache.load()
    return backend, runtime, scheduler, cache


def test_tail_state_roundtrip(tmp_path):
    state = TailState(
        sid="s1",
        mic_path=str(tmp_path / "mic.wav"),
        sys_path=None,
        engine="mlx",
        language="zh",
        chunk_sec=10,
        mic_offset_bytes=4096,
        sys_offset_bytes=0,
        next_seq=3,
        started_at="2026-05-22T10:00:00Z",
        last_partial_at="2026-05-22T10:00:30Z",
    )
    state_path = tmp_path / "session.tail.json"
    state.persist(state_path)
    loaded = TailState.load(state_path)
    assert loaded == state


def test_manager_emits_partial_when_audio_grows(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)  # initial 1s = 32000 bytes (header skipped)

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)
    received: list[PartialEvent] = []

    async def go():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=tmp_path / "sessions",
            on_partial=lambda evt: received.append(evt),
        )
        sid = "abc"
        await mgr.start_session(LiveSession(
            sid=sid,
            mic_path=str(wav_path),
            sys_path=None,
            engine="mlx",
            language="zh",
            chunk_sec=0.5,  # short for test
        ))
        # Append more audio so a chunk is ready
        _append_pcm(wav_path, seconds=0.6)
        await mgr.poll_once(sid)
        await asyncio.sleep(0.1)
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()

    asyncio.run(go())
    assert any(evt.source == "mic" for evt in received), f"no mic partial emitted: {received}"


def test_manager_persists_offset_across_restart(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)

    async def first():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=tmp_path / "sessions",
            on_partial=lambda evt: None,
        )
        sid = "persist-test"
        await mgr.start_session(LiveSession(
            sid=sid,
            mic_path=str(wav_path),
            sys_path=None,
            engine="mlx",
            language="zh",
            chunk_sec=0.5,
        ))
        _append_pcm(wav_path, seconds=0.6)
        await mgr.poll_once(sid)
        await mgr.flush_state(sid)
        await scheduler.stop()
        return mgr.tail_state_path(sid)

    state_path = asyncio.run(first())
    state = TailState.load(state_path)
    assert state.mic_offset_bytes > 0


def test_manager_recovers_active_sessions_from_disk(tmp_path):
    wav_path = tmp_path / "rec.wav"
    _write_wav(wav_path, seconds=1.0)
    sessions_dir = tmp_path / "sessions"
    sessions_dir.mkdir()
    TailState(
        sid="recover-me",
        mic_path=str(wav_path),
        sys_path=None,
        engine="mlx",
        language="zh",
        chunk_sec=0.5,
        mic_offset_bytes=44,  # WAV header only
        sys_offset_bytes=0,
        next_seq=0,
        started_at="2026-05-22T10:00:00Z",
        last_partial_at="2026-05-22T10:00:00Z",
    ).persist(sessions_dir / "recover-me.tail.json")

    backend, runtime, scheduler, cache = _build_minimal_app(tmp_path)

    async def go():
        await scheduler.start()
        mgr = LiveSessionManager(
            scheduler=scheduler,
            vocab_cache=cache,
            sessions_dir=sessions_dir,
            on_partial=lambda evt: None,
        )
        recovered = mgr.recover_from_disk()
        await scheduler.stop()
        return recovered

    recovered = asyncio.run(go())
    assert "recover-me" in recovered
