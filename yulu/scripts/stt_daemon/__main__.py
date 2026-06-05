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
    return backends


async def _run() -> int:
    cfg = DaemonConfig.from_user_config()
    backends = _build_real_backends(cfg)
    app = STTDaemonApp(cfg, backends=backends)
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
