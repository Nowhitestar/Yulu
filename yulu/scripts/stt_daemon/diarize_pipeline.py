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


def _load_json_file(path: Path):
    """Best-effort JSON read; returns ``None`` on any error (missing / malformed)."""
    try:
        if not path.exists():
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def resolve_attendee_count(
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


def run_diarize_stage(
    *,
    audio_path: Path,
    transcript_path: Path,
    asr_segments: list,
    trans_cfg: dict,
    meeting_title: str,
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
    )
    if not result.segments:
        print("⚠️ 说话人分离未产生标注片段，使用普通转录", file=sys.stderr)
        return False

    # Persist: labelled transcript (diarize output, NOT a cleanup rewrite) + sidecar (source-of-
    # truth). attendee_count is recomputed cheaply for sidecar provenance.
    labelled = result.transcript
    transcript_path.write_text(labelled, encoding="utf-8")
    supplied = (diar_cfg.get("num_speakers")
                if diar_cfg.get("num_speakers")
                else resolve_attendee_count(audio_path, meeting_title=meeting_title))
    doc = sm.build_sidecar(
        result=result, turns=turns,
        provider=str(diar_cfg.get("provider") or "sherpa-onnx"),
        num_speakers_supplied=supplied,
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
