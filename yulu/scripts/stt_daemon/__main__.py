"""Entry point: `python -m stt_daemon` or `python -m stt_daemon.__main__`."""

from __future__ import annotations

import asyncio
import sys

from .app import STTDaemonApp
from .config import DaemonConfig


def _build_real_backends(config: DaemonConfig):
    """Return real backends. Implemented in Phase 3."""
    from .runtime import MockSTTBackend
    return {
        "mlx": MockSTTBackend(canned_text="(mock — install Phase 3 backends)"),
        "whisper": MockSTTBackend(canned_text="(mock whisper-cli)"),
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
