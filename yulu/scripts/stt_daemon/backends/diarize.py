"""sherpa-onnx speaker-diarization backend — audio → speaker turns (ONNX, no torch).

This is the resident diarization engine for v0.6. It MIRRORS the STT backend lifecycle
(``warm_up`` / ``is_ready`` / ``release``, see ``backends/mlx.py``) but is deliberately a
*sibling stage*, NOT an ASR engine:

  * it is constructed OUTSIDE ``STTRuntime.backends`` (the ASR fallback dict that drives
    ``_engine_chain`` mlx→whisper→cloud), so the ASR fallback logic can never route to it
    (ARCHITECTURE.md Anti-Pattern 1); and
  * its main method returns **speaker turns**, not an ``STTResult`` — forcing diarization
    through the ASR type would be a category error.

It is also NOT a ``CapabilityProvider`` subclass: diarization is Yulu-managed and config-selected,
surfaced as a tri-state ``yulu-managed`` probe entry (``capabilities/probes.probe_diarization``),
with the swappable sherpa-vs-FunASR seam living in the ``DiarizeBackend`` Protocol below
(ARCHITECTURE.md Anti-Pattern 4).

Output contract — feeds Phase-9 ``speaker_merge`` verbatim
---------------------------------------------------------
``diarize()`` returns ``list[SpeakerTurn]`` with ``start``/``end`` in **seconds** and a volatile
cluster index ``speaker_idx``. ``speaker_merge.SpeakerTurn.from_dict`` accepts exactly this shape
(it reads ``speaker_idx`` / ``speaker`` / ``spk``), so backend output drops straight into
``assign_speakers(turns=...)`` with no glue.

sherpa API (lifted from ``.planning/spikes/002-.../sherpa_diar.py``, verified working)
--------------------------------------------------------------------------------------
``OfflineSpeakerDiarizationConfig`` with pyannote-3.0 segmentation + 3D-Speaker cam++ embedding +
``FastClusteringConfig``; ``process(audio).sort_by_start_time()`` → segments carrying
``.start`` / ``.end`` / ``.speaker``. Audio is resampled to ``sd.sample_rate`` (16 kHz) when needed.

torch-free: the only heavy dependency is ``sherpa_onnx`` (ONNX Runtime). Imported lazily so this
module imports on any machine and in CI without sherpa installed — usability is gated by the probe.

Privacy: this backend emits only abstract cluster indices + timings. Speaker embeddings are
biometric voiceprints and are NEVER returned, persisted, or logged here.

Offline-by-default: both models are plain local ``.onnx`` files loaded by absolute path; no network
call is made at warm-up or diarize time (criterion 3 — verified by the forced-offline test).
"""

from __future__ import annotations

import asyncio
import importlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional, Protocol, runtime_checkable

from ..runtime import CancelToken

# ── Model resolution — the single source of truth for the two ONNX files ──────
#
# Cached under the runtime models dir beside the GGML whisper models, in a
# ``diarization/`` subdir so the diarization assets are grouped and the whisper
# model scan (capabilities.scan_models) is unaffected.

#: Default models root: ``~/.config/yulu/models`` (mirrors setup_models.sh MODEL_DIR).
DEFAULT_MODELS_DIR = Path.home() / ".config" / "yulu" / "models"
DIARIZATION_SUBDIR = "diarization"

SEG_MODEL_FILENAME = "segmentation.onnx"   # pyannote-3.0 segmentation (~5.7 MB)
EMB_MODEL_FILENAME = "campplus.onnx"       # 3D-Speaker cam++ embedding (~27 MB)

#: Canonical download URLs (k2-fsa / sherpa-onnx published assets). Kept here as the
#: single source of truth so setup_models.sh, the probe, and docs agree. The seg model
#: ships inside a tar.bz2; setup_models.sh extracts ``model.onnx`` → ``segmentation.onnx``.
SEG_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
)
EMB_MODEL_URL = (
    "https://github.com/k2-fsa/sherpa-onnx/releases/download/"
    "speaker-recongition-models/3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx"
)

PROVIDER_SHERPA = "sherpa-onnx"


def diarization_dir(models_dir: Optional[os.PathLike | str] = None) -> Path:
    """The fixed, well-known diarization-model directory (no traversal outside it)."""
    base = Path(models_dir) if models_dir is not None else DEFAULT_MODELS_DIR
    return base / DIARIZATION_SUBDIR


def resolve_model_paths(
    models_dir: Optional[os.PathLike | str] = None,
    *,
    seg_path: Optional[str] = None,
    emb_path: Optional[str] = None,
) -> tuple[Path, Path]:
    """Resolve (segmentation, embedding) ONNX paths.

    Explicit config overrides (``seg_path`` / ``emb_path``) win; otherwise fall back to the
    canonical filenames under ``diarization_dir(models_dir)``. Pure path math — no I/O.
    """
    d = diarization_dir(models_dir)
    seg = Path(seg_path).expanduser() if seg_path else d / SEG_MODEL_FILENAME
    emb = Path(emb_path).expanduser() if emb_path else d / EMB_MODEL_FILENAME
    return seg, emb


def models_present(
    models_dir: Optional[os.PathLike | str] = None,
    *,
    seg_path: Optional[str] = None,
    emb_path: Optional[str] = None,
) -> bool:
    """True iff both diarization ONNX files exist (read-only; never raises).

    The ONE shared check used by the provision ``models`` step's ``check()`` and by
    ``probe_diarization`` so "are the models there?" has a single definition.
    """
    try:
        seg, emb = resolve_model_paths(models_dir, seg_path=seg_path, emb_path=emb_path)
        return seg.is_file() and emb.is_file()
    except Exception:
        return False


# ── Output data model — feeds Phase-9 speaker_merge ───────────────────────────


@dataclass
class SpeakerTurn:
    """A raw diarization turn: a contiguous span attributed to one cluster index.

    ``start`` / ``end`` are SECONDS. ``speaker_idx`` is the *volatile* cluster index from the
    diarizer (0..N-1) — NOT a user-facing label. The shape matches
    ``stt_daemon.speaker_merge.SpeakerTurn.from_dict`` (which also accepts ``speaker`` / ``spk``),
    so ``to_dict()`` output drops straight into ``assign_speakers(turns=...)``.
    """

    start: float
    end: float
    speaker_idx: int

    def to_dict(self) -> dict:
        # Emit both ``speaker_idx`` and ``speaker`` so any consumer key works.
        return {"start": self.start, "end": self.end,
                "speaker_idx": self.speaker_idx, "speaker": self.speaker_idx}


# ── The Protocol (the swappable provider seam) ────────────────────────────────


@runtime_checkable
class DiarizeBackend(Protocol):
    """Audio → speaker turns. Mirrors the STT lifecycle trio verbatim, but returns turns.

    A future FunASR/MPS implementation can satisfy this same Protocol and be selected by config
    (``transcription.diarization.provider``) with zero changes to callers.
    """

    async def warm_up(self) -> None: ...
    async def diarize(
        self,
        *,
        audio_path: str,
        num_speakers: Optional[int],
        cancel_token: CancelToken,
    ) -> list[SpeakerTurn]: ...
    def is_ready(self) -> bool: ...
    def release(self) -> None: ...


# ── The default implementation ────────────────────────────────────────────────


class SherpaDiarizeBackend:
    """sherpa-onnx offline diarization, resident + warm. Mirrors ``MlxWhisperBackend``.

    The pipeline object (``OfflineSpeakerDiarization``) is built once on first ``warm_up`` and
    stays resident (it holds the seg + cam++ ONNX sessions). ``warm_up`` additionally runs a 1s
    silent dummy pass so the ONNX Runtime graph is initialized before the first real meeting
    (criterion 5 — the first recording is not JIT-penalized).
    """

    #: Default auto-clustering threshold. Higher values merge more aggressively in sherpa auto mode.
    DEFAULT_THRESHOLD = 0.6

    def __init__(
        self,
        *,
        seg_model: str,
        emb_model: str,
        num_speakers: Optional[int] = None,
        threshold: float = DEFAULT_THRESHOLD,
        min_duration_on: float = 0.3,
        min_duration_off: float = 0.5,
    ):
        self.seg_model = str(Path(seg_model).expanduser())
        self.emb_model = str(Path(emb_model).expanduser())
        # ``num_speakers`` None / <=0 → auto (threshold-based clustering).
        self.num_speakers = num_speakers if (num_speakers and num_speakers > 0) else None
        self.threshold = threshold
        self.min_duration_on = min_duration_on
        self.min_duration_off = min_duration_off
        self._sherpa = None        # the sherpa_onnx module (lazy)
        self._sd = None            # the resident DEFAULT OfflineSpeakerDiarization (never mutated)
        # Count-keyed pipeline cache (Phase-12 carry-forward fix): maps a normalized
        # ``(num_clusters, threshold)`` key → its OfflineSpeakerDiarization, so a per-call override
        # is served by its own cached pipeline and can NEVER bleed into the default/auto pipeline.
        self._pipelines: dict[tuple[int, float], object] = {}
        self._default_key: Optional[tuple[int, float]] = None
        self._ready = False
        self._lock = asyncio.Lock()

    def is_ready(self) -> bool:
        return self._ready

    def _build_config(self, sherpa_onnx, num_speakers: Optional[int],
                      threshold: Optional[float] = None):
        """Build an ``OfflineSpeakerDiarizationConfig`` (lifted from the spike, verified).

        ``num_speakers`` None / <=0 ⇒ ``-1`` (auto threshold clustering). ``threshold`` overrides
        the configured default when supplied (the per-call calibrated threshold); sherpa ignores it
        when ``num_clusters > 0``.
        """
        n = num_speakers if (num_speakers and num_speakers > 0) else -1  # -1 = auto
        thr = threshold if (threshold and threshold > 0) else self.threshold
        return sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=self.seg_model
                )
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(model=self.emb_model),
            clustering=sherpa_onnx.FastClusteringConfig(
                num_clusters=n, threshold=thr
            ),
            min_duration_on=self.min_duration_on,
            min_duration_off=self.min_duration_off,
        )

    async def warm_up(self) -> None:
        """Load the module + build the resident DEFAULT pipeline + pay the cold-start (criterion 5).

        Lazy-imports ``sherpa_onnx`` (so this module imports without it). Building the default
        ``OfflineSpeakerDiarization`` instance loads both ONNX models; the 1s silent dummy
        ``process()`` initializes the ORT graph so the first real diarize isn't JIT-penalized.
        Guarded by a lock + ``_ready`` flag exactly like ``MlxWhisperBackend.warm_up``.

        The default pipeline is keyed and stashed in ``self._pipelines`` under the configured
        ``(num_speakers, threshold)`` so a later per-call override NEVER mutates it (the Phase-10
        carry-forward fix — see ``diarize``).
        """
        async with self._lock:
            if self._ready:
                return
            for f in (self.seg_model, self.emb_model):
                if not Path(f).is_file():
                    raise RuntimeError(f"diarization model not found: {f}")
            sherpa_onnx = await asyncio.to_thread(importlib.import_module, "sherpa_onnx")
            if sherpa_onnx is None:
                raise RuntimeError("sherpa_onnx module is unavailable")

            default_key = self._config_key(self.num_speakers, self.threshold)

            def _load_and_prime():
                sd = sherpa_onnx.OfflineSpeakerDiarization(
                    self._build_config(sherpa_onnx, self.num_speakers, self.threshold)
                )
                # Dummy pass on 1s of silence → primes the ORT graph (returns 0 turns).
                try:
                    import numpy as np

                    sd.process(np.zeros(int(sd.sample_rate), dtype="float32"))
                except Exception:
                    # A failed dummy pass must not block readiness — the real pass will surface
                    # any genuine error. Priming is best-effort cold-start amortization.
                    pass
                return sd

            sd = await asyncio.to_thread(_load_and_prime)
            self._sd = sd                       # the resident DEFAULT pipeline (never mutated)
            self._default_key = default_key
            self._pipelines = {default_key: sd}  # count-keyed cache (default seeded here)
            self._sherpa = sherpa_onnx
            self._ready = True

    def release(self) -> None:
        self._sd = None
        self._sherpa = None
        self._ready = False
        self._pipelines = {}
        self._default_key = None

    @staticmethod
    def _config_key(num_speakers: Optional[int], threshold: float) -> tuple[int, float]:
        """Normalized cache key for a (count, threshold) pipeline.

        ``num_speakers`` None / <=0 all collapse to the same ``-1`` (auto) bucket; threshold is
        rounded so float jitter can't fragment the cache. Auto pipelines are keyed by threshold
        (different auto thresholds are genuinely different pipelines); count pipelines ignore
        threshold (sherpa ignores ``threshold`` when ``num_clusters > 0``) → keyed to ``0.0``.
        """
        n = int(num_speakers) if (num_speakers and num_speakers > 0) else -1
        thr = 0.0 if n > 0 else round(float(threshold), 4)
        return (n, thr)

    async def diarize(
        self,
        *,
        audio_path: str,
        num_speakers: Optional[int] = None,
        threshold: Optional[float] = None,
        cancel_token: CancelToken,
    ) -> list[SpeakerTurn]:
        """Run diarization on ``audio_path`` → speaker turns (seconds + cluster index).

        Per-call ``num_speakers`` (> 0) forces that many clusters for THIS call only; per-call
        ``threshold`` (> 0) overrides the auto-mode threshold for THIS call only. Both come from
        :func:`stt_daemon.speaker_count.resolve_speaker_count` (the calendar-prior strategy).

        Carry-forward fix (Phase-12): an override builds (or reuses) a pipeline from a **count-keyed
        cache** (``self._pipelines``) and NEVER reassigns/mutates the resident default ``self._sd``.
        So a count-override call followed by an auto call is served by two distinct cached pipelines
        — the override can no longer bleed into auto mode. Reads audio with ``soundfile``, downmixes
        to mono, resamples to ``sd.sample_rate`` (16 kHz) if needed — no network, all local files.
        """
        cancel_token.check()

        if not self._ready:
            await self.warm_up()

        # Resolve the EFFECTIVE (count, threshold) for this call: per-call override else configured.
        eff_n = num_speakers if (num_speakers and num_speakers > 0) else self.num_speakers
        eff_thr = threshold if (threshold and threshold > 0) else self.threshold
        key = self._config_key(eff_n, eff_thr)

        # Serve from the count-keyed cache; build (and cache) a new pipeline on a miss. The default
        # pipeline (self._sd) is in the cache under self._default_key and is never overwritten.
        sd = self._pipelines.get(key)
        if sd is None:
            sherpa_onnx = self._sherpa
            if sherpa_onnx is None:
                raise RuntimeError("diarization pipeline not loaded")
            eff_n_norm = eff_n if (eff_n and eff_n > 0) else None
            sd = await asyncio.to_thread(
                lambda: sherpa_onnx.OfflineSpeakerDiarization(
                    self._build_config(sherpa_onnx, eff_n_norm, eff_thr)
                )
            )
            self._pipelines[key] = sd

        if sd is None:
            raise RuntimeError("diarization pipeline not loaded")

        def _run() -> list[SpeakerTurn]:
            import numpy as np
            import soundfile as sf

            audio, sr = sf.read(audio_path, dtype="float32", always_2d=False)
            if getattr(audio, "ndim", 1) > 1:
                audio = audio[:, 0]  # downmix to the first channel
            target = sd.sample_rate
            if sr != target:
                # Simple linear resample to the model rate (spike convention).
                x = np.linspace(0, len(audio), int(len(audio) * target / sr), endpoint=False)
                audio = np.interp(x, np.arange(len(audio)), audio).astype("float32")
            result = sd.process(audio).sort_by_start_time()
            return [
                SpeakerTurn(start=round(float(r.start), 3),
                            end=round(float(r.end), 3),
                            speaker_idx=int(r.speaker))
                for r in result
            ]

        turns = await asyncio.to_thread(_run)
        cancel_token.check()
        return turns
