"""Cloud-command transcription backend.

Mirrors the `llm.command` trust boundary (agent_queue_worker._run_llm): Yulu
holds NO cloud credentials. It simply spawns the user-configured command array
(`transcription.cloud_command`), hands it the audio file, and reads the
transcript text from the command's stdout. The user's command is responsible
for talking to whatever cloud STT they trust (and for holding its own keys).

How the audio path reaches the command (the same template convention
configure.py uses for the whisper `command`):
  * if any arg contains the literal `{{input}}`, it is replaced with the audio
    path (every occurrence);
  * otherwise the audio path is appended as the final argument.

stdout (stripped) is the transcript. A non-zero exit, empty output, or a spawn
failure raises RuntimeError so the runtime's mode dispatch can fall back to a
local engine.
"""

from __future__ import annotations

import asyncio
from typing import Optional

from ..runtime import CancelToken, STTResult

INPUT_PLACEHOLDER = "{{input}}"


class CloudCommandBackend:
    """Spawns the user's own cloud-transcription command per request."""

    def __init__(self, *, command: Optional[list[str]] = None):
        # A copy so later config reloads that hand a fresh list never mutate ours.
        self.command: list[str] = list(command or [])
        self._ready = False

    def is_ready(self) -> bool:
        return self._ready

    async def warm_up(self) -> None:
        # Readiness == a non-empty command is configured. There is nothing to
        # load; the command is spawned fresh on each request.
        self._ready = bool(self.command)

    def release(self) -> None:
        self._ready = False

    def _build_argv(self, audio_path: str) -> list[str]:
        if any(INPUT_PLACEHOLDER in arg for arg in self.command):
            return [arg.replace(INPUT_PLACEHOLDER, audio_path) for arg in self.command]
        return [*self.command, audio_path]

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
    ) -> STTResult:
        cancel_token.check()
        if not self.command:
            raise RuntimeError("cloud transcription command is not configured")

        argv = self._build_argv(audio_path)
        proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            stdout, stderr = await proc.communicate()
        except asyncio.CancelledError:
            proc.kill()
            raise

        cancel_token.check()

        if proc.returncode != 0:
            raise RuntimeError(
                f"cloud command failed (rc={proc.returncode}): {stderr.decode()[:500]}"
            )

        text = stdout.decode("utf-8", errors="replace").strip()
        if not text:
            raise RuntimeError("cloud command produced empty output")

        return STTResult(
            text=text,
            raw_text=text,
            segments=[],
            language=language,
            duration_ms=0,
        )
