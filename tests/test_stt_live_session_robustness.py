"""Realtime robustness regression tests (fix/realtime-robustness).

These cover the three failure modes behind the 1-hour-recording bug where the
live tail captured only ~1 chunk and the final ended up truncated:

1. A SLOW per-chunk transcription must NOT stall or drop the tail loop — it
   keeps tailing and drains the backlog (catch-up), and the subscriber
   connection is never reset by a slow chunk.
2. A backlog must be consumed in BOUNDED chunks (chunk_max_sec), not read as
   one giant mega-chunk that only gets slower.
3. The live tail runs the FAST realtime engine (mlx-realtime) while the final
   pass still uses the requested (slower, accurate) engine.

Everything is simulated with MockSTTBackend timing + in-process polling, so no
real model or 1-hour recording is needed.
"""

from __future__ import annotations

import asyncio
import json
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.live_session import LiveSession, LiveSessionManager
from stt_daemon.protocol import JobKind, PartialEvent, SubscribeSessionRequest
from stt_daemon.runtime import MockSTTBackend, STTRuntime, CancelToken
from stt_daemon.scheduler import STTScheduler
from stt_daemon.vocab_cache import VocabCache


SAMPLE_RATE_HZ = 16000
SAMPLE_BYTES = 2


def _write_wav(path: Path, seconds: float, rate: int = SAMPLE_RATE_HZ) -> None:
    n = int(rate * seconds)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_BYTES)
        wf.setframerate(rate)
        wf.writeframes(b"\x00\x10" * n)


def _append_pcm(path: Path, seconds: float, rate: int = SAMPLE_RATE_HZ) -> None:
    n = int(rate * seconds)
    with open(path, "ab") as f:
        f.write(b"\x00\x10" * n)


def _build(tmp_path, *, backend=None):
    backend = backend or MockSTTBackend(canned_text="partial", delay_sec=0.0)
    runtime = STTRuntime(backends={"mlx": backend})
    scheduler = STTScheduler(runtime=runtime)
    cache = VocabCache(tmp_path / "vocab.sqlite")
    cache.load()
    mgr = LiveSessionManager(
        scheduler=scheduler,
        vocab_cache=cache,
        sessions_dir=tmp_path / "sessions",
        on_partial=lambda evt: None,
    )
    return backend, scheduler, mgr


def test_slow_chunk_does_not_stall_or_drop_tail(tmp_path):
    """A chunk that takes longer than chunk_sec to transcribe must still be
    emitted, and subsequent audio must still be picked up (the loop keeps
    tailing rather than dying after one chunk).

    NOTE: start_session seeds the read offset to the file size at subscribe
    time (the live tail only transcribes NEW audio), so all audio under test is
    appended AFTER subscribe — exactly how a real recording grows."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)  # header only at subscribe time

    # Backend is SLOW relative to chunk_sec — this is exactly the large-v3
    # "can't keep up" scenario, just compressed in time.
    backend = MockSTTBackend(canned_text="slow", delay_sec=0.15)
    backend, scheduler, mgr = _build(tmp_path, backend=backend)
    received: list[PartialEvent] = []
    mgr.on_partial = lambda evt: received.append(evt)

    async def go():
        await scheduler.start()
        sid = "slow"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh", chunk_sec=0.05,
        ))
        # Kill the auto tail task; drive deterministically via poll_once.
        t = mgr._tail_tasks.pop(sid, None)
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        _append_pcm(wav, seconds=0.2)            # audio arrives
        await mgr.poll_once(sid)                 # first (slow) chunk
        _append_pcm(wav, seconds=0.2)            # more audio while "behind"
        await mgr.poll_once(sid)                 # must STILL pick up new audio
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()

    asyncio.run(go())
    # Two distinct chunks emitted despite the slow backend → loop didn't die.
    assert len(received) >= 2, f"slow chunk stalled the tail: {received!r}"
    assert backend.calls >= 2


def test_offset_advances_before_await_so_no_double_read(tmp_path):
    """The tail loop must advance the read offset BEFORE awaiting the slow
    transcribe, so the same bytes are never transcribed twice."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)
    backend = MockSTTBackend(canned_text="x", delay_sec=0.1)
    backend, scheduler, mgr = _build(tmp_path, backend=backend)

    async def go():
        await scheduler.start()
        sid = "noreread"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh", chunk_sec=0.05,
        ))
        t = mgr._tail_tasks.pop(sid, None)
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        _append_pcm(wav, seconds=0.2)
        await mgr.poll_once(sid)
        off1 = mgr._active[sid].state.mic_offset_bytes
        # No new audio appended → next poll should find nothing new.
        await mgr.poll_once(sid)
        off2 = mgr._active[sid].state.mic_offset_bytes
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()
        return off1, off2, backend.calls

    off1, off2, calls = asyncio.run(go())
    assert off1 == off2, "offset moved without new audio (double-read risk)"
    assert calls == 1, f"re-transcribed the same bytes: {calls} calls"


def test_backlog_is_consumed_in_bounded_chunks(tmp_path):
    """When the tail loop is far behind, a single read must be capped at
    chunk_max_sec rather than swallowing the whole backlog in one mega-chunk."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)  # empty at subscribe
    backend, scheduler, mgr = _build(tmp_path)
    durations_ms: list[int] = []
    mgr.on_partial = lambda evt: durations_ms.append(evt.ended_ms - evt.started_ms)

    async def go():
        await scheduler.start()
        sid = "backlog"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh",
            chunk_sec=1.0, chunk_max_sec=2.0,   # cap each chunk at 2s
        ))
        t = mgr._tail_tasks.pop(sid, None)
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        # 10 seconds of audio appears as one big backlog (simulating a tail
        # loop that fell far behind a long recording).
        _append_pcm(wav, seconds=10.0)
        await mgr.poll_once(sid)
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()

    asyncio.run(go())
    assert durations_ms, "no chunk emitted from backlog"
    # The single chunk must be ~2s (the cap), NOT ~10s (the whole backlog).
    assert durations_ms[0] <= 2200, f"chunk not bounded: {durations_ms[0]}ms"


def test_tail_loop_catches_up_on_backlog_without_external_polling(tmp_path):
    """End-to-end: with the real auto tail loop running, a pre-existing backlog
    is fully drained in bounded chunks (catch-up) — the loop does not stop
    after one chunk."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)
    backend, scheduler, mgr = _build(tmp_path)
    received: list[PartialEvent] = []
    mgr.on_partial = lambda evt: received.append(evt)

    async def go():
        await scheduler.start()
        sid = "catchup"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh",
            chunk_sec=0.5, chunk_max_sec=1.0,   # 6s / 1s ≈ 6 chunks to drain
        ))
        # 6s backlog appears; the auto tail loop must drain it in bounded
        # chunks via catch-up (looping without sleeping while behind), NOT
        # take 6 * chunk_sec = 3s. We only wait a fraction of that.
        _append_pcm(wav, seconds=6.0)
        await asyncio.sleep(0.5)
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()

    asyncio.run(go())
    # Backlog drained into multiple bounded chunks (catch-up), not just 1.
    assert len(received) >= 4, f"tail did not catch up on backlog: {len(received)} chunks"


def test_has_pending_chunk_detects_backlog(tmp_path):
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)
    backend, scheduler, mgr = _build(tmp_path)

    async def go():
        await scheduler.start()
        sid = "pend"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh", chunk_sec=1.0, chunk_max_sec=1.0,
        ))
        t = mgr._tail_tasks.pop(sid, None)
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        _append_pcm(wav, seconds=3.0)   # 3s backlog
        active = mgr._active[sid]
        before = mgr._has_pending_chunk(active)
        await mgr.poll_once(sid)   # consume 1s of the 3s backlog
        after = mgr._has_pending_chunk(active)
        await mgr.stop_session(sid, reason="stopped")
        await scheduler.stop()
        return before, after

    before, after = asyncio.run(go())
    assert before is True, "should see a full backlog before consuming"
    assert after is True, "2s still pending after consuming 1s of 3s"


# ─── Realtime engine selection (daemon-side) ──────────────────────────────


class _RecordingBackend(MockSTTBackend):
    """Tags its output so we can tell which backend transcribed a chunk."""

    def __init__(self, tag: str):
        super().__init__(canned_text=tag, delay_sec=0.0)
        self.tag = tag
        self.audio_paths: list[str] = []

    async def transcribe(
        self, *, audio_path, language, initial_prompt, cancel_token, options=None
    ):
        self.audio_paths.append(audio_path)
        return await super().transcribe(
            audio_path=audio_path,
            language=language,
            initial_prompt=initial_prompt,
            cancel_token=cancel_token,
            options=options,
        )


def test_live_chunks_use_internal_temp_files_and_are_cleaned(tmp_path):
    """Realtime chunks are implementation details, not recording sidecars.

    They should not appear next to the user-facing WAV, and they should be
    removed once the live chunk has been transcribed.
    """
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)
    backend = _RecordingBackend("partial")
    backend, scheduler, mgr = _build(tmp_path, backend=backend)

    async def go():
        await scheduler.start()
        sid = "tmp-chunks"
        await mgr.start_session(LiveSession(
            sid=sid, mic_path=str(wav), sys_path=None,
            engine="mlx", language="zh", chunk_sec=1.0,
        ))
        t = mgr._tail_tasks.pop(sid, None)
        if t is not None:
            t.cancel()
            try:
                await t
            except asyncio.CancelledError:
                pass
        _append_pcm(wav, seconds=2.0)
        await mgr.poll_once(sid)
        await mgr.stop_session(sid, reason="cancelled")
        await scheduler.stop()

    asyncio.run(go())
    assert backend.audio_paths, "expected a live chunk to be transcribed"
    chunk_path = Path(backend.audio_paths[0])
    assert chunk_path.parent == wav.with_suffix(".realtime")
    assert not list(wav.parent.glob("rec.chunk-*.wav"))
    assert not chunk_path.exists()


def _build_app(tmp_path, backends) -> STTDaemonApp:
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        vocab_db_path=tmp_path / "vocab.sqlite",
        sessions_dir=tmp_path / "sessions",
    )
    return STTDaemonApp(cfg, backends=backends)


class _StubWriter:
    def is_closing(self) -> bool:
        return True


def test_subscribe_uses_realtime_engine_for_live_chunks(tmp_path):
    """A live session must dispatch live chunks on the fast `mlx-realtime`
    backend when one is registered."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.0)

    final_backend = _RecordingBackend("FINAL")
    realtime_backend = _RecordingBackend("REALTIME")
    app = _build_app(tmp_path, {"mlx": final_backend, "mlx-realtime": realtime_backend})

    async def go():
        await app.scheduler.start()
        try:
            await app._on_subscribe_session(
                SubscribeSessionRequest(
                    sid="r1", mic_path=str(wav), sys_path=None,
                    engine="mlx", language="zh", chunk_sec=0.05,
                ),
                writer=_StubWriter(),
            )
            spec = app.live_sessions._active["r1"].spec
            assert spec.engine == "mlx", "final engine must remain mlx"
            assert spec.realtime_engine == "mlx-realtime", "live tail must use realtime engine"
            t = app.live_sessions._tail_tasks.pop("r1", None)
            if t is not None:
                t.cancel()
                try:
                    await t
                except asyncio.CancelledError:
                    pass
            _append_pcm(wav, seconds=0.2)
            await app.live_sessions.poll_once("r1")
        finally:
            # reason="none" so we don't kick off a FINAL_TRANSCRIBE here.
            await app.live_sessions.stop_session("r1", reason="none")
            await app.scheduler.stop()

    asyncio.run(go())
    assert realtime_backend.calls >= 1, "live chunk did not use the realtime backend"
    assert final_backend.calls == 0, "live chunk wrongly used the final backend"


def test_final_transcribe_uses_final_engine_not_realtime(tmp_path):
    """stop_session(reason='stopped') submits the FINAL_TRANSCRIBE on the
    requested engine (mlx), NOT the realtime engine."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.5)

    final_backend = _RecordingBackend("FINAL")
    realtime_backend = _RecordingBackend("REALTIME")
    app = _build_app(tmp_path, {"mlx": final_backend, "mlx-realtime": realtime_backend})

    async def go():
        await app.scheduler.start()
        await app._on_subscribe_session(
            SubscribeSessionRequest(
                sid="f1", mic_path=str(wav), sys_path=None,
                engine="mlx", language="zh", chunk_sec=10.0,
            ),
            writer=_StubWriter(),
        )
        # Stop with reason='stopped' → triggers a final transcribe job.
        fut = await app.live_sessions.stop_session("f1", reason="stopped")
        if fut is not None:
            await fut
        await app.scheduler.stop()

    asyncio.run(go())
    # The final pass ran on the FINAL backend over the whole mic file.
    assert final_backend.calls == 1, "final pass must run exactly once on mlx"
    assert str(wav) in final_backend.audio_paths


def test_resolve_realtime_engine_falls_back_when_absent(tmp_path):
    """When no `<engine>-realtime` backend exists (e.g. whisper-cli or a
    single-backend test daemon), the live tail falls back to `engine`."""
    wav = tmp_path / "rec.wav"
    _write_wav(wav, seconds=0.3)
    only = _RecordingBackend("ONLY")
    app = _build_app(tmp_path, {"mlx": only})  # no mlx-realtime

    assert app._resolve_realtime_engine("mlx") == "mlx"
    assert app._resolve_realtime_engine("whisper") == "whisper"


# ─── Daemon config + backend registration ─────────────────────────────────


def test_config_defaults_realtime_to_turbo_when_unset(tmp_path):
    """A config with no realtime.mlx_model must default the realtime model to
    turbo (NOT to the large-v3 final model)."""
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "transcription": {"mlx": {"model": "mlx-community/whisper-large-v3-mlx"}},
    }), encoding="utf-8")
    cfg = DaemonConfig.from_user_config(cfg_path)
    assert cfg.mlx_model == "mlx-community/whisper-large-v3-mlx"
    assert "turbo" in cfg.realtime_mlx_model
    assert cfg.realtime_mlx_model != cfg.mlx_model


def test_config_reads_realtime_model_and_chunk_cap(tmp_path):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "transcription": {
            "mlx": {"model": "mlx-community/whisper-large-v3-mlx"},
            "realtime": {"mlx_model": "mlx-community/whisper-small-mlx", "chunk_max_sec": 12},
        },
    }), encoding="utf-8")
    cfg = DaemonConfig.from_user_config(cfg_path)
    assert cfg.realtime_mlx_model == "mlx-community/whisper-small-mlx"
    assert cfg.live_chunk_max_sec == 12.0


def test_build_real_backends_registers_distinct_realtime_backend(tmp_path):
    """When realtime model != final model, a SEPARATE mlx-realtime backend is
    registered; when they match, it aliases the same instance."""
    from stt_daemon.__main__ import _build_real_backends

    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "transcription": {
            "mlx": {"model": "mlx-community/whisper-large-v3-mlx"},
            "realtime": {"mlx_model": "mlx-community/whisper-large-v3-turbo"},
        },
    }), encoding="utf-8")
    cfg = DaemonConfig.from_user_config(cfg_path)
    backends = _build_real_backends(cfg)
    assert "mlx" in backends and "mlx-realtime" in backends
    assert backends["mlx"] is not backends["mlx-realtime"], "distinct models → distinct backends"
    assert backends["mlx-realtime"].model == "mlx-community/whisper-large-v3-turbo"

    # Matching models → alias the same backend (don't load two big models).
    cfg.realtime_mlx_model = cfg.mlx_model
    backends2 = _build_real_backends(cfg)
    assert backends2["mlx"] is backends2["mlx-realtime"]
