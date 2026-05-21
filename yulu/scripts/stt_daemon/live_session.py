"""Live session ingestion: tail audio files and dispatch live_chunk jobs."""

from __future__ import annotations

import asyncio
import json
import os
import uuid
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
            mic_size = self._size_or_header(Path(spec.mic_path))
            sys_size = self._size_or_header(Path(spec.sys_path)) if spec.sys_path else 0
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
                await self._tail_iteration(sid)
                active = self._active.get(sid)
                if active is None:
                    return
                await asyncio.sleep(active.spec.chunk_sec)
        except asyncio.CancelledError:
            raise

    async def _tail_iteration(self, sid: str) -> None:
        active = self._active.get(sid)
        if active is None:
            return
        mic_chunk = self._read_pending(
            Path(active.spec.mic_path),
            active.state.mic_offset_bytes,
            min_seconds=active.spec.chunk_sec,
        )
        if mic_chunk is not None:
            chunk_path, new_offset, duration_ms = mic_chunk
            await self._dispatch_chunk(active, source="mic", chunk_path=chunk_path, duration_ms=duration_ms)
            active.state.mic_offset_bytes = new_offset
        if active.spec.sys_path:
            sys_chunk = self._read_pending(
                Path(active.spec.sys_path),
                active.state.sys_offset_bytes,
                min_seconds=active.spec.chunk_sec,
            )
            if sys_chunk is not None:
                chunk_path, new_offset, duration_ms = sys_chunk
                await self._dispatch_chunk(active, source="system", chunk_path=chunk_path, duration_ms=duration_ms)
                active.state.sys_offset_bytes = new_offset
        active.state.last_partial_at = _now_iso()
        await self.flush_state(sid, active=active)

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
        job = Job(
            job_id=str(uuid.uuid4()),
            kind=JobKind.LIVE_CHUNK,
            engine=active.spec.engine,
            language=active.spec.language,
            audio_path=str(chunk_path),
            initial_prompt=self.vocab_cache.inject_prompt(
                meeting_title=active.spec.meeting_title or "",
            ),
            session_id=active.spec.sid,
        )
        fut = await self.scheduler.submit(job)
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

    def _offset_to_ms(self, state: TailState, source: str, *, before_chunk: bool, duration_ms: int) -> int:
        offset = state.mic_offset_bytes if source == "mic" else state.sys_offset_bytes
        offset = max(offset - WAV_HEADER_BYTES, 0)
        ms = int(offset / (SAMPLE_RATE_HZ * SAMPLE_BYTES) * 1000)
        if before_chunk:
            ms = max(ms - duration_ms, 0)
        return ms

    @staticmethod
    def _size_or_header(path: Path) -> int:
        try:
            return max(path.stat().st_size, WAV_HEADER_BYTES)
        except FileNotFoundError:
            return WAV_HEADER_BYTES

    def _read_pending(
        self,
        path: Path,
        offset: int,
        *,
        min_seconds: float,
    ) -> Optional[tuple[Path, int, int]]:
        """Read >= min_seconds of audio after `offset`, write a temp WAV.

        Returns (chunk_wav_path, new_offset, duration_ms) or None if too little.
        """
        try:
            current_size = path.stat().st_size
        except FileNotFoundError:
            return None
        available = current_size - offset
        if available < int(min_seconds * SAMPLE_RATE_HZ * SAMPLE_BYTES):
            return None
        with open(path, "rb") as f:
            f.seek(offset)
            pcm = f.read(available)
        if len(pcm) < SAMPLE_BYTES:
            return None
        chunk_path = path.with_name(
            f"{path.stem}.chunk-{offset}-{offset + len(pcm)}.wav"
        )
        _write_wav_chunk(chunk_path, pcm)
        duration_ms = int(len(pcm) / (SAMPLE_RATE_HZ * SAMPLE_BYTES) * 1000)
        return chunk_path, offset + len(pcm), duration_ms


def _write_wav_chunk(path: Path, pcm_bytes: bytes) -> None:
    import wave
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(SAMPLE_BYTES)
        wf.setframerate(SAMPLE_RATE_HZ)
        wf.writeframes(pcm_bytes)
