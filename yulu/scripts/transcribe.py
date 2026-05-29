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

from transcribe_client import (
    request_final_transcribe, DaemonUnavailable, DaemonError,
)

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
    if not text:
        return None
    # Guard: the realtime transcript file sometimes ends up holding agent-event
    # JSON (e.g. realtime_transcript_error / realtime_transcript_ready events)
    # instead of transcript text. A real transcript is never a JSON object/array
    # (the live format is plain "[Me] ..." lines, which is NOT valid JSON), so if
    # the content parses as a JSON list/dict, treat it as "no transcript" and let
    # the caller fall back to whole-file transcription.
    if text[0] in "[{":
        try:
            parsed = json.loads(text)
        except ValueError:
            return text
        if isinstance(parsed, (list, dict)):
            return None
    return text


def _request_final_transcribe_raw(audio_path: Path, trans_cfg: dict, meeting_title: str) -> dict:
    """Channel-aware transcribe RPC; returns raw daemon payload or error envelope."""
    try:
        return request_final_transcribe(
            wav=str(audio_path), title=meeting_title,
            language=trans_cfg.get("language", "zh"),
            engine=trans_cfg.get("final_engine", "mlx"),
            channel_split=True,
        )
    except (DaemonUnavailable, DaemonError) as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return {"status": "error", "error": str(exc)}


def _request_final_transcribe(audio_path: Path, trans_cfg: dict, meeting_title: str) -> Optional[dict]:
    """Returns the daemon's response dict if status=ok, else None."""
    resp = _request_final_transcribe_raw(audio_path, trans_cfg, meeting_title)
    if resp.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {resp.get('error')}", file=sys.stderr)
        return None
    return resp


def _enqueue_summary_request(*, prompt, audio_path, transcript_path,
                             meeting_title, output_path, queue_path) -> None:
    """Append a summary_request event; summary prompts also carry html_path_hint."""
    from queue_store import append_event
    extras = {}
    if prompt.category.value == "summary":
        extras["html_path_hint"] = str(output_path.with_suffix(".html"))
    append_event(
        "summary_request", path=queue_path, title=meeting_title,
        audio_path=str(audio_path), transcript_path=str(transcript_path),
        summary_path=str(output_path),
        prompt_id=prompt.id, prompt_slug=prompt.slug, prompt_name=prompt.name,
        prompt_content_snapshot=prompt.content, **extras,
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

    raw_path = audio_path.with_suffix(".raw.transcript.txt")
    transcript_path = audio_path.with_suffix(".transcript.txt")
    realtime_path = audio_path.with_suffix(".realtime.transcript.txt")
    post_mode = normalize_post_recording_mode(trans_cfg.get("post_recording_mode"))

    # 1. Acquire transcripts. Fast mode prefers realtime mono; otherwise hit
    # the daemon with channel_split=True so dual-track WAVs come back split.
    merged: Optional[str] = None
    mic_text: Optional[str] = None
    sys_text: Optional[str] = None

    if post_mode == FAST_POST_RECORDING_MODE:
        merged = read_realtime_transcript(realtime_path)
        if merged:
            print(f"⚡ 使用实时转写结果: {realtime_path}")
        else:
            print("⚠️ 未找到可用实时转写，回退到完整 daemon 转录", file=sys.stderr)

    if merged is None:
        response = _request_final_transcribe(audio_path, trans_cfg, meeting_title)
        if response is None:
            merged = read_realtime_transcript(realtime_path)
            if merged is None:
                print("❌ 无法获取任何转录，daemon 不可用且无 realtime 结果", file=sys.stderr)
                sys.exit(2)
        elif "channels" in response:
            from stt_daemon.transcript_merge import merge_segments
            mic_payload = response["channels"].get("mic", {}) or {}
            sys_payload = response["channels"].get("sys", {}) or {}
            mic_text = mic_payload.get("text", "") or ""
            sys_text = sys_payload.get("text", "") or ""
            merged = merge_segments(
                mic=mic_payload.get("segments", []) or [],
                sys=sys_payload.get("segments", []) or [],
            )
        else:
            merged = response.get("text", "") or ""

    # 2. Persist transcripts. `.transcript.txt` may be overwritten later by a
    # cleanup prompt; `.raw.transcript.txt` preserves the pre-cleanup snapshot.
    raw_path.write_text(merged, encoding="utf-8")
    transcript_path.write_text(merged, encoding="utf-8")
    print(f"✅ 原始转录已保存: {raw_path}")
    print(f"✅ 初始 transcript 已保存: {transcript_path}")

    try:  # best-effort search-index push; reader sweep covers misses
        from search import indexer as _idx
        _idx.upsert_doc(source_path=transcript_path,
                        kind=_idx.KIND_MEETING_TRANSCRIPT, body=merged)
    except Exception as exc:
        print(f"⚠️ search index upsert failed for {transcript_path}: {exc}",
              file=sys.stderr)

    if mic_text is not None:
        audio_path.with_suffix(".mic.transcript.txt").write_text(mic_text, encoding="utf-8")
    if sys_text is not None:
        audio_path.with_suffix(".sys.transcript.txt").write_text(sys_text, encoding="utf-8")

    # 3. Enqueue auto-run prompts (unchanged from Phase 2).
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
