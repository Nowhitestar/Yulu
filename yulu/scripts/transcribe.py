#!/usr/bin/env python3
"""Process a recorded meeting: get transcript via stt_daemon, then enqueue
auto-run prompts for agent_queue_worker to handle.

After Task 5.2 (Prompt Library spec), this file is a PURE ORCHESTRATOR:
no inline LLM calls, no hardcoded prompts. The agent_queue_worker is the
sole LLM dispatcher; this file decides WHAT to enqueue based on
prompts.sqlite's is_auto_run rows.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional

from transcribe_client import transcribe_file, DaemonUnavailable, DaemonError

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"

FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"


def load_config() -> dict:
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


def normalize_post_recording_mode(value) -> str:
    raw = str(value or FAST_POST_RECORDING_MODE).strip().lower().replace("-", "_")
    aliases = {
        "fast": FAST_POST_RECORDING_MODE, "quick": FAST_POST_RECORDING_MODE,
        "realtime": FAST_POST_RECORDING_MODE, "realtime_polish": FAST_POST_RECORDING_MODE,
        "realtime_summary": FAST_POST_RECORDING_MODE, "fast_summary": FAST_POST_RECORDING_MODE,
        "full": FULL_POST_RECORDING_MODE, "quality": FULL_POST_RECORDING_MODE,
        "final": FULL_POST_RECORDING_MODE, "full_transcribe": FULL_POST_RECORDING_MODE,
        "final_transcribe": FULL_POST_RECORDING_MODE,
    }
    return aliases.get(raw, raw if raw in {FAST_POST_RECORDING_MODE, FULL_POST_RECORDING_MODE} else FAST_POST_RECORDING_MODE)


def read_realtime_transcript(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def _notify_agent(event_type: str, **kw):
    try:
        from agent_notify import notify
        notify(event_type, **kw)
    except Exception:
        pass


def _request_final_transcribe(audio_path: Path, trans_cfg: dict, meeting_title: str) -> Optional[str]:
    engine = trans_cfg.get("final_engine", "mlx")
    language = trans_cfg.get("language", "zh")
    try:
        response = transcribe_file(
            audio_path=str(audio_path),
            engine=engine, language=language,
            meeting_title=meeting_title, kind="file_transcribe",
        )
    except DaemonUnavailable as exc:
        print(f"⚠️ stt_daemon unavailable: {exc}", file=sys.stderr)
        return None
    except DaemonError as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return None
    if response.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {response.get('error')}", file=sys.stderr)
        return None
    return response["text"]


def _enqueue_summary_request(*, prompt, audio_path, transcript_path,
                             meeting_title, output_path, queue_path) -> None:
    """Build a summary_request event and append to queue_path.

    For category=='summary' prompts: include html_path_hint pointing at
    the .html sibling of output_path. For category=='cleanup': omit
    html_path_hint (worker won't generate html for cleanup).
    """
    from queue_store import append_event
    extras = {}
    if prompt.category.value == "summary":
        extras["html_path_hint"] = str(output_path.with_suffix(".html"))
    append_event(
        "summary_request",
        path=queue_path,
        title=meeting_title,
        audio_path=str(audio_path),
        transcript_path=str(transcript_path),
        summary_path=str(output_path),
        prompt_id=prompt.id,
        prompt_slug=prompt.slug,
        prompt_name=prompt.name,
        prompt_content_snapshot=prompt.content,
        **extras,
    )


def process_audio(audio_path_str: str) -> None:
    config = load_config()
    trans_cfg = config.get("transcription", {})

    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"📁 处理: {audio_path.name}（标题: {meeting_title}）")

    # 1. Acquire transcript via stt_daemon (with realtime fallback per mode)
    raw_transcript_path = audio_path.with_suffix(".raw.transcript.txt")
    realtime_transcript_path = audio_path.with_suffix(".realtime.transcript.txt")
    transcript: Optional[str] = None
    post_mode = normalize_post_recording_mode(trans_cfg.get("post_recording_mode"))

    if post_mode == FAST_POST_RECORDING_MODE:
        transcript = read_realtime_transcript(realtime_transcript_path)
        if transcript:
            print(f"⚡ 使用实时转写结果: {realtime_transcript_path}")
        else:
            print("⚠️ 未找到可用实时转写，回退到完整 daemon 转录", file=sys.stderr)

    if transcript is None:
        transcript = _request_final_transcribe(audio_path, trans_cfg, meeting_title)
        if transcript is None:
            transcript = read_realtime_transcript(realtime_transcript_path)
            if transcript is None:
                print("❌ 无法获取任何转录，daemon 不可用且无 realtime 结果", file=sys.stderr)
                sys.exit(2)

    # 2. Persist raw and (initial) clean transcript files.
    # The .transcript.txt may be overwritten later by a cleanup prompt
    # dispatched through the queue.
    raw_transcript_path.write_text(transcript, encoding="utf-8")
    transcript_path = audio_path.with_suffix(".transcript.txt")
    transcript_path.write_text(transcript, encoding="utf-8")
    print(f"✅ 原始转录已保存: {raw_transcript_path}")
    print(f"✅ 初始 transcript 已保存: {transcript_path}")

    # 3. Enqueue auto-run prompts.
    from prompts.cache import PromptsCache
    cache = PromptsCache(PROMPTS_DB)
    cache.load()
    queued = 0
    for prompt in cache.auto_run("cleanup"):
        _enqueue_summary_request(
            prompt=prompt, audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=meeting_title,
            output_path=transcript_path,  # cleanup overwrites the transcript
            queue_path=AGENT_QUEUE_PATH,
        )
        queued += 1
    for prompt in cache.auto_run("summary"):
        suffix = ".summary.md" if prompt.slug == "summary" else f".{prompt.slug}.summary.md"
        output_path = audio_path.with_suffix(suffix)
        _enqueue_summary_request(
            prompt=prompt, audio_path=audio_path,
            transcript_path=transcript_path,
            meeting_title=meeting_title,
            output_path=output_path,
            queue_path=AGENT_QUEUE_PATH,
        )
        queued += 1

    print(f"📤 enqueued {queued} LLM jobs; agent_queue_worker will process them")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    process_audio(sys.argv[1])
