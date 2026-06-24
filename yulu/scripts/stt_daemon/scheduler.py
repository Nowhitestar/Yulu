"""STTScheduler — two-slot worker model with priority queue + cancellation."""

from __future__ import annotations

import asyncio
import heapq
import itertools
from dataclasses import dataclass, field
from typing import Optional

from .protocol import JobKind
from .runtime import CancelToken, STTResult, STTRuntime


@dataclass
class Job:
    job_id: str
    kind: JobKind
    engine: str
    language: str
    audio_path: str
    initial_prompt: str = ""
    session_id: Optional[str] = None
    meeting_title: Optional[str] = None
    options: dict = field(default_factory=dict)


@dataclass(order=True)
class _Queued:
    priority: int
    seq: int
    job: Job = field(compare=False)
    future: asyncio.Future = field(compare=False)
    cancel_token: CancelToken = field(compare=False)
    cancelled: bool = field(default=False, compare=False)


class STTScheduler:
    def __init__(
        self,
        *,
        runtime: STTRuntime,
        live_chunk_max_per_session: int = 4,
    ):
        self.runtime = runtime
        self.live_chunk_max_per_session = live_chunk_max_per_session
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._counter = itertools.count()
        self._interactive_queue: list[_Queued] = []
        self._background_queue: list[_Queued] = []
        self._interactive_event: Optional[asyncio.Event] = None
        self._background_event: Optional[asyncio.Event] = None
        self._all_jobs: dict[str, _Queued] = {}
        self._workers: list[asyncio.Task] = []
        self._stopped = True

    async def start(self) -> None:
        if self._workers:
            return
        self._loop = asyncio.get_running_loop()
        self._stopped = False
        self._interactive_event = asyncio.Event()
        self._background_event = asyncio.Event()
        self._workers.append(
            asyncio.create_task(self._slot_worker("interactive", self._interactive_queue, self._interactive_event))
        )
        self._workers.append(
            asyncio.create_task(self._slot_worker("background", self._background_queue, self._background_event))
        )

    async def stop(self) -> None:
        self._stopped = True
        if self._interactive_event is not None:
            self._interactive_event.set()
        if self._background_event is not None:
            self._background_event.set()
        for w in self._workers:
            w.cancel()
        await asyncio.gather(*self._workers, return_exceptions=True)
        self._workers.clear()
        self._interactive_event = None
        self._background_event = None
        self._loop = None

    async def submit(self, job: Job) -> asyncio.Future:
        if self._loop is None or self._interactive_event is None or self._background_event is None:
            raise RuntimeError("scheduler not started")
        fut: asyncio.Future = self._loop.create_future()
        tok = CancelToken()
        queued = _Queued(
            priority=job.kind.priority,
            seq=next(self._counter),
            job=job,
            future=fut,
            cancel_token=tok,
        )
        self._all_jobs[job.job_id] = queued

        if job.kind.slot == "interactive":
            heapq.heappush(self._interactive_queue, queued)
            self._interactive_event.set()
        else:
            self._enforce_live_chunk_cap(job)
            heapq.heappush(self._background_queue, queued)
            self._background_event.set()
        return fut

    def _enforce_live_chunk_cap(self, incoming: Job) -> None:
        if incoming.kind is not JobKind.LIVE_CHUNK or incoming.session_id is None:
            return
        same = [
            q for q in self._background_queue
            if q.job.kind is JobKind.LIVE_CHUNK
            and q.job.session_id == incoming.session_id
            and not q.cancelled
        ]
        # +1 to account for the incoming job we're about to push
        over = len(same) + 1 - self.live_chunk_max_per_session
        if over <= 0:
            return
        # Drop oldest (smallest seq) first
        same.sort(key=lambda q: q.seq)
        for q in same[:over]:
            self._cancel_queued(q, reason="queue_full")

    async def cancel(self, job_id: str) -> bool:
        q = self._all_jobs.get(job_id)
        if not q or q.future.done():
            return False
        return self._cancel_queued(q, reason="user_cancel")

    async def cancel_session(self, sid: str) -> int:
        n = 0
        for q in list(self._all_jobs.values()):
            if q.job.session_id == sid and q.job.kind is JobKind.LIVE_CHUNK and not q.future.done():
                if self._cancel_queued(q, reason="session_stop"):
                    n += 1
        return n

    def _cancel_queued(self, queued: _Queued, *, reason: str) -> bool:
        if queued.cancelled or queued.future.done():
            return False
        queued.cancelled = True
        queued.cancel_token.cancel()
        if not queued.future.done():
            queued.future.cancel()
        return True

    def is_pending(self, job_id: str) -> bool:
        q = self._all_jobs.get(job_id)
        if q is None:
            return False
        return not (q.cancelled or q.future.done())

    def in_flight_count(self) -> int:
        return sum(1 for q in self._all_jobs.values() if not q.future.done())

    async def _slot_worker(
        self,
        name: str,
        queue: list[_Queued],
        event: asyncio.Event,
    ) -> None:
        while not self._stopped:
            await event.wait()
            if self._stopped:
                return
            # Pop next non-cancelled job
            queued: Optional[_Queued] = None
            while queue:
                candidate = heapq.heappop(queue)
                if not candidate.cancelled and not candidate.future.done():
                    queued = candidate
                    break
            if queued is None:
                event.clear()
                continue
            try:
                result = await self.runtime.transcribe(
                    audio_path=queued.job.audio_path,
                    language=queued.job.language,
                    initial_prompt=queued.job.initial_prompt,
                    cancel_token=queued.cancel_token,
                    engine=queued.job.engine,
                    options=queued.job.options,
                )
                if not queued.future.done():
                    queued.future.set_result(result)
            except asyncio.CancelledError:
                if not queued.future.done():
                    queued.future.cancel()
            except Exception as exc:
                if not queued.future.done():
                    queued.future.set_exception(exc)
            finally:
                if not queue:
                    event.clear()
