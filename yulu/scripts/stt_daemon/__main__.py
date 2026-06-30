"""Entry point: `python -m stt_daemon` or `python -m stt_daemon.__main__`."""

from __future__ import annotations

import asyncio
import sys

from .app import STTDaemonApp
from .config import DaemonConfig


def _build_real_backends(config: DaemonConfig):
    from .backends.mlx import MlxWhisperBackend
    from .backends.whisper_cli import WhisperCliBackend
    from .backends.cloud import CloudCommandBackend
    from .backends.hermes import HermesSTTBackend

    final_mlx = MlxWhisperBackend(
        model=config.mlx_model,
        language=config.default_language,
    )
    backends = {
        "mlx": final_mlx,
        "whisper": WhisperCliBackend(
            binary=config.whisper_cli,
            model_path=config.whisper_model,
        ),
        # User's own cloud-transcription command (transcription.cloud_command).
        # Empty by default → CloudCommandBackend stays not-ready and the runtime's
        # mode dispatch simply never routes to it.
        "cloud": CloudCommandBackend(command=config.cloud_command),
        "hermes": HermesSTTBackend(
            agent_dir=config.hermes_agent_dir,
            model=config.hermes_model,
            diarize=config.hermes_diarize,
        ),
    }
    # Realtime/live tail engine. When the realtime model differs from the final
    # model, register a SEPARATE backend (a second resident model) so the live
    # tail runs the fast model while the final pass keeps large-v3. When they
    # match, alias to the same instance to avoid loading two big models twice.
    if config.realtime_mlx_model and config.realtime_mlx_model != config.mlx_model:
        backends["mlx-realtime"] = MlxWhisperBackend(
            model=config.realtime_mlx_model,
            language=config.default_language,
        )
    else:
        backends["mlx-realtime"] = final_mlx
    # NOTE: the diarize backend is INTENTIONALLY NOT added here. It is a sibling stage,
    # not an ASR engine; keeping it out of this dict guarantees STTRuntime._engine_chain
    # (mlx→whisper→cloud) can never route an ASR request to diarization (ARCHITECTURE
    # Anti-Pattern 1). Construct it separately via _build_diarize_backend().
    return backends


def _build_diarize_backend(config: DaemonConfig):
    """Construct the config-SELECTED diarize backend, or ``None`` when disabled/unknown (DIAR-01).

    Deliberately a separate constructor from ``_build_real_backends`` so the diarize backend is
    held OFF the ASR ``backends`` dict — the ASR fallback chain can never reach it. The provider
    string selects the implementation (today: ``sherpa-onnx``); an unknown provider returns
    ``None`` rather than raising, so a typo degrades to "diarization disabled", not a daemon crash.
    """
    if not config.diarize_enabled:
        return None
    provider = (config.diarize_provider or "").strip().lower()
    if provider in ("", "sherpa-onnx", "sherpa"):
        from .backends.diarize import SherpaDiarizeBackend, resolve_model_paths

        seg, emb = resolve_model_paths(
            seg_path=config.diarize_seg_model or None,
            emb_path=config.diarize_emb_model or None,
        )
        return SherpaDiarizeBackend(
            seg_model=str(seg),
            emb_model=str(emb),
            num_speakers=config.diarize_num_speakers,
            threshold=config.diarize_threshold,
        )
    # Unknown provider (e.g. a future "funasr" before it ships) → no backend.
    return None


async def _run() -> int:
    cfg = DaemonConfig.from_user_config()
    backends = _build_real_backends(cfg)
    app = STTDaemonApp(cfg, backends=backends)
    # Diarize backend (DIAR-01): config-selected, held on the app OFF the ASR runtime dict.
    # Phase 13 wires the JobKind.DIARIZE dispatch that consumes it; here we only construct +
    # attach it so the resident model can be warmed and the seam exists. None when disabled.
    app.diarize_backend = _build_diarize_backend(cfg)
    await app.start()
    try:
        # Park until the signal handler stops the app. The handler awaits
        # app.stop() which sets stopped_event — that's our exit signal.
        await app.stopped_event.wait()
    except asyncio.CancelledError:
        if not app.stopped_event.is_set():
            await app.stop()
    return 0


def main() -> int:
    try:
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
