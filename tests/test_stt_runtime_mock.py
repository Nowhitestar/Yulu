import asyncio
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.runtime import (
    STTResult, CancelToken, MockSTTBackend, STTRuntime,
)


def test_cancel_token_is_set_and_check():
    tok = CancelToken()
    assert tok.cancelled is False
    tok.cancel()
    assert tok.cancelled is True


def test_mock_backend_returns_canned_result():
    async def go():
        backend = MockSTTBackend(canned_text="hello world")
        result = await backend.transcribe(
            audio_path="/tmp/x.wav", language="en",
            initial_prompt="ctx", cancel_token=CancelToken(),
        )
        return result, backend.last_initial_prompt
    result, prompt = asyncio.run(go())
    assert isinstance(result, STTResult)
    assert result.text == "hello world"
    assert prompt == "ctx"


def test_mock_backend_respects_cancel():
    async def go():
        backend = MockSTTBackend(canned_text="x", delay_sec=0.5)
        tok = CancelToken()
        tok.cancel()  # pre-cancelled
        import pytest as _p
        with _p.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path="/x", language="en",
                initial_prompt="", cancel_token=tok,
            )
    asyncio.run(go())


def test_runtime_routes_by_engine():
    async def go():
        mlx = MockSTTBackend(canned_text="from-mlx")
        whisper = MockSTTBackend(canned_text="from-whisper")
        runtime = STTRuntime(backends={"mlx": mlx, "whisper": whisper})
        await runtime.warm_up("mlx")
        r1 = await runtime.transcribe(
            audio_path="/x", language="zh", initial_prompt="",
            cancel_token=CancelToken(), engine="mlx",
        )
        r2 = await runtime.transcribe(
            audio_path="/x", language="zh", initial_prompt="",
            cancel_token=CancelToken(), engine="whisper",
        )
        return r1.text, r2.text, runtime.is_ready("mlx"), runtime.is_ready("whisper")
    t1, t2, mlx_ready, whisper_ready = asyncio.run(go())
    assert t1 == "from-mlx"
    assert t2 == "from-whisper"
    assert mlx_ready is True
    assert whisper_ready is False  # only warmed mlx


def test_runtime_self_reset_after_three_failures():
    async def go():
        flaky = MockSTTBackend(canned_text="ok", raise_first_n=3)
        runtime = STTRuntime(backends={"mlx": flaky}, reset_threshold=3)
        # 3 failures in a row should reset
        for _ in range(3):
            try:
                await runtime.transcribe(
                    audio_path="/x", language="zh", initial_prompt="",
                    cancel_token=CancelToken(), engine="mlx",
                )
            except RuntimeError:
                pass
        return runtime.failure_count("mlx"), flaky.reset_count
    failures, resets = asyncio.run(go())
    assert resets >= 1
    assert failures == 0  # reset zeroes the counter
