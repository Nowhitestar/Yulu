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

import re
import signal
import sys
import time
from datetime import datetime
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


def _finalize_transcript(wav_path: Path, text: str, *, title: Optional[str]) -> int:
    """Write raw+final transcript, persist title sidecar, push to the search
    index (best-effort), and enqueue voicemail prompts. Returns 0.

    Shared by the whole-file path (_transcribe_and_enqueue) and the realtime
    promote path (_promote_realtime_transcript)."""
    raw_path = wav_path.with_suffix(".raw.transcript.txt")
    transcript_path = wav_path.with_suffix(".transcript.txt")
    raw_path.write_text(text, encoding="utf-8")
    transcript_path.write_text(text, encoding="utf-8")
    _persist_title_sidecar(wav_path, title)

    # Best-effort search-index push. Failures here MUST NOT break the
    # recording pipeline — the reader-side sweep recovers any miss.
    try:
        from search import indexer as _search_indexer
        _search_indexer.upsert_doc(
            source_path=transcript_path,
            kind=_search_indexer.KIND_VOICEMAIL_TRANSCRIPT,
            body=text,
        )
    except Exception as exc:
        print(
            f"⚠️ search index upsert failed for {transcript_path}: {exc}",
            file=sys.stderr,
        )

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


_SPEAKER_TAG_RE = re.compile(r"^\[(?:Me|Them)\]\s*")


def _strip_speaker_tags(raw: str) -> str:
    """Realtime transcripts are line-per-partial with a [Me]/[Them] prefix.
    Voicemails are single-speaker — strip the tag, drop blank lines, and
    rejoin so the result matches the plain-text whole-file transcript."""
    out: list[str] = []
    for line in raw.splitlines():
        cleaned = _SPEAKER_TAG_RE.sub("", line).strip()
        if cleaned:
            out.append(cleaned)
    return "\n".join(out)


def _promote_realtime_transcript(wav_path: Path, *, title: Optional[str]) -> int:
    """Promote the live realtime transcript to the final transcript.
    Returns 0 on success; 2 if the realtime transcript is missing or empty
    (caller falls back to whole-file transcribe)."""
    rt_path = wav_path.with_suffix(".realtime.transcript.txt")
    if not rt_path.exists():
        return 2
    text = _strip_speaker_tags(rt_path.read_text(encoding="utf-8"))
    if not text:
        return 2
    return _finalize_transcript(wav_path, text, title=title)


def _transcribe_and_enqueue(wav_path: Path, *, title: Optional[str]) -> int:
    """Whole-file post-stop pipeline. Returns 0 on success, non-zero on failure."""
    response = _request_transcribe(wav_path)
    if response.get("status") != "ok":
        print(
            f"⚠️ stt_daemon transcribe failed: {response.get('error')}",
            file=sys.stderr,
        )
        return 2
    text = _extract_mic_text(response)
    return _finalize_transcript(wav_path, text, title=title)


# Module-level seam for tests (patchable)
_poll_interval = 1.0


def _socket_send(cmd: dict):
    """Indirection so tests can stub the daemon socket without importing
    record_audio.socket_send everywhere."""
    from record_audio import socket_send
    return socket_send(cmd)


def _acquire_recording_lock(*, timeout: float = 0.5):
    """Re-exposed so tests can stub away the OS-level flock."""
    from recording_lock import acquire as _acquire
    return _acquire(timeout=timeout)


def _record_lock_meta(handle, *, title: str, path: str, started_at: str) -> None:
    from recording_lock import record as _record
    _record(handle, title=title, path=path, started_at=started_at)


def _gen_stem(now: Optional[datetime] = None) -> str:
    now = now or datetime.now()
    return now.strftime("voicemail_%Y%m%d_%H%M%S")


def cmd_new(title: Optional[str] = None, *,
            silence_seconds: int = DEFAULT_SILENCE_SECONDS) -> int:
    """Start a voicemail recording and block until the daemon stops
    recording (Ctrl-C or silence-stop). Then transcribe + enqueue."""
    from recording_lock import RecordingBusy

    VOICEMAIL_DIR.mkdir(parents=True, exist_ok=True)
    stem = _gen_stem()

    wav_path: Optional[Path] = None
    try:
        # NOTE: _acquire_recording_lock is a @contextmanager — the flock
        # (and RecordingBusy) only fires at __enter__, so the try must
        # wrap the `with`, not the bare call.
        with _acquire_recording_lock(timeout=0.5) as lock_handle:
            resp = _socket_send({
                "action": "start",
                # Send literal "voicemail" — Swift's AudioRecorder.start
                # strips all non-alphanumerics from the title and appends
                # its own _<YYYYMMDD>_<HHMMSS>.wav suffix. A pre-stamped
                # stem would produce
                # "voicemailYYYYMMDDHHMMSS_YYYYMMDD_HHMMSS.wav" that fails
                # repo._STEM_RE.
                "title": "voicemail",
                "sys_disabled": True,
                "silence_seconds": silence_seconds,
                "output_dir": str(VOICEMAIL_DIR),
            })
            if not resp or resp.get("status") != "recording":
                print(f"⚠️ daemon failed to start: {resp}", file=sys.stderr)
                return 1
            wav_path = Path(resp.get("file") or (VOICEMAIL_DIR / f"{stem}.wav"))
            _record_lock_meta(
                lock_handle,
                title=stem,
                path=str(wav_path),
                started_at=datetime.now().isoformat(),
            )
            print(f"🎤 录音中 — Ctrl+C 停止 ({silence_seconds}s 静音自动停)",
                  file=sys.stderr)

            stop_requested = {"v": False}

            def _on_sigint(_sig, _frame):
                stop_requested["v"] = True

            prev = signal.signal(signal.SIGINT, _on_sigint)
            try:
                # Poll daemon status until it flips to not-recording.
                while True:
                    if stop_requested["v"]:
                        _socket_send({"action": "stop"})
                        stop_requested["v"] = False  # one-shot
                    status = _socket_send({"action": "status"}) or {}
                    if not status.get("recording"):
                        break
                    time.sleep(_poll_interval)
            finally:
                signal.signal(signal.SIGINT, prev)
            print("⏹ Stopped", file=sys.stderr)
    except RecordingBusy as exc:
        info = exc.info or {}
        print(
            f"⚠️ 录音正在进行中: {info.get('title', '<unknown>')}\n"
            f"   file: {info.get('path', '<unknown>')}\n"
            f"   started: {info.get('started_at', '<unknown>')}",
            file=sys.stderr,
        )
        return 2

    if wav_path is None or not wav_path.exists():
        print("⚠️ recording stopped but no .wav file present", file=sys.stderr)
        return 1
    return _transcribe_and_enqueue(wav_path, title=title)


def cmd_stop() -> int:
    """Stop any in-flight recording. Idempotent: prints 'no active recording'
    if nothing was recording. Does NOT trigger transcribe — that's the
    owner cmd_new's responsibility."""
    status = _socket_send({"action": "status"}) or {}
    if not status.get("recording"):
        print("no active recording", file=sys.stderr)
        return 0
    resp = _socket_send({"action": "stop"}) or {}
    print(f"⏹ Stopped: {resp.get('file', '<unknown>')}", file=sys.stderr)
    return 0
