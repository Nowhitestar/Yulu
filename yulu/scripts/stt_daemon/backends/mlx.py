"""mlx-whisper backend — in-process, lazy-loaded, single resident model."""

from __future__ import annotations

import asyncio
import importlib
from typing import Optional

from ..runtime import CancelToken, STTResult


class MlxWhisperBackend:
    """Wraps mlx_whisper.transcribe(). Model stays loaded after first call."""

    def __init__(
        self,
        *,
        model: str,
        language: str = "zh",
        condition_on_previous_text: bool = True,
        word_timestamps: bool = False,
        hallucination_silence_threshold: float = 2.0,
    ):
        self.model = model
        self.language = language
        self.condition_on_previous_text = condition_on_previous_text
        self.word_timestamps = word_timestamps
        self.hallucination_silence_threshold = hallucination_silence_threshold
        self._module = None
        self._ready = False
        self._lock: Optional[asyncio.Lock] = None
        self._lock_loop: Optional[asyncio.AbstractEventLoop] = None

    def is_ready(self) -> bool:
        return self._ready

    def _warm_up_lock(self) -> asyncio.Lock:
        loop = asyncio.get_running_loop()
        if self._lock is None or self._lock_loop is not loop:
            self._lock = asyncio.Lock()
            self._lock_loop = loop
        return self._lock

    async def warm_up(self) -> None:
        async with self._warm_up_lock():
            if self._ready:
                return
            module = await asyncio.to_thread(importlib.import_module, "mlx_whisper")
            if module is None:
                raise RuntimeError("mlx_whisper module is unavailable")
            self._module = module
            self._ready = True

    def release(self) -> None:
        self._module = None
        self._ready = False

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
        options: Optional[dict] = None,
    ) -> STTResult:
        cancel_token.check()
        if not self._ready:
            await self.warm_up()
        if self._module is None:
            raise RuntimeError("mlx_whisper module not loaded")

        opts = options or {}
        condition_on_previous_text = bool(
            opts.get("condition_on_previous", self.condition_on_previous_text)
        )
        word_timestamps = bool(opts.get("word_timestamps", self.word_timestamps))
        hallucination_silence_threshold = float(
            opts.get(
                "hallucination_silence_threshold",
                self.hallucination_silence_threshold,
            )
        )

        def _run() -> dict:
            return self._module.transcribe(
                audio_path,
                path_or_hf_repo=self.model,
                language=language,
                task="transcribe",
                verbose=False,
                initial_prompt=initial_prompt or None,
                condition_on_previous_text=condition_on_previous_text,
                word_timestamps=word_timestamps,
                hallucination_silence_threshold=hallucination_silence_threshold,
            )

        result = await asyncio.to_thread(_run)
        cancel_token.check()

        text = (result.get("text") or "").strip()
        segments_raw = result.get("segments") or []
        segments = [
            {
                "start_ms": int(float(s.get("start", 0)) * 1000),
                "end_ms": int(float(s.get("end", s.get("start", 0))) * 1000),
                "text": (s.get("text") or "").strip(),
            }
            for s in segments_raw
        ]
        duration_ms = segments[-1]["end_ms"] if segments else 0
        return STTResult(
            text=text,
            raw_text=text,
            segments=segments,
            language=result.get("language") or language,
            duration_ms=duration_ms,
        )
