"""Voicemail recorder — start/stop orchestration and post-stop transcribe.

This module owns the contract between `yulu memo` and the existing
audio_daemon / stt_daemon / agent_queue_worker pipeline. It does NOT
duplicate any Phase 1-3 primitives:

- Recording start  → record_audio.socket_send({action:'start', sys_disabled:true, ...})
- Realtime tail    → record_audio.start_realtime_transcriber (Phase 1, reused)
- Recording stop   → record_audio.socket_send({action:'stop'})
- Transcript       → realtime tail by default (fast_summary), fallback final transcribe
- Enqueue          → transcribe._enqueue_summary_request (reused verbatim)
- LLM dispatch     → agent_queue_worker (unchanged)
"""

from __future__ import annotations

import json
import re
import signal
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

from voicemail.repo import VOICEMAIL_DIR_DEFAULT

# Mirror Phase 2/3 constants for the live deployment
CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
VOICEMAIL_DIR = VOICEMAIL_DIR_DEFAULT
DEFAULT_SILENCE_SECONDS = 3

_SPEAKER_TAG_RE = re.compile(r"^\s*\[(?:Me|Them|我|对方)\]\s*", re.IGNORECASE)


def _load_transcription_cfg() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text()).get("transcription", {}) or {}
    except Exception:
        return {}


def _post_recording_mode() -> str:
    from transcribe import normalize_post_recording_mode
    cfg = _load_transcription_cfg()
    return normalize_post_recording_mode(cfg.get("post_recording_mode"))


def _read_realtime_voicemail(path: Path) -> Optional[str]:
    """读 realtime tail 的 `.realtime.transcript.txt`，剥掉 [Me] / [Them] 前缀。
    voicemail 是单说话人，prompt 模板只关心干净文本。"""
    if not path.exists():
        return None
    raw = path.read_text(encoding="utf-8")
    cleaned_lines = []
    for line in raw.splitlines():
        stripped = _SPEAKER_TAG_RE.sub("", line).strip()
        if stripped:
            cleaned_lines.append(stripped)
    text = "\n".join(cleaned_lines).strip()
    return text or None


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
    """Post-stop pipeline. Returns 0 on success, non-zero on failure.

    Modes (transcription.post_recording_mode in config.json):
    - fast_summary (default): use the realtime tail transcript directly,
      skipping the full stt_daemon transcribe to keep wall-clock latency
      under a second.
    - full_transcribe: hit stt_daemon for a full pass (legacy behaviour),
      kept for cases where the user wants higher-fidelity transcripts.
    Fast mode falls back to a full transcribe if the realtime file is
    missing (daemon crashed, realtime disabled, etc.)."""
    mode = _post_recording_mode()
    realtime_path = wav_path.with_suffix(".realtime.transcript.txt")
    text: Optional[str] = None

    if mode == "fast_summary":
        text = _read_realtime_voicemail(realtime_path)
        if text:
            print(f"⚡ 使用实时转写结果: {realtime_path.name}", file=sys.stderr)
        else:
            print(
                "⚠️ 未找到实时转写结果，回退到 stt_daemon 完整转录",
                file=sys.stderr,
            )

    if text is None:
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


# Module-level seam for tests (patchable)
_poll_interval = 1.0


def _socket_send(cmd: dict):
    """Indirection so tests can stub the daemon socket without importing
    record_audio.socket_send everywhere."""
    from record_audio import socket_send
    return socket_send(cmd)


def _start_realtime_tail(wav_path: Path, title: str) -> None:
    """Spawn realtime_transcribe.py via the Phase-1 helper. No-op if disabled
    in config (transcription.realtime_enabled / audio.realtime_transcribe)."""
    try:
        from record_audio import start_realtime_transcriber
        start_realtime_transcriber(str(wav_path), title)
    except Exception as exc:
        print(f"⚠️ realtime tail start failed: {exc}", file=sys.stderr)


def _stop_realtime_tail(*, graceful: bool) -> None:
    """Tell realtime_transcribe.py to wind down. graceful=True waits up to
    ~3 min for whisper to flush the last chunk; graceful=False kills hard."""
    try:
        from record_audio import stop_realtime_transcriber
        stop_realtime_transcriber(wait=True, graceful=graceful)
    except Exception as exc:
        print(f"⚠️ realtime tail stop failed: {exc}", file=sys.stderr)


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
            # 启动实时转写 tail：subscribe stt_daemon session，把 partials 增量写入
            # <wav>.realtime.transcript.txt。post_recording_mode=fast_summary 时，
            # 录制结束后直接读这个文件给 LLM，跳过整段重转，秒级出 summary。
            _start_realtime_tail(wav_path, title or stem)
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
            # graceful=True：让 realtime tail 把 daemon 通知的最后一段 partial
            # 落盘后再退，避免末尾几秒丢失。
            _stop_realtime_tail(graceful=True)
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
    except BaseException:
        # 录制循环异常退出时也要清理 realtime tail，避免 PID 文件残留。
        _stop_realtime_tail(graceful=False)
        raise

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
