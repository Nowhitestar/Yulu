import asyncio
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import JobKind
from stt_daemon.runtime import MockSTTBackend, STTRuntime, CancelToken
from stt_daemon.scheduler import STTScheduler, Job


def _make_runtime():
    backend = MockSTTBackend(canned_text="x", delay_sec=0.05)
    return STTRuntime(backends={"mlx": backend}), backend


async def _submit(scheduler, kind, sid=None):
    job = Job(
        job_id=str(uuid.uuid4()),
        kind=kind,
        engine="mlx",
        language="zh",
        audio_path="/tmp/x.wav",
        initial_prompt="",
        session_id=sid,
    )
    fut = await scheduler.submit(job)
    return job.job_id, fut


def test_background_priority_final_beats_live(tmp_path):
    async def go():
        runtime, _ = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        order = []

        async def watch(label, fut):
            await fut
            order.append(label)

        # Submit live first, then file, then final
        _, f_live = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="s1")
        _, f_file = await _submit(scheduler, JobKind.FILE_TRANSCRIBE)
        _, f_final = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)

        await asyncio.gather(
            watch("live", f_live),
            watch("file", f_file),
            watch("final", f_final),
        )
        await scheduler.stop()
        return order
    order = asyncio.run(go())
    # Live was already running when final arrived, so live finishes first;
    # but among queued, final > file (file shouldn't run before final).
    assert order.index("final") < order.index("file")


def test_dictation_routed_to_interactive_slot(tmp_path):
    async def go():
        runtime, _ = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        # Submit a long-running final + a dictation; dictation must run
        # concurrently (own slot), not be queued behind final.
        runtime.backends["mlx"].delay_sec = 0.2
        _, f_final = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        _, f_dict = await _submit(scheduler, JobKind.DICTATION)
        # Dictation should complete close to its delay, not after final.
        import time
        t0 = time.monotonic()
        await f_dict
        elapsed = time.monotonic() - t0
        await f_final
        await scheduler.stop()
        return elapsed
    elapsed = asyncio.run(go())
    assert elapsed < 0.35, f"dictation queued behind final (elapsed={elapsed})"


def test_cancel_drops_queued_job(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        # Make backend slow so we can race
        backend.delay_sec = 0.3
        # Block the background slot
        id_block, _ = await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        # Queue another job
        id_q, fut_q = await _submit(scheduler, JobKind.FILE_TRANSCRIBE)
        cancelled = await scheduler.cancel(id_q)
        assert cancelled is True
        try:
            await fut_q
        except asyncio.CancelledError:
            pass
        await scheduler.stop()
    asyncio.run(go())


def test_session_stop_cancels_remaining_live_chunks(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime)
        await scheduler.start()
        backend.delay_sec = 0.5
        # Block scheduler with a long final, queue live_chunks for sid=A
        await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        _, f1 = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="A")
        _, f2 = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="A")
        n_cancelled = await scheduler.cancel_session("A")
        assert n_cancelled == 2
        for f in (f1, f2):
            try:
                await f
            except asyncio.CancelledError:
                pass
        await scheduler.stop()
    asyncio.run(go())


def test_live_chunk_queue_drops_oldest(tmp_path):
    async def go():
        runtime, backend = _make_runtime()
        scheduler = STTScheduler(runtime=runtime, live_chunk_max_per_session=2)
        await scheduler.start()
        backend.delay_sec = 0.3
        # Block scheduler
        await _submit(scheduler, JobKind.FINAL_TRANSCRIBE)
        # 4 live chunks; first two should be dropped to make room
        ids = []
        for _ in range(4):
            jid, _ = await _submit(scheduler, JobKind.LIVE_CHUNK, sid="B")
            ids.append(jid)
        # Two oldest should be cancelled
        cancelled = [i for i in ids if not scheduler.is_pending(i)]
        # Hard guarantee: at least 2 of the 4 are not pending after admission
        await scheduler.stop()
        return len(cancelled)
    n = asyncio.run(go())
    assert n >= 2
