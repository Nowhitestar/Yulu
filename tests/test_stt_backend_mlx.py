import asyncio
import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.mlx import MlxWhisperBackend
from stt_daemon.runtime import CancelToken


def _stub_module(text="hello", segments=None):
    """Return a fake mlx_whisper module with controlled transcribe()."""
    fake = MagicMock()
    fake.transcribe.return_value = {
        "text": text,
        "segments": segments or [],
        "language": "zh",
    }
    return fake


def test_mlx_backend_lazy_loads_module(monkeypatch):
    """Backend must NOT import mlx_whisper at construction time."""
    monkeypatch.setitem(sys.modules, "mlx_whisper", None)  # importing should fail
    backend = MlxWhisperBackend(model="dummy-model", language="zh")
    assert backend.is_ready() is False  # not loaded yet


def test_mlx_backend_uses_initial_prompt(monkeypatch):
    fake = _stub_module(text="GitHub rules")
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        result = await backend.transcribe(
            audio_path="/tmp/x.wav",
            language="zh",
            initial_prompt="ctx: ABC",
            cancel_token=CancelToken(),
        )
        return result
    result = asyncio.run(go())
    assert result.text == "GitHub rules"
    call_kwargs = fake.transcribe.call_args.kwargs
    assert call_kwargs.get("initial_prompt") == "ctx: ABC"
    assert call_kwargs.get("path_or_hf_repo") == "dummy"


def test_mlx_backend_segment_format(monkeypatch):
    fake = _stub_module(
        text="raw text",
        segments=[
            {"start": 0.0, "end": 2.5, "text": "hello"},
            {"start": 2.5, "end": 5.0, "text": "world"},
        ],
    )
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        return await backend.transcribe(
            audio_path="/tmp/x.wav",
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
        )
    result = asyncio.run(go())
    assert len(result.segments) == 2
    assert result.segments[0]["start_ms"] == 0
    assert result.segments[1]["end_ms"] == 5000


def test_mlx_backend_propagates_cancel_pre_call(monkeypatch):
    fake = _stub_module()
    monkeypatch.setitem(sys.modules, "mlx_whisper", fake)
    backend = MlxWhisperBackend(model="dummy", language="zh")

    async def go():
        await backend.warm_up()
        tok = CancelToken()
        tok.cancel()
        with pytest.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path="/tmp/x.wav",
                language="zh",
                initial_prompt="",
                cancel_token=tok,
            )
    asyncio.run(go())
