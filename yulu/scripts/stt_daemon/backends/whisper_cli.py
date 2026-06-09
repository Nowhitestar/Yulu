"""whisper-cli subprocess backend (whisper.cpp variant)."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from ..runtime import CancelToken, STTResult


class WhisperCliBackend:
    """Spawns whisper-cli per request. Output is parsed from the -of text file."""

    def __init__(
        self,
        *,
        binary: str,
        model_path: str,
    ):
        self.binary = binary
        self.model_path = model_path
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def warm_up(self) -> None:
        # Nothing to load — readiness == binary exists.
        self._ready = Path(self.binary).exists()

    def release(self) -> None:
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
        await self.warm_up()
        if not Path(self.binary).exists():
            raise RuntimeError(f"whisper-cli binary not found: {self.binary}")

        output_stem = str(Path(audio_path).with_suffix("")) + ".whisper"
        output_txt = Path(f"{output_stem}.txt")
        cmd = [
            self.binary,
            "-m", str(self.model_path),
            "-l", language,
            "-otxt",
            "-of", output_stem,
            audio_path,
        ]
        if initial_prompt:
            cmd.extend(["--prompt", initial_prompt])

        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await proc.communicate()
        except asyncio.CancelledError:
            proc.kill()
            raise

        if proc.returncode != 0:
            raise RuntimeError(
                f"whisper-cli failed (rc={proc.returncode}): {stderr.decode()[:500]}"
            )
        if not output_txt.exists():
            raise RuntimeError(f"whisper-cli did not write {output_txt}")

        text = output_txt.read_text(encoding="utf-8").strip()
        try:
            output_txt.unlink()
        except OSError:
            pass
        return STTResult(
            text=text,
            raw_text=text,
            segments=[],
            language=language,
            duration_ms=0,
        )
