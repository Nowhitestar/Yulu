"""Phase 3 regression: subscribe_session must auto-detect dual-track WAVs
and configure stride extraction, so the live tail emits pure per-channel
mono PCM at the source rate (48 kHz) instead of feeding whisper raw
interleaved bytes — which previously hallucinated boilerplate captions.
"""

from __future__ import annotations

import asyncio
import struct
import sys
import wave
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.app import STTDaemonApp
from stt_daemon.config import DaemonConfig
from stt_daemon.live_session import LiveSession, LiveSessionManager
from stt_daemon.protocol import SubscribeSessionRequest
from stt_daemon.runtime import MockSTTBackend, STTRuntime
from stt_daemon.scheduler import STTScheduler
from stt_daemon.vocab_cache import VocabCache


DUAL_TRACK_HEADER_BYTES = 82
DUAL_TRACK_SAMPLE_RATE_HZ = 48000
FRAME_BYTES = 4  # stereo Int16 → L_lo L_hi R_lo R_hi


def _dual_track_header(audio_size: int) -> bytes:
    """Byte-equivalent of audio_daemon.swift::patchHeaderLocked."""
    file_size = audio_size + DUAL_TRACK_HEADER_BYTES - 8
    out = bytearray()
    out += b"RIFF" + struct.pack("<I", file_size) + b"WAVE"
    out += b"fmt " + struct.pack("<I", 16)
    out += struct.pack(
        "<HHIIHH",
        1, 2, DUAL_TRACK_SAMPLE_RATE_HZ, DUAL_TRACK_SAMPLE_RATE_HZ * 2 * 2, 4, 16,
    )
    out += b"LIST" + struct.pack("<I", 30) + b"INFO"
    out += b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    out += b"data" + struct.pack("<I", audio_size)
    assert len(out) == DUAL_TRACK_HEADER_BYTES
    return bytes(out)


def _make_dual_track_pcm(seconds: float, *, mic_value: int, sys_value: int) -> bytes:
    """Constant Int16 per channel — easiest byte-exact stride check."""
    n_frames = int(DUAL_TRACK_SAMPLE_RATE_HZ * seconds)
    frame = struct.pack("<hh", mic_value, sys_value)
    return frame * n_frames


def _read_chunk_wav(path: Path) -> tuple[int, int, int, bytes]:
    with wave.open(str(path), "rb") as wf:
        return (
            wf.getnchannels(),
            wf.getframerate(),
            wf.getsampwidth(),
            wf.readframes(wf.getnframes()),
        )


class _CapturingBackend(MockSTTBackend):
    """Records the audio_path of each transcribe call for inspection."""

    def __init__(self):
        super().__init__(canned_text="ok", delay_sec=0.0)
        self.captured: list[str] = []
        self.captured_chunks: list[tuple[str, tuple[int, int, int, bytes]]] = []

    async def transcribe(
        self, *, audio_path, language, initial_prompt, cancel_token, options=None
    ):
        self.captured.append(audio_path)
        self.captured_chunks.append((audio_path, _read_chunk_wav(Path(audio_path))))
        return await super().transcribe(
            audio_path=audio_path,
            language=language,
            initial_prompt=initial_prompt,
            cancel_token=cancel_token,
            options=options,
        )


class _StubWriter:
    """Just enough of asyncio.StreamWriter to survive _broadcast_partial."""

    def is_closing(self) -> bool:
        return True


def _build_app(tmp_path, backend) -> STTDaemonApp:
    cfg = DaemonConfig(
        socket_path=tmp_path / "stt.sock",
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        vocab_db_path=tmp_path / "vocab.sqlite",
        sessions_dir=tmp_path / "sessions",
    )
    return STTDaemonApp(cfg, backends={"mlx": backend})


def test_subscribe_dual_track_dispatches_per_channel_mono_chunks_at_source_rate(tmp_path):
    """The end-to-end fix: dual-track WAV in → mono 48 kHz chunks with
    byte-exact per-channel PCM out."""
    wav_path = tmp_path / "rec.wav"

    initial_pcm = _make_dual_track_pcm(seconds=0.2, mic_value=8000, sys_value=4000)
    wav_path.write_bytes(_dual_track_header(len(initial_pcm)) + initial_pcm)
    initial_size = wav_path.stat().st_size

    backend = _CapturingBackend()
    app = _build_app(tmp_path, backend)

    async def go():
        await app.scheduler.start()
        try:
            await app._on_subscribe_session(
                SubscribeSessionRequest(
                    sid="t1",
                    mic_path=str(wav_path),
                    sys_path=None,
                    engine="mlx",
                    language="zh",
                    chunk_sec=0.05,
                ),
                writer=_StubWriter(),
            )

            # The auto-tail loop and poll_once race when triggered together;
            # the test only needs deterministic poll_once dispatches, so kill
            # the background task immediately after subscribe.
            tail_task = app.live_sessions._tail_tasks.pop("t1", None)
            if tail_task is not None:
                tail_task.cancel()
                try:
                    await tail_task
                except asyncio.CancelledError:
                    pass

            extra_pcm = _make_dual_track_pcm(seconds=0.3, mic_value=12000, sys_value=-6000)
            with open(wav_path, "ab") as f:
                f.write(extra_pcm)

            await app.live_sessions.poll_once("t1")
        finally:
            await app.live_sessions.stop_session("t1", reason="stopped")
            await app.scheduler.stop()

    asyncio.run(go())

    assert len(backend.captured) == 2, (
        f"expected 1 mic + 1 sys chunk dispatched, got {backend.captured!r}"
    )

    # Re-derive the source bytes the tail loop would have consumed: it starts
    # at the file size at subscribe time and reads to the new size, frame-aligned.
    src_bytes = wav_path.read_bytes()
    start = initial_size
    end = ((len(src_bytes) - start) // FRAME_BYTES) * FRAME_BYTES + start
    raw = src_bytes[start:end]
    expected_mic = b"".join(raw[i : i + 2] for i in range(0, len(raw), FRAME_BYTES))
    expected_sys = b"".join(raw[i + 2 : i + 4] for i in range(0, len(raw), FRAME_BYTES))

    chunks = backend.captured_chunks
    by_source: dict[str, tuple[int, int, int, bytes]] = {}
    for path, info in chunks:
        assert Path(path).parent == wav_path.with_suffix(".realtime")
        # Chunk filenames embed the stride_offset (s0 = mic, s2 = sys).
        if ".chunk-" in path and "-s0.wav" in path:
            by_source["mic"] = info
        elif ".chunk-" in path and "-s2.wav" in path:
            by_source["sys"] = info

    assert "mic" in by_source and "sys" in by_source, (
        f"could not classify chunks by stride offset: {backend.captured!r}"
    )

    for label, expected in (("mic", expected_mic), ("sys", expected_sys)):
        nchan, fr, sw, pcm = by_source[label]
        assert nchan == 1, f"{label}: chunk should be mono, got {nchan} channels"
        assert fr == DUAL_TRACK_SAMPLE_RATE_HZ, (
            f"{label}: chunk framerate should be {DUAL_TRACK_SAMPLE_RATE_HZ}, got {fr}"
        )
        assert sw == 2, f"{label}: chunk sample width should be 2 bytes, got {sw}"
        assert pcm == expected, (
            f"{label}: stride-extracted PCM mismatch — len(got)={len(pcm)}, "
            f"len(expected)={len(expected)}"
        )
    assert not list(wav_path.parent.glob("rec.chunk-*.wav"))
    assert not list(wav_path.with_suffix(".realtime").glob("*.chunk-*.wav"))


def test_subscribe_mono_wav_keeps_phase1_defaults(tmp_path):
    """Negative control: a plain 16 kHz mono WAV must NOT trigger stride mode."""
    wav_path = tmp_path / "mono.wav"
    with wave.open(str(wav_path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x00\x10" * 8000)

    backend = _CapturingBackend()
    app = _build_app(tmp_path, backend)

    async def go():
        await app.scheduler.start()
        try:
            await app._on_subscribe_session(
                SubscribeSessionRequest(
                    sid="m1",
                    mic_path=str(wav_path),
                    sys_path=None,
                    engine="mlx",
                    language="zh",
                    chunk_sec=10,
                ),
                writer=_StubWriter(),
            )
            spec = app.live_sessions._active["m1"].spec
            assert spec.stride_step == 1
            assert spec.mic_stride_offset == 0
            assert spec.sys_stride_offset == 0
            assert spec.sys_path is None
            assert spec.wav_header_bytes == 44
            assert spec.source_sample_rate_hz == 16000
        finally:
            await app.live_sessions.stop_session("m1", reason="stopped")
            await app.scheduler.stop()

    asyncio.run(go())


def test_subscribe_dual_track_registers_stride_config(tmp_path):
    """The LiveSession registered on a dual-track WAV must have the stride
    config a downstream tail loop needs."""
    wav_path = tmp_path / "dt.wav"
    pcm = _make_dual_track_pcm(seconds=0.05, mic_value=100, sys_value=200)
    wav_path.write_bytes(_dual_track_header(len(pcm)) + pcm)

    backend = _CapturingBackend()
    app = _build_app(tmp_path, backend)

    async def go():
        await app.scheduler.start()
        try:
            await app._on_subscribe_session(
                SubscribeSessionRequest(
                    sid="d1",
                    mic_path=str(wav_path),
                    sys_path=None,
                    engine="mlx",
                    language="zh",
                    chunk_sec=10,
                ),
                writer=_StubWriter(),
            )
            spec = app.live_sessions._active["d1"].spec
            assert spec.stride_step == 4, "dual-track frame is 4 bytes"
            assert spec.mic_stride_offset == 0
            assert spec.sys_stride_offset == 2
            assert spec.sys_path == spec.mic_path
            assert spec.source_sample_rate_hz == DUAL_TRACK_SAMPLE_RATE_HZ
            assert spec.wav_header_bytes == DUAL_TRACK_HEADER_BYTES
        finally:
            await app.live_sessions.stop_session("d1", reason="stopped")
            await app.scheduler.stop()

    asyncio.run(go())
