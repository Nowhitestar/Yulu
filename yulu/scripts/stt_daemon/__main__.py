"""Entry point: `python -m stt_daemon` or `python -m stt_daemon.__main__`."""

from __future__ import annotations

import asyncio
import sys

from .app import STTDaemonApp
from .config import DaemonConfig


def _build_real_backends(config: DaemonConfig):
    from .backends.mlx import MlxWhisperBackend
    from .backends.whisper_cli import WhisperCliBackend

    return {
        "mlx": MlxWhisperBackend(
            model=config.mlx_model,
            language=config.default_language,
        ),
        "whisper": WhisperCliBackend(
            binary=config.whisper_cli,
            model_path=config.whisper_model,
        ),
    }


async def _run() -> int:
    cfg = DaemonConfig.from_user_config()
    backends = _build_real_backends(cfg)
    app = STTDaemonApp(cfg, backends=backends)
    await app.start()
    try:
        while True:
            await asyncio.sleep(3600)
    except asyncio.CancelledError:
        await app.stop()
    return 0


def main() -> int:
    try:
        return asyncio.run(_run())
    except KeyboardInterrupt:
        return 0


if __name__ == "__main__":
    sys.exit(main())
