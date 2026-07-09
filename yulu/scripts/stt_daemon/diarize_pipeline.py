"""Diarization orchestration for the post-recording pipeline (v0.6, Phase 13).

This is the heavy half of the diarize integration, factored OUT of ``transcribe.py`` so the
orchestrator stays the thin "PURE ORCHESTRATOR" the codebase mandates (spec acceptance
``test_transcribe_is_thin``; ARCHITECTURE Anti-Pattern 2). ``transcribe.py`` calls
:func:`run_diarize_stage` exactly the way it calls ``transcript_merge.merge_segments`` — one thin
call after the plain transcript is persisted.

What this module owns:
  * the calendar-attendee speaker-count prior (:func:`resolve_attendee_count`) — the Phase-12 free
    prior, read from the recording state + schedule.json the pipeline already maintains, no network;
  * the daemon DIARIZE round-trip wrapper (:func:`diarize_via_daemon`) with full graceful-degrade;
  * the end-to-end stage (:func:`run_diarize_stage`): Phase-12 two-pass count strategy → diarize →
    Phase-9 ``speaker_merge.assign_speakers`` (with re-diarize re-anchoring so renames survive) →
    persist labelled ``.transcript.txt`` + ``.speakers.json`` sidecar → search re-upsert.

Graceful degrade is the contract (criterion 1): if diarization is disabled, there are no
timestamped ASR segments, the daemon/backend is unavailable (incl. sherpa not installed on the
live Python-3.14 runtime — Phase 15/PORT-01), or zero turns come back, :func:`run_diarize_stage`
returns ``False``, leaves today's plain transcript untouched, writes NO sidecar, and never raises.

Source-of-truth / no laundering (criterion 4): the ``.speakers.json`` sidecar is written verbatim
from ``assign_speakers`` (which already flags low-confidence / UNKNOWN / hallucination segments);
the labelled ``.transcript.txt`` written here is the diarize output, NOT a cleanup rewrite — the
cleanup prompt may still overwrite ``.transcript.txt`` later via the agent queue.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Optional


# Calendar-prior source files (the recording pipeline already maintains these). Read-only here;
# module-level so tests can point them at fixtures.
STATE_PATH = Path.home() / ".config" / "yulu" / ".state.json"
SCHEDULE_PATH = Path.home() / ".config" / "yulu" / "schedule.json"
PROVIDER_SEGMENT_GAP_S = 1.25
PROVIDER_MAX_SEGMENT_SPAN_S = 15.0
PROVIDER_MAX_SEGMENT_CHARS = 160
SENTENCE_END_CHARS = "。！？!?；;\n"
NO_SPACE_BEFORE = "，。！？；：、,.!?;:%)]}）】》"
NO_SPACE_AFTER = "([{（【《"


def _load_json_file(path: Path):
    """Best-effort JSON read; returns ``None`` on any error (missing / malformed)."""
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _normalized_title(value: str) -> str:
    """Title key for calendar fallback matching: ignore spaces, punctuation, and case."""
    return "".join(ch.lower() for ch in str(value or "") if ch.isalnum())


def _attendee_names(meeting) -> list[str]:
    if not isinstance(meeting, dict):
        return []
    attendees = meeting.get("attendees")
    if not isinstance(attendees, list):
        return []

    out: list[str] = []
    seen: set[str] = set()
    for attendee in attendees:
        if isinstance(attendee, dict):
            raw = (
                attendee.get("displayName")
                or attendee.get("display_name")
                or attendee.get("name")
                or attendee.get("email")
                or ""
            )
        else:
            raw = attendee
        name = str(raw).strip()
        if name and name not in seen:
            seen.add(name)
            out.append(name)
    return out


def _resolve_attendee_meeting(
    audio_path: Path,
    *,
    meeting_title: str = "",
    state_path: Optional[Path] = None,
    schedule_path: Optional[Path] = None,
) -> Optional[dict]:
    """Resolve the linked schedule meeting that has usable attendee names.

    The attendee list was already captured into ``schedule.json`` at calendar-scan time, so this
    needs NO network / no ``gog`` call at transcribe time. Linkage strategy (first hit wins):

      1. ``meeting_id`` — read the recording state (``.state.json``) for the linked calendar event
         id and look it up in ``schedule.json`` ``meetings`` by ``id``.
      2. ``meeting_title`` — fall back to matching the recording's title against a meeting's
         ``title`` (manual / re-transcribe recordings whose state has moved on).
    """
    state_path = Path(state_path) if state_path is not None else STATE_PATH
    schedule_path = Path(schedule_path) if schedule_path is not None else SCHEDULE_PATH

    schedule = _load_json_file(schedule_path)
    if not isinstance(schedule, dict):
        return None
    meetings = schedule.get("meetings")
    if not isinstance(meetings, list) or not meetings:
        return None

    def _has_names(meeting) -> bool:
        return bool(_attendee_names(meeting))

    # (1) meeting_id from the recording state.
    state = _load_json_file(state_path)
    meeting_id = ""
    if isinstance(state, dict):
        meeting_id = str(state.get("meeting_id") or "").strip()
    if meeting_id:
        for m in meetings:
            if isinstance(m, dict) and str(m.get("id") or "") == meeting_id:
                if _has_names(m):
                    return m
                break  # linked but no usable attendee list → fall through to title match

    # (2) title match (recording title derived from the stem).
    title = (meeting_title or "").strip()
    if title:
        for m in meetings:
            if isinstance(m, dict) and str(m.get("title") or "").strip() == title:
                if _has_names(m):
                    return m
        title_key = _normalized_title(title)
        if title_key:
            for m in meetings:
                if (
                    isinstance(m, dict)
                    and _normalized_title(str(m.get("title") or "")) == title_key
                ):
                    if _has_names(m):
                        return m

    return None


def resolve_attendee_names(
    audio_path: Path,
    *,
    meeting_title: str = "",
    state_path: Optional[Path] = None,
    schedule_path: Optional[Path] = None,
) -> list[str]:
    """Resolve calendar attendee names for speaker-label hints.

    These are candidate labels, not biometric identity proof: diarization separates clusters, while
    the calendar supplies the expected roster. User renames in the sidecar remain authoritative.
    """
    meeting = _resolve_attendee_meeting(
        audio_path, meeting_title=meeting_title,
        state_path=state_path, schedule_path=schedule_path,
    )
    return _attendee_names(meeting)


def attendee_context_prompt(names: list[str]) -> str:
    cleaned: list[str] = []
    seen: set[str] = set()
    for raw in names:
        name = str(raw).strip()
        if name and name not in seen:
            seen.add(name)
            cleaned.append(name)
    return f"参会者姓名：{', '.join(cleaned)}。" if cleaned else ""


def resolve_attendee_count(
    audio_path: Path,
    *,
    meeting_title: str = "",
    state_path: Optional[Path] = None,
    schedule_path: Optional[Path] = None,
) -> Optional[int]:
    """Resolve the calendar-attendee speaker-count prior for a recording (Phase-12 free prior)."""
    names = resolve_attendee_names(
        audio_path, meeting_title=meeting_title,
        state_path=state_path, schedule_path=schedule_path,
    )
    if not names:
        return None
    # Google events often list only the invited guest, not the organizer/current user. For a
    # scheduled one-on-one, the useful diarization prior is still two speakers.
    return max(len(names), 2)


def _turn_idx(turn) -> int:
    """Cluster index from a turn dict (accepts ``speaker_idx`` / ``speaker`` / ``spk``)."""
    if isinstance(turn, dict):
        for k in ("speaker_idx", "speaker", "spk"):
            v = turn.get(k)
            if v is not None:
                return int(v)
        return 0
    return int(getattr(turn, "speaker_idx", 0))


def diarization_enabled(trans_cfg: dict) -> bool:
    """True iff ``transcription.diarization.enabled`` is set. Default OFF → today's pipeline."""
    diar = trans_cfg.get("diarization", {})
    return bool(diar.get("enabled")) if isinstance(diar, dict) else False


def diarize_via_daemon(
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


def _resolve_turns(
    audio_path: Path, *, trans_cfg: dict, meeting_title: str, language: str,
    diar_cfg: dict,
) -> Optional[list]:
    """Run the Phase-12 two-pass count strategy and return the chosen turns (or ``None``)."""
    from .speaker_count import resolve_speaker_count, reconcile_count

    config_num_speakers = diar_cfg.get("num_speakers")
    config_threshold = diar_cfg.get("threshold")
    attendee_count = resolve_attendee_count(audio_path, meeting_title=meeting_title)

    initial = resolve_speaker_count(
        attendee_count=attendee_count, language=language,
        config_num_speakers=config_num_speakers, config_threshold=config_threshold,
    )

    if initial.source == "config":
        # Operator pin → one forced pass, done.
        return diarize_via_daemon(
            audio_path, num_speakers=initial.num_clusters,
            threshold=initial.threshold, language=language)

    # Auto first, then reconcile against the calendar prior.
    turns = diarize_via_daemon(
        audio_path, num_speakers=None, threshold=initial.threshold, language=language)
    if turns is None:
        return None  # backend unavailable → degrade
    auto_count = len({_turn_idx(t) for t in turns})
    final = reconcile_count(
        auto_count=auto_count, attendee_count=attendee_count,
        language=language, config_threshold=config_threshold)
    if final.num_clusters is not None and final.num_clusters != auto_count:
        forced = diarize_via_daemon(
            audio_path, num_speakers=final.num_clusters,
            threshold=final.threshold, language=language)
        if forced is not None:
            return forced
    return turns


def _load_prior(audio_path: Path):
    """Recover ``(prior_map, prior_speakers, prior_turns)`` from an existing sidecar, or Nones."""
    from . import speaker_merge as sm

    sidecar_path = sm.speakers_sidecar_path(audio_path)
    if not sidecar_path.exists():
        return None, None, None
    try:
        prior_doc = sm.read_sidecar(sidecar_path)
        return (sm.prior_map_from_sidecar(prior_doc),
                prior_doc.get("speakers") or None,
                prior_doc.get("turns") or None)
    except Exception as exc:
        print(f"⚠️ 读取既有说话人 sidecar 失败，按全新分离处理: {exc}", file=sys.stderr)
        return None, None, None


def _segment_seconds(seg: dict, key: str, *, default: float = 0.0) -> float:
    value = seg.get(key)
    if value is not None:
        return float(value)
    ms_value = seg.get(f"{key}_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return default


def _fmt_timestamp(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def _write_channel_split_sidecar(
    *,
    audio_path: Path,
    transcript_path: Path,
    asr_segments: list,
    speaker_hints: Optional[list[str]] = None,
) -> bool:
    """Persist a two-speaker sidecar from dual-track channel labels.

    When ASR already came from L=mic / R=system channel split, those channel
    labels are a more reliable fallback than unconstrained sherpa auto
    clustering. This keeps the UI's sidecar in sync with the transcript instead
    of leaving a stale multi-speaker auto sidecar next to channel-labelled text.
    """
    from . import speaker_merge as sm

    speakers = {
        "spk-0": {"display_name": "我", "renamed": False, "merged_into": None},
        "spk-1": {"display_name": "对方", "renamed": False, "merged_into": None},
    }
    labelled: list[sm.LabelledSegment] = []
    turns: list[dict] = []
    for seg in asr_segments:
        text = (seg.get("text") or "").strip()
        channel = seg.get("channel")
        if not text or channel not in {"mic", "sys"}:
            continue
        idx = 0 if channel == "mic" else 1
        sid = f"spk-{idx}"
        start = _segment_seconds(seg, "start")
        end = _segment_seconds(seg, "end", default=start)
        name = speakers[sid]["display_name"]
        labelled.append(sm.LabelledSegment(
            start=start,
            end=end,
            text=text,
            speaker_id=sid,
            display_name=name,
            source="channel",
            confident=True,
        ))
        turns.append({"start": start, "end": end, "speaker_idx": idx})

    if not labelled:
        return False

    labelled.sort(key=lambda s: (s.start, 0 if s.speaker_id == "spk-0" else 1))
    transcript = "\n".join(
        f"[{_fmt_timestamp(seg.start)} {seg.display_name}] {seg.text}"
        for seg in labelled
    )
    transcript_path.write_text(transcript, encoding="utf-8")
    doc = sm.build_sidecar(
        result=sm.MergeResult(segments=labelled, transcript=transcript, speakers=speakers),
        turns=turns,
        provider="channel-split",
        num_speakers_supplied=None,
        speaker_hints=speaker_hints,
    )
    sm.write_sidecar(sm.speakers_sidecar_path(audio_path), doc)
    print(f"✅ 双轨通道 speaker sidecar 已保存: {sm.speakers_sidecar_path(audio_path)}")
    return True


def _provider_turns_from_segments(asr_segments: list) -> list[dict]:
    """Convert provider diarized ASR segments to speaker turns.

    This is for providers such as Hermes/Grok that return transcription and speaker labels in one
    response. It avoids routing back through Yulu's local diarization backend.
    """
    turns: list[dict] = []
    speaker_ids: dict[str, int] = {}
    for seg in asr_segments:
        if not isinstance(seg, dict):
            continue
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        raw_speaker = None
        for key in ("speaker_idx", "speaker", "spk", "speaker_label", "speaker_id"):
            value = seg.get(key)
            if value is not None and value != "":
                raw_speaker = value
                break
        if raw_speaker is None:
            continue
        try:
            speaker_idx = int(raw_speaker)
        except (TypeError, ValueError):
            speaker_idx = speaker_ids.setdefault(str(raw_speaker), len(speaker_ids))
        start = _segment_seconds(seg, "start")
        end = _segment_seconds(seg, "end", default=start)
        turns.append({"start": start, "end": end, "speaker_idx": speaker_idx})
    return turns


def _provider_speaker_key(seg: dict):
    for key in ("speaker_idx", "speaker", "spk", "speaker_label", "speaker_id"):
        value = seg.get(key)
        if value is not None and value != "":
            return str(value)
    return None


def _is_cjk(ch: str) -> bool:
    return "\u3400" <= ch <= "\u9fff" or "\uf900" <= ch <= "\ufaff"


def _join_provider_text(left: str, right: str) -> str:
    left = left.strip()
    right = right.strip()
    if not left:
        return right
    if not right:
        return left
    if left[-1] in NO_SPACE_AFTER or right[0] in NO_SPACE_BEFORE:
        return left + right
    if _is_cjk(left[-1]) or _is_cjk(right[0]):
        return left + right
    return left + " " + right


def _coalesce_provider_segments(asr_segments: list) -> list[dict]:
    """Merge provider word/char segments into readable utterance chunks."""
    # ponytail: heuristic merge; split on speaker/channel/gap/punctuation, add language-aware
    # sentence segmentation only if provider output keeps being too chunky.
    out: list[dict] = []
    current: Optional[dict] = None
    current_key = None

    indexed = sorted(
        ((_segment_seconds(s, "start"), i, s) for i, s in enumerate(asr_segments or [])
         if isinstance(s, dict) and str(s.get("text") or "").strip()),
        key=lambda r: (r[0], r[1]),
    )
    for _, _, seg in indexed:
        start = _segment_seconds(seg, "start")
        end = _segment_seconds(seg, "end", default=start)
        speaker_key = _provider_speaker_key(seg)
        key = (speaker_key, seg.get("channel"))
        text = str(seg.get("text") or "").strip()

        if current is None:
            current = dict(seg)
            current["start"] = start
            current["end"] = end
            current["text"] = text
            current_key = key
            continue

        current_start = _segment_seconds(current, "start")
        current_end = _segment_seconds(current, "end", default=current_start)
        merged_text = _join_provider_text(str(current.get("text") or ""), text)
        can_merge = (
            key == current_key
            and start - current_end <= PROVIDER_SEGMENT_GAP_S
            and not str(current.get("text") or "").rstrip().endswith(tuple(SENTENCE_END_CHARS))
            and max(end, current_end) - current_start <= PROVIDER_MAX_SEGMENT_SPAN_S
            and len(merged_text) <= PROVIDER_MAX_SEGMENT_CHARS
        )

        if can_merge:
            current["end"] = max(end, current_end)
            current["end_ms"] = int(round(float(current["end"]) * 1000))
            current["text"] = merged_text
            continue

        out.append(current)
        current = dict(seg)
        current["start"] = start
        current["end"] = end
        current["text"] = text
        current_key = key

    if current is not None:
        out.append(current)
    return out


def run_provider_speaker_stage(
    *,
    audio_path: Path,
    transcript_path: Path,
    asr_segments: list,
    meeting_title: str,
    provider: str = "provider",
) -> bool:
    """Persist speaker labels when the STT provider already returned diarized segments."""
    if not asr_segments:
        return False
    provider_segments = _coalesce_provider_segments(asr_segments)
    turns = _provider_turns_from_segments(provider_segments)
    if not turns:
        return False

    from . import speaker_merge as sm

    speaker_hints = resolve_attendee_names(audio_path, meeting_title=meeting_title)
    prior_map, prior_speakers, prior_turns = _load_prior(audio_path)
    if prior_map and prior_turns:
        try:
            prior_map = sm.reanchor_by_overlap(
                new_turns=turns, prior_turns=prior_turns, prior_map=prior_map)
        except Exception as exc:
            print(f"⚠️ provider 说话人重锚定失败，沿用既有映射: {exc}", file=sys.stderr)

    result = sm.assign_speakers(
        asr_segments=provider_segments,
        turns=turns,
        prior_map=prior_map,
        prior_speakers=prior_speakers,
        speaker_hints=speaker_hints,
    )
    if not result.segments:
        return False

    labelled = result.transcript
    transcript_path.write_text(labelled, encoding="utf-8")
    doc = sm.build_sidecar(
        result=result,
        turns=turns,
        provider=provider,
        num_speakers_supplied=None,
        speaker_hints=speaker_hints,
    )
    sm.write_sidecar(sm.speakers_sidecar_path(audio_path), doc)
    print(f"✅ provider 说话人标注 transcript 已保存: {transcript_path}")
    print(f"✅ provider 说话人 sidecar 已保存: {sm.speakers_sidecar_path(audio_path)}")

    try:
        from search import indexer as _idx
        _idx.upsert_doc(source_path=transcript_path,
                        kind=_idx.KIND_MEETING_TRANSCRIPT, body=labelled)
    except Exception as exc:
        print(f"⚠️ search index upsert failed for {transcript_path}: {exc}", file=sys.stderr)

    return True


def run_diarize_stage(
    *,
    audio_path: Path,
    transcript_path: Path,
    asr_segments: list,
    trans_cfg: dict,
    meeting_title: str,
    channel_split_segments: bool = False,
) -> bool:
    """ASR → diarize → speaker_merge → persist labelled transcript + ``.speakers.json`` + reindex.

    Runs ONLY when ``transcription.diarization.enabled``. Returns ``True`` when speaker labels were
    written, ``False`` when the stage degraded (and today's plain transcript is left untouched).
    Never raises (criterion 1). See the module docstring for the full degrade / source-of-truth /
    re-anchor contract.
    """
    if not diarization_enabled(trans_cfg):
        return False
    if not asr_segments:
        print("⚠️ 无带时间戳的转录片段，跳过说话人分离", file=sys.stderr)
        return False

    from . import speaker_merge as sm

    language = trans_cfg.get("language", "zh")
    diar_cfg = trans_cfg.get("diarization", {}) if isinstance(trans_cfg.get("diarization"), dict) else {}
    speaker_hints = resolve_attendee_names(audio_path, meeting_title=meeting_title)
    supplied = (diar_cfg.get("num_speakers")
                if diar_cfg.get("num_speakers")
                else resolve_attendee_count(audio_path, meeting_title=meeting_title))

    if channel_split_segments and supplied is None:
        print("⚠️ 双轨转写已有通道标签，缺少人数 prior，跳过自动说话人分离", file=sys.stderr)
        return _write_channel_split_sidecar(
            audio_path=audio_path,
            transcript_path=transcript_path,
            asr_segments=asr_segments,
            speaker_hints=speaker_hints,
        )

    turns = _resolve_turns(
        audio_path, trans_cfg=trans_cfg, meeting_title=meeting_title,
        language=language, diar_cfg=diar_cfg)
    if turns is None:
        return False
    if not turns:
        print("⚠️ 说话人分离未返回任何分段，使用普通转录", file=sys.stderr)
        return False

    # Re-diarize: recover prior map + turns so renames survive; re-anchor by overlap when possible.
    prior_map, prior_speakers, prior_turns = _load_prior(audio_path)
    if prior_map and prior_turns:
        try:
            prior_map = sm.reanchor_by_overlap(
                new_turns=turns, prior_turns=prior_turns, prior_map=prior_map)
        except Exception as exc:
            print(f"⚠️ 说话人重锚定失败，沿用既有映射: {exc}", file=sys.stderr)

    result = sm.assign_speakers(
        asr_segments=asr_segments, turns=turns,
        prior_map=prior_map, prior_speakers=prior_speakers,
        speaker_hints=speaker_hints,
    )
    if not result.segments:
        print("⚠️ 说话人分离未产生标注片段，使用普通转录", file=sys.stderr)
        return False

    # Persist: labelled transcript (diarize output, NOT a cleanup rewrite) + sidecar (source-of-
    # truth). attendee_count is recomputed cheaply for sidecar provenance.
    labelled = result.transcript
    transcript_path.write_text(labelled, encoding="utf-8")
    doc = sm.build_sidecar(
        result=result, turns=turns,
        provider=str(diar_cfg.get("provider") or "sherpa-onnx"),
        num_speakers_supplied=supplied,
        speaker_hints=speaker_hints,
    )
    sm.write_sidecar(sm.speakers_sidecar_path(audio_path), doc)
    print(f"✅ 说话人标注 transcript 已保存: {transcript_path}")
    print(f"✅ 说话人 sidecar 已保存: {sm.speakers_sidecar_path(audio_path)}")

    # Re-index the labelled transcript so speaker labels are searchable.
    try:
        from search import indexer as _idx
        _idx.upsert_doc(source_path=transcript_path,
                        kind=_idx.KIND_MEETING_TRANSCRIPT, body=labelled)
    except Exception as exc:
        print(f"⚠️ search index upsert failed for {transcript_path}: {exc}", file=sys.stderr)

    return True
