"""STTRuntime — model lifecycle + engine dispatch.

This module ships the STTBackend Protocol and the MockSTTBackend used
by tests. Real mlx-whisper and whisper-cli backends are added in Phase 3
of the implementation plan.
"""

from __future__ import annotations

import asyncio
import logging
import math
import tempfile
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Protocol, Optional

from .wav_inspect import WavLayout, classify

_log = logging.getLogger(__name__)


@dataclass
class STTResult:
    text: str
    raw_text: str = ""
    segments: list[dict] = field(default_factory=list)
    language: Optional[str] = None
    duration_ms: int = 0


@dataclass
class TranscribeDispatchResult:
    """Channel-aware dispatch result returned by `dispatch_transcribe`.

    - For MONO / LEGACY_STEREO / channel_split=False: `text` + `segments` set,
      `channels` is None.
    - For DUAL_TRACK: `channels` is a dict with keys 'mic' and 'sys', each
      mapping to {'text': str, 'segments': list[dict]}; `text` is empty.
    """
    layout: WavLayout
    text: str = ""
    segments: Optional[list[dict]] = None
    channels: Optional[dict[str, dict]] = None


def _extract_channel(stereo_path: Path, channel: int, out_path: Path) -> None:
    """Write a mono WAV containing only the L (channel=0) or R (channel=1)
    samples of `stereo_path`. Uses the `wave` module; preserves sample rate."""
    with wave.open(str(stereo_path), "rb") as src:
        assert src.getnchannels() == 2, "extract_channel requires stereo input"
        params = src.getparams()
        sample_width = src.getsampwidth()
        n_frames = src.getnframes()
        raw = src.readframes(n_frames)

    # interleaved: [L0_lo L0_hi R0_lo R0_hi L1_lo L1_hi R1_lo R1_hi ...]
    frame_bytes = sample_width * 2
    stride_start = channel * sample_width
    mono = bytearray()
    for i in range(n_frames):
        base = i * frame_bytes + stride_start
        mono += raw[base : base + sample_width]

    with wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1)
        dst.setsampwidth(sample_width)
        dst.setframerate(params.framerate)
        dst.writeframes(bytes(mono))


EMPTY_CHANNEL_DBFS_THRESHOLD = -50.0  # below this → treat as silent


def _channel_rms_dbfs(mono_wav: Path) -> float:
    """Whole-file RMS of a mono Int16 WAV expressed in dBFS.
    Returns -inf for empty or unsupported files."""
    with wave.open(str(mono_wav), "rb") as f:
        sw = f.getsampwidth()
        n = f.getnframes()
        raw = f.readframes(n)
    if n == 0 or sw != 2:
        return -math.inf
    max_amp = float((1 << (8 * sw - 1)) - 1)
    total = 0.0
    for i in range(n):
        v = int.from_bytes(raw[i * 2 : i * 2 + 2], "little", signed=True)
        total += (v / max_amp) ** 2
    rms = math.sqrt(total / n)
    return 20.0 * math.log10(rms) if rms > 0 else -math.inf


def _downmix_stereo_to_mono(stereo_path: Path, out_path: Path) -> None:
    """Write `(L + R) / 2` mono WAV."""
    with wave.open(str(stereo_path), "rb") as src:
        assert src.getnchannels() == 2
        params = src.getparams()
        sw = src.getsampwidth()
        n_frames = src.getnframes()
        raw = src.readframes(n_frames)

    out = bytearray()
    for i in range(n_frames):
        base = i * sw * 2
        L = int.from_bytes(raw[base : base + sw], "little", signed=True)
        R = int.from_bytes(raw[base + sw : base + 2 * sw], "little", signed=True)
        mix = (L + R) // 2
        out += mix.to_bytes(sw, "little", signed=True)

    with wave.open(str(out_path), "wb") as dst:
        dst.setnchannels(1); dst.setsampwidth(sw); dst.setframerate(params.framerate)
        dst.writeframes(bytes(out))


def dispatch_transcribe(
    *, wav_path: Path, channel_split: bool, backend,
    language: str, initial_prompt: str,
) -> TranscribeDispatchResult:
    """Channel-aware single-WAV transcribe entry point.

    - channel_split=False -> always single mono pass on the original file.
    - channel_split=True  -> classify via WavLayout:
        MONO          -> single pass on the original file.
        LEGACY_STEREO -> downmix L+R -> mono pass; log WARN.
        DUAL_TRACK    -> extract L+R into two temp mono WAVs; run backend
                        twice (mic then sys); return `channels` dict.

    The `backend` contract is a sync callable:
        backend.transcribe(audio_path=..., language=..., initial_prompt=...) -> STTResult
    Callers that need to bridge an async/scheduler-driven backend should wrap
    it in a small adapter object.
    """
    wav_path = Path(wav_path)
    if not channel_split:
        result = backend.transcribe(audio_path=str(wav_path),
                                    language=language,
                                    initial_prompt=initial_prompt)
        return TranscribeDispatchResult(
            layout=WavLayout.MONO, text=result.text, segments=result.segments
        )

    layout = classify(wav_path)

    if layout is WavLayout.MONO:
        r = backend.transcribe(audio_path=str(wav_path),
                               language=language, initial_prompt=initial_prompt)
        return TranscribeDispatchResult(layout=layout, text=r.text, segments=r.segments)

    if layout is WavLayout.LEGACY_STEREO:
        _log.warning("legacy stereo wav, no source separation: %s", wav_path)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
            tmp = Path(tf.name)
        try:
            _downmix_stereo_to_mono(wav_path, tmp)
            r = backend.transcribe(audio_path=str(tmp),
                                   language=language, initial_prompt=initial_prompt)
            return TranscribeDispatchResult(layout=layout, text=r.text, segments=r.segments)
        finally:
            tmp.unlink(missing_ok=True)

    # DUAL_TRACK — allocate inside try so that a failure between the two
    # NamedTemporaryFile() calls cannot leak the first file.
    tmp_mic: Optional[Path] = None
    tmp_sys: Optional[Path] = None
    try:
        tmp_mic = Path(tempfile.NamedTemporaryFile(suffix=".mic.wav", delete=False).name)
        tmp_sys = Path(tempfile.NamedTemporaryFile(suffix=".sys.wav", delete=False).name)
        _extract_channel(wav_path, channel=0, out_path=tmp_mic)
        _extract_channel(wav_path, channel=1, out_path=tmp_sys)

        mic_dbfs = _channel_rms_dbfs(tmp_mic)
        sys_dbfs = _channel_rms_dbfs(tmp_sys)

        if mic_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
            r = backend.transcribe(audio_path=str(tmp_mic),
                                   language=language, initial_prompt=initial_prompt)
            mic_entry = {"text": r.text, "segments": r.segments}
        else:
            mic_entry = {"skipped_silent": True, "text": "", "segments": []}

        if sys_dbfs > EMPTY_CHANNEL_DBFS_THRESHOLD:
            r = backend.transcribe(audio_path=str(tmp_sys),
                                   language=language, initial_prompt=initial_prompt)
            sys_entry = {"text": r.text, "segments": r.segments}
        else:
            sys_entry = {"skipped_silent": True, "text": "", "segments": []}

        return TranscribeDispatchResult(
            layout=layout,
            channels={"mic": mic_entry, "sys": sys_entry},
        )
    finally:
        if tmp_mic is not None:
            tmp_mic.unlink(missing_ok=True)
        if tmp_sys is not None:
            tmp_sys.unlink(missing_ok=True)


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


# Canonical engine keys the runtime knows how to chain. These match the keys
# _build_real_backends() registers (stt_daemon/__main__.py).
ENGINE_MLX = "mlx"
ENGINE_WHISPER = "whisper"
ENGINE_CLOUD = "cloud"


class STTRuntime:
    """Owns one or more STTBackend instances; tracks readiness + failure counts.

    Beyond plain per-engine dispatch, the runtime applies two fresh-install
    safety policies when transcribing:

      * mlx → whisper fallback (BUG 3): the default engine is mlx but setup only
        *advises* installing mlx_whisper. If the mlx backend fails (e.g.
        ``mlx_whisper module is unavailable``) and a whisper.cpp model is
        present, the request is automatically retried on the ``whisper`` engine.

      * cloud transcription mode (BUG 8): ``transcription.mode`` orders local vs.
        the user's ``cloud_command``. ``local`` (default) = current behavior;
        ``cloud-fallback`` = local then cloud; ``cloud-priority`` = cloud then
        local. Cloud is just another backend (``cloud``) spawning the user's own
        command — Yulu holds no cloud keys.

    All policy is opt-in via constructor kwargs; with the defaults
    (``mode="local"`` and no whisper model / cloud command) behavior is exactly
    the single-engine dispatch it has always been.
    """

    def __init__(
        self,
        backends: dict[str, STTBackend],
        reset_threshold: int = 3,
        *,
        mode: str = "local",
        whisper_model_present: bool = False,
        cloud_command_present: bool = False,
        logger=None,
    ):
        if not backends:
            raise ValueError("at least one backend required")
        self.backends = backends
        self.reset_threshold = reset_threshold
        self.mode = (mode or "local").strip().lower()
        self.whisper_model_present = whisper_model_present
        self.cloud_command_present = cloud_command_present
        self._logger = logger
        self._failure_counts: dict[str, int] = {k: 0 for k in backends}

    def is_ready(self, engine: str) -> bool:
        return engine in self.backends and self.backends[engine].is_ready()

    def failure_count(self, engine: str) -> int:
        return self._failure_counts.get(engine, 0)

    async def warm_up(self, engine: str) -> None:
        if engine not in self.backends:
            raise ValueError(f"unknown engine: {engine}")
        await self.backends[engine].warm_up()

    def _log(self, event: str, **fields) -> None:
        """Emit a structured line if a JsonLogger was provided, else stdlib log."""
        log = self._logger
        if log is not None and hasattr(log, "info"):
            try:
                log.info(event, **fields)
                return
            except TypeError:
                pass
        _log.info("%s %s", event, fields)

    def _engine_chain(self, requested: str) -> list[str]:
        """Build the ordered list of engines to try for one request.

        Local part = the requested engine, with ``whisper`` appended when the
        request is ``mlx`` and a whisper model is present (the mlx→whisper
        fallback). The cloud engine is prepended or appended per ``mode``.
        Unknown / unavailable engine keys are filtered out, but a chain is never
        empty as long as the requested engine exists.
        """
        local: list[str] = [requested]
        if (
            requested == ENGINE_MLX
            and self.whisper_model_present
            and ENGINE_WHISPER in self.backends
        ):
            local.append(ENGINE_WHISPER)

        cloud_usable = self.cloud_command_present and ENGINE_CLOUD in self.backends
        if cloud_usable and self.mode == "cloud-priority":
            chain = [ENGINE_CLOUD, *local]
        elif cloud_usable and self.mode == "cloud-fallback":
            chain = [*local, ENGINE_CLOUD]
        else:
            chain = local

        # De-dup while preserving order; keep only engines we actually have.
        seen: set[str] = set()
        ordered: list[str] = []
        for eng in chain:
            if eng in self.backends and eng not in seen:
                seen.add(eng)
                ordered.append(eng)
        return ordered

    async def _transcribe_one(
        self,
        *,
        engine: str,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        """Dispatch to a single backend with the per-engine self-reset bookkeeping."""
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

        chain = self._engine_chain(engine)
        last_exc: Optional[Exception] = None
        for idx, eng in enumerate(chain):
            try:
                result = await self._transcribe_one(
                    engine=eng,
                    audio_path=audio_path,
                    language=language,
                    initial_prompt=initial_prompt,
                    cancel_token=cancel_token,
                )
                if idx > 0:
                    self._log(
                        "stt_engine_fallback_succeeded",
                        requested=engine,
                        used=eng,
                        tried=chain[:idx],
                    )
                return result
            except (asyncio.CancelledError, ValueError):
                # Cancellation and "unknown engine" are not fallback-worthy.
                raise
            except Exception as exc:  # noqa: BLE001 — any backend failure → try next
                last_exc = exc
                next_eng = chain[idx + 1] if idx + 1 < len(chain) else None
                if next_eng is not None:
                    self._log(
                        "stt_engine_failed_falling_back",
                        failed=eng,
                        error=str(exc),
                        next=next_eng,
                    )
                    continue
                # Exhausted the chain — re-raise the last failure.
                raise
        # Unreachable (chain always has ≥1 entry), but keep the type checker happy.
        if last_exc is not None:
            raise last_exc
        raise RuntimeError("no engine available to transcribe")

    async def shutdown(self) -> None:
        for backend in self.backends.values():
            backend.release()
