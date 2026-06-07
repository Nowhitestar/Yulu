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
from realtime_coverage import realtime_coverage_ok as _realtime_coverage_ok

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PROMPTS_DB = Path.home() / ".config" / "yulu" / "prompts.sqlite"
AGENT_QUEUE_PATH = Path.home() / ".config" / "yulu" / "agent-queue.json"
# v0.6 diarization (Phase 13): the calendar-attendee prior is read from these two files that the
# recording pipeline already maintains — the recording state (carries the linked `meeting_id`) and
# the day's schedule (carries each meeting's `attendees`). Both are read-only here; module-level so
# tests can point them at fixtures (mirrors CONFIG_PATH / PROMPTS_DB / AGENT_QUEUE_PATH).
STATE_PATH = Path.home() / ".config" / "yulu" / ".state.json"
SCHEDULE_PATH = Path.home() / ".config" / "yulu" / "schedule.json"

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


def _load_json_file(path: Path):
    """Best-effort JSON read; returns None on any error (missing / malformed)."""
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _resolve_attendee_count(
    audio_path: Path,
    *,
    meeting_title: str = "",
    state_path: Optional[Path] = None,
    schedule_path: Optional[Path] = None,
) -> Optional[int]:
    """Resolve the calendar-attendee speaker-count prior for a recording (Phase-12 free prior).

    The attendee count was already captured into ``schedule.json`` at calendar-scan time, so this
    needs NO network / no ``gog`` call at transcribe time. Linkage strategy (first hit wins):

      1. ``meeting_id`` — read the recording state (``.state.json``) for the linked calendar event
         id and look it up in ``schedule.json`` ``meetings`` by ``id``.
      2. ``meeting_title`` — fall back to matching the recording's title against a meeting's
         ``title`` (manual / re-transcribe recordings whose state has moved on).

    Returns ``len(attendees)`` when a linked meeting carries a non-empty attendee list, else
    ``None`` (→ the strategy ladder uses auto threshold clustering). NEVER raises — any missing
    file, malformed JSON, or absent link degrades to ``None`` (no prior), which is exactly the
    graceful default Phase 12 expects.
    """
    state_path = Path(state_path) if state_path is not None else STATE_PATH
    schedule_path = Path(schedule_path) if schedule_path is not None else SCHEDULE_PATH

    schedule = _load_json_file(schedule_path)
    if not isinstance(schedule, dict):
        return None
    meetings = schedule.get("meetings")
    if not isinstance(meetings, list) or not meetings:
        return None

    def _count(meeting) -> Optional[int]:
        if not isinstance(meeting, dict):
            return None
        attendees = meeting.get("attendees")
        if isinstance(attendees, list) and attendees:
            return len(attendees)
        return None

    # (1) meeting_id from the recording state.
    state = _load_json_file(state_path)
    meeting_id = ""
    if isinstance(state, dict):
        meeting_id = str(state.get("meeting_id") or "").strip()
    if meeting_id:
        for m in meetings:
            if isinstance(m, dict) and str(m.get("id") or "") == meeting_id:
                n = _count(m)
                if n is not None:
                    return n
                break  # linked but no usable attendee list → fall through to title match

    # (2) title match (recording title derived from the stem).
    title = (meeting_title or "").strip()
    if title:
        for m in meetings:
            if isinstance(m, dict) and str(m.get("title") or "").strip() == title:
                n = _count(m)
                if n is not None:
                    return n

    return None


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


def _diarization_enabled(trans_cfg: dict) -> bool:
    """True iff ``transcription.diarization.enabled`` is set. Default OFF → today's pipeline."""
    diar = trans_cfg.get("diarization", {})
    return bool(diar.get("enabled")) if isinstance(diar, dict) else False


def _diarize_via_daemon(
    audio_path: Path, *, num_speakers, threshold, language,
) -> Optional[list]:
    """Ask the daemon to diarize → list of turn dicts, or ``None`` on ANY failure.

    Wraps :func:`transcribe_client.request_diarize`. The live runtime (Python 3.14) may not have
    sherpa installed yet (Phase 15/PORT-01), so a missing backend / missing sherpa comes back as a
    ``DaemonError`` and a dead daemon as ``DaemonUnavailable`` — BOTH are swallowed to ``None`` so
    the caller degrades to today's plain transcript. Never raises.
    """
    try:
        from transcribe_client import request_diarize, DaemonUnavailable, DaemonError
        resp = request_diarize(
            wav=str(audio_path), num_speakers=num_speakers,
            threshold=threshold, language=language,
        )
        return resp.get("turns", []) or []
    except (DaemonUnavailable, DaemonError) as exc:
        print(f"⚠️ 说话人分离不可用，使用普通转录: {exc}", file=sys.stderr)
        return None
    except Exception as exc:  # defensive: never let diarize break the pipeline
        print(f"⚠️ 说话人分离失败，使用普通转录: {exc}", file=sys.stderr)
        return None


def _run_diarize_stage(
    *,
    audio_path: Path,
    transcript_path: Path,
    asr_segments: list,
    trans_cfg: dict,
    meeting_title: str,
) -> bool:
    """ASR → diarize → speaker_merge → persist labelled transcript + ``.speakers.json`` + reindex.

    Runs ONLY when ``transcription.diarization.enabled``. Returns True when speaker labels were
    written, False when the stage degraded (and today's plain transcript is left untouched).

    Graceful degrade (criterion 1) — returns False, leaves the plain transcript, writes NO sidecar,
    NEVER raises — on any of: diarization disabled, no timestamped ASR segments, the daemon/backend
    unavailable (incl. sherpa not installed on the 3.14 runtime), or zero turns.

    Re-diarize safety (criterion 1): when a prior ``.speakers.json`` exists, its ``prior_map`` +
    raw turns re-anchor the fresh cluster indices to the existing stable ``speaker_id``s, so user
    renames carried in the sidecar survive. Source-of-truth / no-laundering (criterion 4): the
    sidecar is written verbatim from ``assign_speakers`` (which already flags low-confidence /
    UNKNOWN / hallucination segments) and the labelled ``.transcript.txt`` is the diarize output,
    NOT a cleanup rewrite — the cleanup prompt still overwrites ``.transcript.txt`` later.
    """
    if not _diarization_enabled(trans_cfg):
        return False
    if not asr_segments:
        print("⚠️ 无带时间戳的转录片段，跳过说话人分离", file=sys.stderr)
        return False

    from stt_daemon import speaker_merge as sm

    language = trans_cfg.get("language", "zh")
    diar_cfg = trans_cfg.get("diarization", {}) if isinstance(trans_cfg.get("diarization"), dict) else {}
    config_num_speakers = diar_cfg.get("num_speakers")
    config_threshold = diar_cfg.get("threshold")

    # Phase-12 count strategy: calendar-attendee prior → two-pass reconcile (auto first, then force
    # the prior ONLY when auto disagrees → no EN regression). See speaker_count.py for the recipe.
    from stt_daemon.speaker_count import resolve_speaker_count, reconcile_count
    attendee_count = _resolve_attendee_count(audio_path, meeting_title=meeting_title)
    initial = resolve_speaker_count(
        attendee_count=attendee_count, language=language,
        config_num_speakers=config_num_speakers, config_threshold=config_threshold,
    )

    if initial.source == "config":
        # Operator pin → one forced pass, done.
        turns = _diarize_via_daemon(
            audio_path, num_speakers=initial.num_clusters,
            threshold=initial.threshold, language=language)
    else:
        # Auto first, then reconcile against the calendar prior.
        turns = _diarize_via_daemon(
            audio_path, num_speakers=None, threshold=initial.threshold, language=language)
        if turns is None:
            return False  # backend unavailable → degrade
        auto_count = len({_turn_idx(t) for t in turns})
        final = reconcile_count(
            auto_count=auto_count, attendee_count=attendee_count,
            language=language, config_threshold=config_threshold)
        if final.num_clusters is not None and final.num_clusters != auto_count:
            forced = _diarize_via_daemon(
                audio_path, num_speakers=final.num_clusters,
                threshold=final.threshold, language=language)
            if forced is not None:
                turns = forced

    if turns is None:
        return False
    if not turns:
        print("⚠️ 说话人分离未返回任何分段，使用普通转录", file=sys.stderr)
        return False

    # Re-diarize: recover prior map + turns from an existing sidecar so renames survive.
    prior_map = None
    prior_speakers = None
    prior_turns = None
    sidecar_path = sm.speakers_sidecar_path(audio_path)
    if sidecar_path.exists():
        try:
            prior_doc = sm.read_sidecar(sidecar_path)
            prior_map = sm.prior_map_from_sidecar(prior_doc)
            prior_speakers = prior_doc.get("speakers") or None
            prior_turns = prior_doc.get("turns") or None
        except Exception as exc:
            print(f"⚠️ 读取既有说话人 sidecar 失败，按全新分离处理: {exc}", file=sys.stderr)
            prior_map = prior_speakers = prior_turns = None

    # When we have prior turns, re-anchor fresh cluster indices to stable ids by overlap
    # (the overlap-based re-anchor; ARCHITECTURE §3). assign_speakers also honors prior_map.
    if prior_map and prior_turns:
        try:
            prior_map = sm.reanchor_by_overlap(
                new_turns=turns, prior_turns=prior_turns, prior_map=prior_map)
        except Exception as exc:
            print(f"⚠️ 说话人重锚定失败，沿用既有映射: {exc}", file=sys.stderr)

    result = sm.assign_speakers(
        asr_segments=asr_segments, turns=turns,
        prior_map=prior_map, prior_speakers=prior_speakers,
    )
    if not result.segments:
        print("⚠️ 说话人分离未产生标注片段，使用普通转录", file=sys.stderr)
        return False

    # Persist: labelled transcript (diarize output, NOT a cleanup rewrite) + sidecar (source-of-
    # truth). The cleanup prompt may still overwrite .transcript.txt later; .speakers.json endures.
    labelled = result.transcript
    transcript_path.write_text(labelled, encoding="utf-8")
    doc = sm.build_sidecar(
        result=result, turns=turns,
        provider=str(diar_cfg.get("provider") or "sherpa-onnx"),
        num_speakers_supplied=(initial.num_clusters if initial.source == "config" else attendee_count),
    )
    sm.write_sidecar(sidecar_path, doc)
    print(f"✅ 说话人标注 transcript 已保存: {transcript_path}")
    print(f"✅ 说话人 sidecar 已保存: {sidecar_path}")

    # Re-index the labelled transcript so speaker labels are searchable.
    try:
        from search import indexer as _idx
        _idx.upsert_doc(source_path=transcript_path,
                        kind=_idx.KIND_MEETING_TRANSCRIPT, body=labelled)
    except Exception as exc:
        print(f"⚠️ search index upsert failed for {transcript_path}: {exc}", file=sys.stderr)

    return True


def _turn_idx(turn) -> int:
    """Cluster index from a turn dict (accepts ``speaker_idx`` / ``speaker`` / ``spk``)."""
    if isinstance(turn, dict):
        for k in ("speaker_idx", "speaker", "spk"):
            v = turn.get(k)
            if v is not None:
                return int(v)
        return 0
    return int(getattr(turn, "speaker_idx", 0))


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
    # Timestamped ASR segments retained for the diarize stage (Phase 13). Empty when only
    # merged text is available (realtime reuse / text-only daemon reply) → diarize is skipped
    # because the overlap merge needs per-segment timings.
    asr_segments: list[dict] = []

    if post_mode == FAST_POST_RECORDING_MODE:
        merged = read_realtime_transcript(realtime_path)
        if merged and not _realtime_coverage_ok(audio_path):
            # Truncated realtime (live tail fell behind): full daemon transcribe, not reuse.
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
            from stt_daemon.transcript_merge import merge_segments
            mic_payload = response["channels"].get("mic", {}) or {}
            sys_payload = response["channels"].get("sys", {}) or {}
            mic_text = mic_payload.get("text", "") or ""
            sys_text = sys_payload.get("text", "") or ""
            mic_segs = mic_payload.get("segments", []) or []
            sys_segs = sys_payload.get("segments", []) or []
            merged = merge_segments(mic=mic_segs, sys=sys_segs)
            # For diarization, both channels are mixed back into one timeline: the diarizer runs
            # over the whole WAV and re-splits voices by acoustics, so feed it every segment.
            asr_segments = [dict(s) for s in mic_segs] + [dict(s) for s in sys_segs]
        else:
            merged = response.get("text", "") or ""
            asr_segments = [dict(s) for s in (response.get("segments", []) or [])]

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

    # 2b. Diarization (Phase 13, opt-in). Overwrites `.transcript.txt` with the speaker-labelled
    # version + writes `.speakers.json` (source-of-truth) + re-indexes, ONLY on success. Any
    # failure (disabled, no segments, backend/sherpa unavailable, zero turns) leaves the plain
    # transcript above untouched — graceful degrade, never raises (criterion 1).
    _run_diarize_stage(
        audio_path=audio_path,
        transcript_path=transcript_path,
        asr_segments=asr_segments,
        trans_cfg=trans_cfg,
        meeting_title=meeting_title,
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


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    process_audio(sys.argv[1])
