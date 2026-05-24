"""Voicemail recorder — start/stop orchestration and post-stop transcribe.

This module owns the contract between `yulu memo` and the existing
audio_daemon / stt_daemon / agent_queue_worker pipeline. It does NOT
duplicate any Phase 1-3 primitives:

- Recording start  → record_audio.socket_send({action:'start', sys_disabled:true, ...})
- Recording stop   → record_audio.socket_send({action:'stop'})
- Transcript       → transcribe_client.request_final_transcribe(channel_split=True)
- Enqueue          → transcribe._enqueue_summary_request (reused verbatim)
- LLM dispatch     → agent_queue_worker (unchanged)
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Optional

from voicemail.repo import VOICEMAIL_DIR_DEFAULT

# Mirror Phase 2/3 constants for the live deployment
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
VOICEMAIL_DIR = VOICEMAIL_DIR_DEFAULT
DEFAULT_SILENCE_SECONDS = 3


def _request_transcribe(wav_path: Path) -> dict:
    """Thin wrapper around transcribe_client; isolates the import for tests."""
    from transcribe_client import request_final_transcribe
    try:
        return request_final_transcribe(
            wav=str(wav_path),
            title=wav_path.stem,
            language="zh",
            channel_split=True,
        )
    except Exception as exc:
        return {"status": "error", "error": str(exc)}


def _extract_mic_text(response: dict) -> str:
    """Voicemails are single-speaker. Pick the mic-side text only; never
    invoke merge_segments (which would prefix `[00:00 我]`)."""
    if "channels" in response:
        return (response["channels"].get("mic", {}).get("text") or "").strip()
    # Legacy single-text shape (channel_split=False or MONO/LEGACY input)
    return (response.get("text") or "").strip()


def _enqueue_voicemail_prompts(audio_path: Path, transcript_path: Path,
                                title: str, prompts_db: Path,
                                queue_path: Path) -> int:
    """Iterate voicemail-category auto-run prompts and enqueue one
    summary_request per. Returns the count enqueued."""
    from prompts.cache import PromptsCache
    from transcribe import _enqueue_summary_request   # Phase 2/3 helper

    cache = PromptsCache(prompts_db)
    cache.load()
    queued = 0
    for prompt in cache.auto_run("voicemail"):
        # Default slug ('voicemail-todos') drops to <wav>.summary.md per the
        # Phase 2 convention (the slug whose category is the de-facto default
        # for this audio kind writes to the no-infix path so send_summary +
        # Obsidian + html artifacts work unchanged).
        if prompt.slug == "voicemail-todos":
            output_path = audio_path.with_suffix(".summary.md")
        else:
            output_path = audio_path.with_suffix(f".{prompt.slug}.summary.md")
        _enqueue_summary_request(
            prompt=prompt,
            audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=title,
            output_path=output_path,
            queue_path=queue_path,
        )
        queued += 1
    return queued


def _persist_title_sidecar(wav_path: Path, title: Optional[str]) -> None:
    if not title:
        return
    wav_path.with_suffix(".title").write_text(title + "\n", encoding="utf-8")


def _transcribe_and_enqueue(wav_path: Path, *, title: Optional[str]) -> int:
    """Post-stop pipeline. Returns 0 on success, non-zero on failure."""
    response = _request_transcribe(wav_path)
    if response.get("status") != "ok":
        print(
            f"⚠️ stt_daemon transcribe failed: {response.get('error')}",
            file=sys.stderr,
        )
        return 2

    text = _extract_mic_text(response)

    raw_path = wav_path.with_suffix(".raw.transcript.txt")
    transcript_path = wav_path.with_suffix(".transcript.txt")
    raw_path.write_text(text, encoding="utf-8")
    transcript_path.write_text(text, encoding="utf-8")
    _persist_title_sidecar(wav_path, title)

    meeting_title = title or wav_path.stem
    queued = _enqueue_voicemail_prompts(
        audio_path=wav_path,
        transcript_path=transcript_path,
        title=meeting_title,
        prompts_db=PROMPTS_DB,
        queue_path=AGENT_QUEUE_PATH,
    )
    print(f"📤 enqueued {queued} voicemail prompt(s)", file=sys.stderr)
    return 0
