#!/usr/bin/env python3
"""Process a recorded meeting: get transcript via stt_daemon, then enqueue
auto-run prompts for agent_queue_worker to handle.

After Task 5.2 (Prompt Library spec), this file is a PURE ORCHESTRATOR:
no inline LLM calls, no hardcoded prompts. The agent_queue_worker is the
sole LLM dispatcher; this file decides WHAT to enqueue based on
prompts.sqlite's is_auto_run rows.
"""

from __future__ import annotations

from difflib import SequenceMatcher
import json
import re
import sys
from pathlib import Path
from typing import Optional

from transcribe_client import (
    request_final_transcribe, DaemonUnavailable, DaemonError,
)
from realtime_coverage import realtime_coverage_ok as _realtime_coverage_ok
from audio_clean import select_transcription_audio

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"

FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"
OBVIOUS_HALLUCINATION_RE = re.compile(
    r"请不吝点赞\s*订阅\s*转发\s*打赏支持明镜与点点栏目"
)


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


def strip_obvious_hallucination_text(text: str) -> str:
    cleaned = OBVIOUS_HALLUCINATION_RE.sub("", text or "")
    return cleaned.strip(" \t\r\n，。,.")


def _segment_start_seconds(seg: dict) -> float:
    value = seg.get("start")
    if value is not None:
        return float(value)
    ms_value = seg.get("start_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return 0.0


def _repeat_key(text: str) -> str:
    return "".join(str(text or "").lower().split())


def _is_repetitive_hallucination(text: str) -> bool:
    key = _repeat_key(text)
    if len(key) < 16:
        return False
    counts: dict[str, int] = {}
    for ch in key:
        counts[ch] = counts.get(ch, 0) + 1
    if counts and max(counts.values()) / len(key) >= 0.45 and len(counts) <= 10:
        return True
    tokens = re.findall(r"[a-z]+|[\u3040-\u30ff]+", key)
    if len(tokens) >= 8:
        token_counts: dict[str, int] = {}
        for token in tokens:
            token_counts[token] = token_counts.get(token, 0) + 1
        if max(token_counts.values()) / len(tokens) >= 0.6:
            return True
    return False


def filter_obvious_hallucination_segments(segments: list[dict]) -> list[dict]:
    filtered: list[dict] = []
    last_key = ""
    last_start = -9999.0
    for seg in segments or []:
        item = dict(seg)
        text = strip_obvious_hallucination_text(str(item.get("text") or ""))
        if not text:
            continue
        if _is_repetitive_hallucination(text):
            continue
        key = _repeat_key(text)
        start = _segment_start_seconds(item)
        if key and key == last_key and len(key) >= 8 and start - last_start <= 30.0:
            continue
        item["text"] = text
        filtered.append(item)
        last_key = key
        last_start = start
    return filtered


def _segment_end_seconds(seg: dict) -> float:
    value = seg.get("end")
    if value is not None:
        return float(value)
    ms_value = seg.get("end_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return _segment_start_seconds(seg)


def _overlap_seconds(a: dict, b: dict) -> float:
    return max(
        0.0,
        min(_segment_end_seconds(a), _segment_end_seconds(b))
        - max(_segment_start_seconds(a), _segment_start_seconds(b)),
    )


def _similar_text(a: str, b: str) -> bool:
    ka = _repeat_key(a)
    kb = _repeat_key(b)
    if len(ka) < 4 or len(kb) < 4:
        return False
    if ka == kb or ka in kb or kb in ka:
        return True
    return SequenceMatcher(None, ka, kb).ratio() >= 0.68


def suppress_mic_leakage_segments(mic_segments: list[dict], sys_segments: list[dict]) -> list[dict]:
    kept: list[dict] = []
    for mic in mic_segments:
        mic_duration = max(0.1, _segment_end_seconds(mic) - _segment_start_seconds(mic))
        drop = False
        for sys_seg in sys_segments:
            overlap = _overlap_seconds(mic, sys_seg)
            if overlap < min(mic_duration, max(0.1, _segment_end_seconds(sys_seg) - _segment_start_seconds(sys_seg))) * 0.5:
                continue
            if _similar_text(str(mic.get("text") or ""), str(sys_seg.get("text") or "")):
                drop = True
                break
        if not drop:
            kept.append(mic)
    return kept


def transcript_text_from_segments(segments: list[dict], fallback: str) -> str:
    if segments:
        return " ".join(str(seg.get("text") or "").strip() for seg in segments if seg.get("text"))
    return strip_obvious_hallucination_text(fallback)


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
        "summary_request", queue_path=queue_path, title=meeting_title,
        audio_path=str(audio_path), transcript_path=str(transcript_path),
        summary_path=str(output_path),
        prompt_id=prompt.id, prompt_slug=prompt.slug, prompt_name=prompt.name,
        prompt_content_snapshot=prompt.content, **extras,
    )


def process_audio(audio_path_str: str, diarization_num_speakers: Optional[int] = None) -> None:
    config = load_config()
    trans_cfg = dict(config.get("transcription", {}) or {})
    if diarization_num_speakers is not None:
        diar_cfg = dict(trans_cfg.get("diarization", {}) or {})
        diar_cfg["enabled"] = True
        diar_cfg["num_speakers"] = diarization_num_speakers
        trans_cfg["diarization"] = diar_cfg
        print(f"👥 本次重转写使用说话人数: {diarization_num_speakers}")

    audio_path = Path(audio_path_str)
    if not audio_path.exists():
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)
    clean_audio_path = select_transcription_audio(audio_path, trans_cfg)

    meeting_title = audio_path.stem.rsplit("_", 1)[0].replace("_", " ")
    print(f"📁 处理: {audio_path.name}（标题: {meeting_title}）")
    if clean_audio_path != audio_path:
        print(f"🎧 已生成去回声播放音频: {clean_audio_path.name}")

    raw_path = audio_path.with_suffix(".raw.transcript.txt")
    transcript_path = audio_path.with_suffix(".transcript.txt")
    realtime_path = audio_path.with_suffix(".realtime.transcript.txt")
    post_mode = normalize_post_recording_mode(trans_cfg.get("post_recording_mode"))

    merged: Optional[str] = None
    mic_text: Optional[str] = None
    sys_text: Optional[str] = None
    asr_segments: list[dict] = []
    used_channel_split = False

    if post_mode == FAST_POST_RECORDING_MODE:
        merged = read_realtime_transcript(realtime_path)
        if clean_audio_path != audio_path:
            print("⚠️ 双轨录音使用原始双轨完整转录，跳过实时转写复用", file=sys.stderr)
            merged = None
        elif merged and not _realtime_coverage_ok(audio_path):
            print("⚠️ 实时转写覆盖不足，改走完整 daemon 转录", file=sys.stderr)
            merged = None
        elif merged:
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
        elif isinstance(response.get("channels"), dict):
            used_channel_split = True
            from stt_daemon.transcript_merge import merge_segments
            mic_payload = response["channels"].get("mic", {}) or {}
            sys_payload = response["channels"].get("sys", {}) or {}
            mic_segs = filter_obvious_hallucination_segments(mic_payload.get("segments", []) or [])
            sys_segs = filter_obvious_hallucination_segments(sys_payload.get("segments", []) or [])
            mic_segs = suppress_mic_leakage_segments(mic_segs, sys_segs)
            mic_text = transcript_text_from_segments(mic_segs, mic_payload.get("text", "") or "")
            sys_text = transcript_text_from_segments(sys_segs, sys_payload.get("text", "") or "")
            merged = merge_segments(mic=mic_segs, sys=sys_segs)
            asr_segments = [
                {**dict(s), "channel": "mic"} for s in mic_segs
            ] + [
                {**dict(s), "channel": "sys"} for s in sys_segs
            ]
        else:
            merged = strip_obvious_hallucination_text(response.get("text", "") or "")
            asr_segments = filter_obvious_hallucination_segments(
                response.get("segments", []) or []
            )

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

    # 2b. Diarization (Phase 13, opt-in). Heavy logic lives in stt_daemon.diarize_pipeline so this
    # orchestrator stays thin; on success it rewrites `.transcript.txt` labelled + writes the
    # `.speakers.json` source-of-truth + re-indexes, else degrades silently (never raises).
    from stt_daemon.diarize_pipeline import run_diarize_stage
    run_diarize_stage(
        audio_path=audio_path,
        transcript_path=transcript_path,
        asr_segments=asr_segments,
        trans_cfg=trans_cfg,
        meeting_title=meeting_title,
        channel_split_segments=used_channel_split,
    )

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


def _parse_cli(argv):
    if len(argv) < 2:
        raise ValueError("Usage: transcribe.py <audio_file_path> [--diarization-num-speakers 1..8]")
    count = None
    if len(argv) > 2:
        if len(argv) != 4 or argv[2] != "--diarization-num-speakers":
            raise ValueError("Usage: transcribe.py <audio_file_path> [--diarization-num-speakers 1..8]")
        try:
            count = int(argv[3])
        except ValueError as exc:
            raise ValueError("--diarization-num-speakers must be an integer") from exc
        if count < 1 or count > 8:
            raise ValueError("--diarization-num-speakers must be between 1 and 8")
    return argv[1], count

if __name__ == "__main__":
    try:
        audio_arg, speaker_count = _parse_cli(sys.argv)
    except ValueError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
    process_audio(audio_arg, diarization_num_speakers=speaker_count)
