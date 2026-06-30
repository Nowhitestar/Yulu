"""Live session ingestion: tail audio files and dispatch live_chunk jobs."""

from __future__ import annotations

import asyncio
import json
import os
import math
import sys
import uuid
from array import array
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Awaitable, Callable, Optional

from .protocol import JobKind, PartialEvent
from .runtime import STTResult
from .scheduler import Job, STTScheduler
from .vocab_cache import VocabCache


WAV_HEADER_BYTES = 44
SAMPLE_RATE_HZ = 16000
SAMPLE_BYTES = 2  # int16 mono
DUAL_TRACK_HEADER_BYTES = 82
DUAL_TRACK_SAMPLE_RATE_HZ = 48000
DUAL_TRACK_FRAME_BYTES = 4  # stereo Int16 → L_lo L_hi R_lo R_hi
LIVE_VOICE_DBFS_THRESHOLD = -42.0
LIVE_VOICE_PEAK_THRESHOLD = 1200
LIVE_VOICE_FRAME_MS = 500

PartialCallback = Callable[[PartialEvent], Optional[Awaitable[None]]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


@dataclass
class LiveSession:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float = 10.0
    meeting_title: Optional[str] = None
    # Engine used for the live chunks ONLY. Defaults to `engine` so existing
    # callers/tests are unchanged; the daemon overrides this with the fast
    # realtime backend (e.g. "mlx-realtime") so the live tail keeps up while
    # the final-transcribe pass still uses the (slower, more accurate)
    # `engine`. Kept distinct so stop_session's FINAL_TRANSCRIBE never picks
    # the realtime model.
    realtime_engine: Optional[str] = None
    # Hard cap (seconds) on how much audio a single live chunk transcribes.
    # When the tail loop falls behind, this stops it from reading the entire
    # accumulated backlog in one giant (and even slower) chunk. None = unbounded
    # (legacy behavior, used by tests that pre-date the cap).
    chunk_max_sec: Optional[float] = None
    # Phase 3 — stride extraction from a single stereo WAV.
    # When stride_step > 1, mic_path == sys_path and we slice every
    # `stride_step` bytes starting at `<channel>_stride_offset`.
    mic_stride_offset: int = 0
    sys_stride_offset: int = 0
    stride_step: int = 1
    # Per-session WAV constants (Phase 3 dual-track recordings have an
    # 82-byte header and a 48 kHz source rate; Phase-1 mono stays at 44 / 16k).
    source_sample_rate_hz: int = SAMPLE_RATE_HZ
    wav_header_bytes: int = WAV_HEADER_BYTES


@dataclass
class TailState:
    sid: str
    mic_path: str
    sys_path: Optional[str]
    engine: str
    language: str
    chunk_sec: float
    mic_offset_bytes: int
    sys_offset_bytes: int
    next_seq: int
    started_at: str
    last_partial_at: str
    # Phase 3
    mic_stride_offset: int = 0
    sys_stride_offset: int = 0
    stride_step: int = 1
    source_sample_rate_hz: int = SAMPLE_RATE_HZ
    wav_header_bytes: int = WAV_HEADER_BYTES
    # Realtime robustness (this fix). Defaulted so older persisted .tail.json
    # files (which lack these keys) still load via TailState(**data).
    realtime_engine: Optional[str] = None
    chunk_max_sec: Optional[float] = None

    def persist(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text(json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, path)

    @classmethod
    def load(cls, path: Path) -> "TailState":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return cls(**data)


@dataclass
class _ActiveSession:
    spec: LiveSession
    state: TailState


class LiveSessionManager:
    def __init__(
        self,
        *,
        scheduler: STTScheduler,
        vocab_cache: VocabCache,
        sessions_dir: Path,
        on_partial: PartialCallback,
    ):
        self.scheduler = scheduler
        self.vocab_cache = vocab_cache
        self.sessions_dir = Path(sessions_dir)
        self.sessions_dir.mkdir(parents=True, exist_ok=True)
        self.on_partial = on_partial
        self._active: dict[str, _ActiveSession] = {}
        self._tail_tasks: dict[str, asyncio.Task] = {}

    def tail_state_path(self, sid: str) -> Path:
        return self.sessions_dir / f"{sid}.tail.json"

    def active_sessions(self) -> list[str]:
        return list(self._active.keys())

    async def start_session(self, spec: LiveSession) -> None:
        if spec.sid in self._active:
            return
        existing_state_path = self.tail_state_path(spec.sid)
        if existing_state_path.exists():
            state = TailState.load(existing_state_path)
        else:
            mic_size = self._size_or_header(Path(spec.mic_path), spec.wav_header_bytes)
            sys_size = (
                self._size_or_header(Path(spec.sys_path), spec.wav_header_bytes)
                if spec.sys_path
                else 0
            )
            state = TailState(
                sid=spec.sid,
                mic_path=spec.mic_path,
                sys_path=spec.sys_path,
                engine=spec.engine,
                language=spec.language,
                chunk_sec=spec.chunk_sec,
                mic_offset_bytes=mic_size,
                sys_offset_bytes=sys_size,
                next_seq=0,
                started_at=_now_iso(),
                last_partial_at=_now_iso(),
                mic_stride_offset=spec.mic_stride_offset,
                sys_stride_offset=spec.sys_stride_offset,
                stride_step=spec.stride_step,
                source_sample_rate_hz=spec.source_sample_rate_hz,
                wav_header_bytes=spec.wav_header_bytes,
                realtime_engine=spec.realtime_engine,
                chunk_max_sec=spec.chunk_max_sec,
            )
            state.persist(existing_state_path)
        self._active[spec.sid] = _ActiveSession(spec=spec, state=state)
        self._tail_tasks[spec.sid] = asyncio.create_task(self._tail_loop(spec.sid))

    async def stop_session(self, sid: str, *, reason: str) -> Optional[asyncio.Future]:
        active = self._active.pop(sid, None)
        task = self._tail_tasks.pop(sid, None)
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        if active is None:
            return None
        await self.flush_state(sid, active=active)
        await self.scheduler.cancel_session(sid)
        if reason in ("stopped", "orphaned", "crashed"):
            job = Job(
                job_id=str(uuid.uuid4()),
                kind=JobKind.FINAL_TRANSCRIBE,
                engine=active.spec.engine,
                language=active.spec.language,
                audio_path=active.spec.mic_path,
                initial_prompt=self.vocab_cache.inject_prompt(
                    meeting_title=active.spec.meeting_title or "",
                ),
                session_id=sid,
                meeting_title=active.spec.meeting_title,
            )
            fut = await self.scheduler.submit(job)
            try:
                self.tail_state_path(sid).unlink()
            except FileNotFoundError:
                pass
            return fut
        try:
            self.tail_state_path(sid).unlink()
        except FileNotFoundError:
            pass
        return None

    def recover_from_disk(self) -> list[str]:
        """Scan sessions_dir for .tail.json files; return sids found."""
        sids = []
        for p in sorted(self.sessions_dir.glob("*.tail.json")):
            try:
                state = TailState.load(p)
            except (OSError, ValueError):
                continue
            if not Path(state.mic_path).exists():
                try:
                    p.unlink()
                except FileNotFoundError:
                    pass
                continue
            sids.append(state.sid)
        return sids

    async def poll_once(self, sid: str) -> None:
        """For tests: run one tail iteration synchronously."""
        await self._tail_iteration(sid)

    async def flush_state(self, sid: str, *, active: Optional[_ActiveSession] = None) -> None:
        active = active or self._active.get(sid)
        if active is None:
            return
        active.state.persist(self.tail_state_path(sid))

    async def _tail_loop(self, sid: str) -> None:
        try:
            while sid in self._active:
                dispatched = await self._tail_iteration(sid)
                active = self._active.get(sid)
                if active is None:
                    return
                # Catch-up: if a chunk was dispatched and there's still a full
                # chunk's worth of audio buffered, we've fallen behind — loop
                # again immediately (no sleep) so we drain the backlog instead
                # of letting it grow unbounded. Only idle-sleep once caught up.
                if dispatched and self._has_pending_chunk(active):
                    continue
                await asyncio.sleep(active.spec.chunk_sec)
        except asyncio.CancelledError:
            raise

    def _has_pending_chunk(self, active: _ActiveSession) -> bool:
        """True when at least ``chunk_sec`` of un-consumed source audio is
        already on disk for either channel — i.e. the tail loop is behind."""
        min_seconds = active.spec.chunk_sec
        if self._channel_has_pending(
            Path(active.spec.mic_path), active.state.mic_offset_bytes,
            min_seconds=min_seconds, stride_step=active.state.stride_step,
            source_sample_rate_hz=active.state.source_sample_rate_hz,
        ):
            return True
        if active.spec.sys_path and self._channel_has_pending(
            Path(active.spec.sys_path), active.state.sys_offset_bytes,
            min_seconds=min_seconds, stride_step=active.state.stride_step,
            source_sample_rate_hz=active.state.source_sample_rate_hz,
        ):
            return True
        return False

    @staticmethod
    def _channel_has_pending(
        path: Path, offset: int, *, min_seconds: float,
        stride_step: int, source_sample_rate_hz: int,
    ) -> bool:
        try:
            current_size = path.stat().st_size
        except FileNotFoundError:
            return False
        frame_bytes = stride_step if stride_step > 1 else SAMPLE_BYTES
        min_source_bytes = int(min_seconds * source_sample_rate_hz * frame_bytes)
        return (current_size - offset) >= min_source_bytes

    async def _tail_iteration(self, sid: str) -> bool:
        """Read + dispatch at most one chunk per channel. Returns True if any
        chunk was dispatched (used by the tail loop to decide catch-up)."""
        active = self._active.get(sid)
        if active is None:
            return False
        max_seconds = active.state.chunk_max_sec
        dispatched = False
        mic_chunk = self._read_pending(
            Path(active.spec.mic_path),
            active.state.mic_offset_bytes,
            min_seconds=active.spec.chunk_sec,
            max_seconds=max_seconds,
            stride_offset=active.state.mic_stride_offset,
            stride_step=active.state.stride_step,
            source_sample_rate_hz=active.state.source_sample_rate_hz,
            chunk_dir=Path(active.spec.mic_path).with_suffix(".realtime"),
            chunk_stem=active.spec.sid,
        )
        if mic_chunk is not None:
            chunk_path, new_offset, duration_ms = mic_chunk
            # Advance the offset BEFORE awaiting the (possibly slow) transcribe
            # so a slow chunk never causes the same bytes to be re-read on the
            # next iteration. The realtime transcript is best-effort; the final
            # pass re-transcribes the whole file for accuracy.
            active.state.mic_offset_bytes = new_offset
            await self._dispatch_chunk(active, source="mic", chunk_path=chunk_path, duration_ms=duration_ms)
            dispatched = True
        if active.spec.sys_path:
            sys_chunk = self._read_pending(
                Path(active.spec.sys_path),
                active.state.sys_offset_bytes,
                min_seconds=active.spec.chunk_sec,
                max_seconds=max_seconds,
                stride_offset=active.state.sys_stride_offset,
                stride_step=active.state.stride_step,
                source_sample_rate_hz=active.state.source_sample_rate_hz,
                chunk_dir=Path(active.spec.mic_path).with_suffix(".realtime"),
                chunk_stem=active.spec.sid,
            )
            if sys_chunk is not None:
                chunk_path, new_offset, duration_ms = sys_chunk
                active.state.sys_offset_bytes = new_offset
                await self._dispatch_chunk(active, source="system", chunk_path=chunk_path, duration_ms=duration_ms)
                dispatched = True
        active.state.last_partial_at = _now_iso()
        await self.flush_state(sid, active=active)
        return dispatched

    async def _dispatch_chunk(
        self,
        active: _ActiveSession,
        *,
        source: str,
        chunk_path: Path,
        duration_ms: int,
    ) -> None:
        seq = active.state.next_seq
        active.state.next_seq += 1
        started_ms = self._offset_to_ms(active.state, source, before_chunk=True, duration_ms=duration_ms)
        if not _chunk_has_voice(chunk_path):
            event = PartialEvent(
                sid=active.spec.sid,
                seq=seq,
                source=source,
                started_ms=started_ms,
                ended_ms=started_ms + duration_ms,
                text="",
            )
            try:
                out = self.on_partial(event)
                if asyncio.iscoroutine(out):
                    await out
            finally:
                try:
                    chunk_path.unlink()
                except FileNotFoundError:
                    pass
            return

        # Live chunks run on the realtime (fast) engine when one is configured;
        # the FINAL_TRANSCRIBE in stop_session deliberately still uses
        # spec.engine so the final note gets the higher-accuracy model.
        live_engine = active.spec.realtime_engine or active.spec.engine
        job = Job(
            job_id=str(uuid.uuid4()),
            kind=JobKind.LIVE_CHUNK,
            engine=live_engine,
            language=active.spec.language,
            audio_path=str(chunk_path),
            initial_prompt=self.vocab_cache.inject_prompt(
                meeting_title=active.spec.meeting_title or "",
            ),
            session_id=active.spec.sid,
            options={
                "job_kind": JobKind.LIVE_CHUNK.value,
                "condition_on_previous": False,
                "hallucination_silence_threshold": 1.5,
            },
        )
        fut = await self.scheduler.submit(job)
        try:
            try:
                result: STTResult = await fut
            except asyncio.CancelledError:
                # Re-raise if the enclosing task itself was cancelled; otherwise the
                # future was just dropped (e.g. scheduler stopped) — swallow it.
                task = asyncio.current_task()
                if task is not None and task.cancelling() > 0:
                    raise
                return
            except Exception:
                return
            text, _ = self.vocab_cache.apply_replacements(result.text)
            event = PartialEvent(
                sid=active.spec.sid,
                seq=seq,
                source=source,
                started_ms=started_ms,
                ended_ms=started_ms + duration_ms,
                text=text,
            )
            out = self.on_partial(event)
            if asyncio.iscoroutine(out):
                await out
        finally:
            try:
                chunk_path.unlink()
            except FileNotFoundError:
                pass

    def _offset_to_ms(self, state: TailState, source: str, *, before_chunk: bool, duration_ms: int) -> int:
        offset = state.mic_offset_bytes if source == "mic" else state.sys_offset_bytes
        offset = max(offset - state.wav_header_bytes, 0)
        # Bytes/sec of the SOURCE file. In stride mode each frame is
        # `stride_step` bytes; in mono mode a frame is one Int16 sample.
        frame_bytes = state.stride_step if state.stride_step > 1 else SAMPLE_BYTES
        divisor = state.source_sample_rate_hz * frame_bytes
        ms = int(offset / divisor * 1000)
        if before_chunk:
            ms = max(ms - duration_ms, 0)
        return ms

    @staticmethod
    def _size_or_header(path: Path, header_bytes: int) -> int:
        try:
            return max(path.stat().st_size, header_bytes)
        except FileNotFoundError:
            return header_bytes

    def _read_pending(
        self,
        path: Path,
        offset: int,
        *,
        min_seconds: float,
        max_seconds: Optional[float] = None,
        stride_offset: int = 0,
        stride_step: int = 1,
        source_sample_rate_hz: int = SAMPLE_RATE_HZ,
        chunk_dir: Optional[Path] = None,
        chunk_stem: Optional[str] = None,
    ) -> Optional[tuple[Path, int, int]]:
        """Read >= min_seconds of audio after `offset`, write a temp WAV.

        Returns (chunk_wav_path, new_offset, duration_ms) or None if too little.

        ``max_seconds`` caps how much audio a single chunk consumes. When the
        tail loop has fallen behind (e.g. a slow model), the backlog can be
        many minutes; without a cap we'd read it ALL into one giant chunk that
        is even slower to transcribe and starves the rest of the recording.
        Capping keeps each chunk bounded so the loop drains the backlog
        incrementally. ``None`` = unbounded (legacy behavior).

        When ``stride_step > 1``, the source file is treated as interleaved
        samples (e.g. a stereo WAV) and only every ``stride_step``-th sample
        starting at ``stride_offset`` is extracted into a mono chunk. This
        requires reading ``stride_step``× more source bytes per second of
        output audio. When ``stride_step == 1`` (default) behavior is
        identical to Phase 1.
        """
        try:
            current_size = path.stat().st_size
        except FileNotFoundError:
            return None
        available = current_size - offset
        if stride_step > 1:
            # Source frame = stride_step bytes (e.g. stereo Int16 = 4 bytes).
            source_bytes_per_second = source_sample_rate_hz * stride_step
            min_source_bytes = int(min_seconds * source_bytes_per_second)
        else:
            source_bytes_per_second = source_sample_rate_hz * SAMPLE_BYTES
            min_source_bytes = int(min_seconds * source_bytes_per_second)
        if available < min_source_bytes:
            return None
        chunk_parent = Path(chunk_dir) if chunk_dir is not None else path.parent
        chunk_parent.mkdir(parents=True, exist_ok=True)
        chunk_name_stem = chunk_stem or path.stem
        # Cap the consumed window so a backlog doesn't become one mega-chunk.
        # Clamp the cap to at least min_source_bytes (one chunk_sec) so a
        # misconfigured chunk_max_sec < chunk_sec can NEVER disable the cap and let
        # the tail read an unbounded backlog — that is what made the live tail fall
        # behind on long recordings and truncate them.
        if max_seconds is not None:
            max_source_bytes = max(
                int(max_seconds * source_bytes_per_second), min_source_bytes
            )
            if available > max_source_bytes:
                available = max_source_bytes
        if stride_step > 1:
            # Align to a whole-frame boundary so each output sample maps to a
            # complete interleaved frame of `stride_step` source bytes.
            consume = (available // stride_step) * stride_step
            if consume < min_source_bytes:
                return None
            new_offset = offset + consume
            chunk_path = chunk_parent / (
                f"{chunk_name_stem}.chunk-{offset}-{new_offset}-s{stride_offset}.wav"
            )
            _read_with_stride(
                path=path,
                out_path=chunk_path,
                start_byte=offset,
                end_byte=new_offset,
                stride_offset=stride_offset,
                stride_step=stride_step,
                sample_width=SAMPLE_BYTES,
                framerate=source_sample_rate_hz,
            )
            duration_ms = int(consume / source_bytes_per_second * 1000)
            return chunk_path, new_offset, duration_ms
        with open(path, "rb") as f:
            f.seek(offset)
            pcm = f.read(available)
        if len(pcm) < SAMPLE_BYTES:
            return None
        chunk_path = chunk_parent / (
            f"{chunk_name_stem}.chunk-{offset}-{offset + len(pcm)}.wav"
        )
        _write_wav_chunk(chunk_path, pcm, framerate=source_sample_rate_hz)
        duration_ms = int(len(pcm) / source_bytes_per_second * 1000)
        return chunk_path, offset + len(pcm), duration_ms


def _write_wav_chunk(path: Path, pcm_bytes: bytes, *, framerate: int = SAMPLE_RATE_HZ) -> None:
    import wave
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_BYTES)
        wf.setframerate(framerate)
        wf.writeframes(pcm_bytes)


def _chunk_has_voice(path: Path) -> bool:
    """Conservative realtime gate: skip chunks that are only silence/room tone."""
    import wave

    try:
        with wave.open(str(path), "rb") as wf:
            if wf.getnchannels() != 1 or wf.getsampwidth() != SAMPLE_BYTES:
                return True
            frame_samples = max(1, int(wf.getframerate() * LIVE_VOICE_FRAME_MS / 1000))
            while True:
                raw = wf.readframes(frame_samples)
                if not raw:
                    return False
                if _pcm_frame_has_voice(raw):
                    return True
    except (EOFError, OSError, wave.Error):
        return True


def _pcm_frame_has_voice(raw: bytes) -> bool:
    if len(raw) < SAMPLE_BYTES:
        return False
    usable = len(raw) - (len(raw) % SAMPLE_BYTES)
    samples = array("h")
    samples.frombytes(raw[:usable])
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return False
    peak = max(abs(v) for v in samples)
    if peak >= LIVE_VOICE_PEAK_THRESHOLD:
        return True
    square_sum = sum(float(v) * float(v) for v in samples)
    rms = math.sqrt(square_sum / len(samples)) / 32767.0
    dbfs = 20.0 * math.log10(rms) if rms > 0 else -math.inf
    return dbfs >= LIVE_VOICE_DBFS_THRESHOLD


def _read_with_stride(
    *, path: Path, out_path: Path,
    start_byte: int, end_byte: int,
    stride_offset: int, stride_step: int,
    sample_width: int, framerate: int,
) -> None:
    """Extract every `stride_step`-th sample of width `sample_width`
    starting at `stride_offset` within each frame, from a slice of `path`
    delimited by `[start_byte, end_byte)`. Write as mono WAV to out_path."""
    import wave as _wave
    with path.open("rb") as src:
        src.seek(start_byte)
        data = src.read(end_byte - start_byte)

    mono = bytearray()
    for i in range(0, len(data) - stride_step + 1, stride_step):
        mono += data[i + stride_offset : i + stride_offset + sample_width]

    with _wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(sample_width)
        dst.setframerate(framerate)
        dst.writeframes(bytes(mono))
