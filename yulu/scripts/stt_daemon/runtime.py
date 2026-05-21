"""STTRuntime — model lifecycle + engine dispatch.

This module ships the STTBackend Protocol and the MockSTTBackend used
by tests. Real mlx-whisper and whisper-cli backends are added in Phase 3
of the implementation plan.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Protocol, Optional


@dataclass
class STTResult:
    text: str
    raw_text: str
    segments: list[dict] = field(default_factory=list)
    language: Optional[str] = None
    duration_ms: int = 0


class CancelToken:
    def __init__(self) -> None:
        self._cancelled = False

    @property
    def cancelled(self) -> bool:
        return self._cancelled

    def cancel(self) -> None:
        self._cancelled = True

    def check(self) -> None:
        if self._cancelled:
            raise asyncio.CancelledError("job cancelled")


class STTBackend(Protocol):
    async def warm_up(self) -> None: ...
    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult: ...
    def is_ready(self) -> bool: ...
    def release(self) -> None: ...


class MockSTTBackend:
    """Deterministic backend used in unit + integration tests."""

    def __init__(
        self,
        canned_text: str = "mock transcript",
        delay_sec: float = 0.0,
        raise_first_n: int = 0,
    ):
        self.canned_text = canned_text
        self.delay_sec = delay_sec
        self.raise_first_n = raise_first_n
        self.calls = 0
        self.reset_count = 0
        self.last_initial_prompt: Optional[str] = None
        self._ready = False

    async def warm_up(self) -> None:
        self._ready = True

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        self.calls += 1
        self.last_initial_prompt = initial_prompt
        cancel_token.check()
        if self.calls <= self.raise_first_n:
            raise RuntimeError(f"mock failure {self.calls}")
        if self.delay_sec:
            await asyncio.sleep(self.delay_sec)
        cancel_token.check()
        return STTResult(
            text=self.canned_text,
            raw_text=self.canned_text,
            segments=[{"start_ms": 0, "end_ms": 1000, "text": self.canned_text}],
            language=language,
            duration_ms=int(self.delay_sec * 1000),
        )

    def is_ready(self) -> bool:
        return self._ready

    def release(self) -> None:
        self._ready = False
        self.reset_count += 1


class STTRuntime:
    """Owns one or more STTBackend instances; tracks readiness + failure counts."""

    def __init__(self, backends: dict[str, STTBackend], reset_threshold: int = 3):
        if not backends:
            raise ValueError("at least one backend required")
        self.backends = backends
        self.reset_threshold = reset_threshold
        self._failure_counts: dict[str, int] = {k: 0 for k in backends}

    def is_ready(self, engine: str) -> bool:
        return engine in self.backends and self.backends[engine].is_ready()

    def failure_count(self, engine: str) -> int:
        return self._failure_counts.get(engine, 0)

    async def warm_up(self, engine: str) -> None:
        if engine not in self.backends:
            raise ValueError(f"unknown engine: {engine}")
        await self.backends[engine].warm_up()

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
        engine: str,
    ) -> STTResult:
        if engine not in self.backends:
            raise ValueError(f"unknown engine: {engine}")
        backend = self.backends[engine]
        try:
            result = await backend.transcribe(
                audio_path=audio_path,
                language=language,
                initial_prompt=initial_prompt,
                cancel_token=cancel_token,
            )
            self._failure_counts[engine] = 0
            return result
        except (asyncio.CancelledError, ValueError):
            raise
        except Exception:
            self._failure_counts[engine] += 1
            if self._failure_counts[engine] >= self.reset_threshold:
                backend.release()
                self._failure_counts[engine] = 0
            raise

    async def shutdown(self) -> None:
        for backend in self.backends.values():
            backend.release()
