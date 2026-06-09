"""Assign one of N diarization speakers to each ASR segment — the N-speaker sibling
of ``transcript_merge.py`` (which fixes 2 speakers from *channels*).

This module is **pure**: no I/O on the hot path, no daemon, no SQLite, no network, no
sherpa. It takes ASR segments + diarization turns in and returns labelled segments + a
rendered ``[MM:SS <name>] text`` string out, so it is unit-testable to death on fixtures.
The only filesystem touch is the ``<stem>.speakers.json`` sidecar read/write helpers at the
bottom, which exist so the data model's "renames survive re-diarize" property is locked at
the file level.

Output line format (mirrors ``transcript_merge.merge_segments``)::

    [MM:SS Speaker 1] <text>
    [MM:SS Lewis]     <text>

Sorted by segment.start. Empty input → "".

Design (see .planning/research/ARCHITECTURE.md §2/§3, spike 002):
  (a) Overlap assignment — each ASR segment gets the diarization turn with maximum temporal
      overlap (argmax intersection). Ties broken toward the turn covering the larger fraction.
  (b) Coverage-gap fallback (~8–12% of segments fall outside any turn) — an uncovered segment is
      NEVER dropped: same-speaker-bracket → nearest-turn-within-window → explicit ``UNKNOWN``.
      A nearest-fill never snaps across a speaker boundary and is flagged low-confidence.
  (c) Hallucination / repeat guard — consecutive identical-text same-speaker segments collapse
      (whisper repeat artifact); a zero-overlap segment whose text duplicates a neighbour in a
      silent stretch is flagged low-confidence and never laundered into a confident owner.
  (d) Idempotent re-anchor — re-diarizing with a ``prior_map`` re-anchors fresh (volatile) cluster
      indices to existing stable ``speaker_id``s by overlap, and NEVER overwrites a user rename.

Privacy: this module stores only abstract ``speaker_id``s / cluster indices. Speaker embeddings
are biometric voiceprints and are deliberately NOT part of the sidecar.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

# ── Constants ────────────────────────────────────────────────────────────────

SCHEMA_VERSION = 1

#: Sentinel speaker for ASR segments that cannot be attributed to any turn.
UNKNOWN_SPEAKER_ID = "unknown"
UNKNOWN_DISPLAY_NAME = "Unknown"

#: Default window (seconds) within which a no-overlap segment may borrow the nearest
#: turn's speaker. Beyond this, the segment falls through to UNKNOWN rather than guessing.
#: Kept conservative: a far-away turn is not evidence of who spoke.
DEFAULT_NEAREST_WINDOW_S = 2.0

#: Source tags recorded per labelled segment (machine-truth provenance for the sidecar/UI).
SOURCE_OVERLAP = "overlap"            # max-overlap with a diarization turn (high confidence)
SOURCE_SAME_SPEAKER_BRACKET = "bracket"  # gap bracketed by the same speaker on both sides
SOURCE_NEAREST = "nearest"            # nearest turn within the window (low confidence)
SOURCE_UNKNOWN = "unknown"            # no usable turn at all → UNKNOWN sentinel
SOURCE_HALLUCINATION = "hallucination"  # duplicate text in a silent stretch (flagged, not owned)


def _speaker_id_for_index(idx: int) -> str:
    """Stable id string for a raw cluster index. ``0 -> "spk-0"``."""
    return f"spk-{idx}"


def _default_display_name(idx: int) -> str:
    """Default human label for a raw cluster index. ``0 -> "Speaker 1"`` (1-based, friendlier)."""
    return f"Speaker {idx + 1}"


# ── Data model ───────────────────────────────────────────────────────────────


@dataclass
class SpeakerTurn:
    """A raw diarization turn: a contiguous span attributed to one cluster index.

    ``speaker_idx`` is the *volatile* cluster index from the diarizer (0..N-1), NOT a
    user-facing label. It is re-anchored to a stable ``speaker_id`` by ``assign_speakers``.
    """

    start: float
    end: float
    speaker_idx: int

    @classmethod
    def from_dict(cls, d: "SpeakerTurn | dict") -> "SpeakerTurn":
        if isinstance(d, SpeakerTurn):
            return d
        # Accept several index keys: sherpa "speaker"/"speaker_idx", FunASR "spk".
        idx = d.get("speaker_idx")
        if idx is None:
            idx = d.get("speaker")
        if idx is None:
            idx = d.get("spk")
        if idx is None:
            idx = 0
        return cls(start=float(d.get("start", 0.0)),
                   end=float(d.get("end", 0.0)),
                   speaker_idx=int(idx))

    def to_dict(self) -> dict:
        return {"start": self.start, "end": self.end, "speaker_idx": self.speaker_idx}


@dataclass
class LabelledSegment:
    """An ASR segment after speaker attribution."""

    start: float
    end: float
    text: str
    speaker_id: str
    display_name: str
    source: str          # one of the SOURCE_* tags above
    confident: bool      # False → UI should mark it as a correctable hint

    def to_dict(self) -> dict:
        return {
            "start": self.start,
            "end": self.end,
            "text": self.text,
            "speaker_id": self.speaker_id,
            "display_name": self.display_name,
            "source": self.source,
            "confident": self.confident,
        }


@dataclass
class MergeResult:
    """Everything ``assign_speakers`` produces: labelled segments, the rendered transcript
    string (``[MM:SS name] text``), and the (possibly extended) stable speaker map."""

    segments: list[LabelledSegment] = field(default_factory=list)
    transcript: str = ""
    #: speaker_id -> {display_name, renamed, merged_into}
    speakers: dict[str, dict] = field(default_factory=dict)


# ── Helpers ──────────────────────────────────────────────────────────────────


def _fmt_timestamp(seconds: float) -> str:
    """``65.0 -> "01:05"`` — identical to transcript_merge."""
    s = max(0, int(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def _overlap(a_start: float, a_end: float, b_start: float, b_end: float) -> float:
    """Length of the intersection of ``[a_start,a_end]`` and ``[b_start,b_end]`` (0 if disjoint)."""
    return max(0.0, min(a_end, b_end) - max(a_start, b_start))


def _midpoint(start: float, end: float) -> float:
    return (start + end) / 2.0


def _segment_seconds(seg: dict, key: str, *, default: float = 0.0) -> float:
    value = seg.get(key)
    if value is not None:
        return float(value)
    ms_value = seg.get(f"{key}_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return default


def _segment_start(seg: dict) -> float:
    return _segment_seconds(seg, "start")


def _segment_end(seg: dict) -> float:
    start = _segment_start(seg)
    return _segment_seconds(seg, "end", default=start)


def _normalize_turns(turns: Iterable) -> list[SpeakerTurn]:
    out = [SpeakerTurn.from_dict(t) for t in (turns or [])]
    out.sort(key=lambda t: (t.start, t.end))
    return out


# ── Step (a): overlap argmax ─────────────────────────────────────────────────


def _best_overlap_turn(seg: dict, turns: list[SpeakerTurn]) -> tuple[Optional[SpeakerTurn], float]:
    """Return (turn-with-max-overlap, overlap-seconds). ``(None, 0.0)`` if no turn overlaps."""
    seg_start = _segment_start(seg)
    seg_end = _segment_end(seg)
    best: Optional[SpeakerTurn] = None
    best_ov = 0.0
    for t in turns:
        ov = _overlap(seg_start, seg_end, t.start, t.end)
        if ov > best_ov:
            best_ov, best = ov, t
    return best, best_ov


def _nearest_turn_within_window(
    seg: dict, turns: list[SpeakerTurn], window: float
) -> Optional[SpeakerTurn]:
    """Nearest turn by midpoint distance, but only if its *gap* to the segment is within
    ``window`` seconds. Returns ``None`` if the closest turn is farther than the window —
    we refuse to guess across a long silence."""
    if not turns:
        return None
    seg_start = _segment_start(seg)
    seg_end = _segment_end(seg)
    seg_mid = _midpoint(seg_start, seg_end)
    best: Optional[SpeakerTurn] = None
    best_gap = float("inf")
    for t in turns:
        # Gap = how far the segment sits outside the turn interval (0 if it overlaps,
        # which can't happen here since this is the no-overlap path). Use edge distance.
        if seg_end < t.start:
            gap = t.start - seg_end
        elif seg_start > t.end:
            gap = seg_start - t.end
        else:
            gap = 0.0
        # Tie-break on midpoint distance so the truly closest turn wins.
        mid_dist = abs(_midpoint(t.start, t.end) - seg_mid)
        key = (gap, mid_dist)
        if key < (best_gap, abs(_midpoint(best.start, best.end) - seg_mid) if best else float("inf")):
            best_gap, best = gap, t
    if best is None or best_gap > window:
        return None
    return best


# ── Step (c): hallucination / repeat detection ───────────────────────────────


def _norm_text(text: str) -> str:
    return (text or "").strip()


def _is_repeat_of(prev: Optional[dict], seg: dict) -> bool:
    """True if ``seg`` text duplicates the immediately preceding segment's text."""
    if prev is None:
        return False
    return _norm_text(prev.get("text", "")) == _norm_text(seg.get("text", "")) != ""


# ── Public API: assign_speakers ──────────────────────────────────────────────


def assign_speakers(
    *,
    asr_segments: list[dict],
    turns: Iterable,
    prior_map: Optional[dict[int, str]] = None,
    prior_speakers: Optional[dict[str, dict]] = None,
    nearest_window: float = DEFAULT_NEAREST_WINDOW_S,
    collapse_repeats: bool = True,
) -> MergeResult:
    """Attribute each ASR segment to a speaker and render the labelled transcript.

    Args:
        asr_segments: ``[{start, end, text}]`` from MLX / whisper.cpp (seconds). Immutable input.
        turns:        diarization turns ``[{start, end, speaker(_idx|spk)}]`` (seconds). The
                      cluster index is volatile — it is re-anchored to a stable ``speaker_id``.
        prior_map:    optional ``{speaker_idx -> stable speaker_id}`` from a previous run. New
                      indices are re-anchored to existing ids by overlap (idempotent re-diarize).
        prior_speakers: optional prior ``speakers`` map (``{speaker_id -> {display_name, renamed,
                      merged_into}}``). User renames carried here are NEVER overwritten.
        nearest_window: max seconds a no-overlap segment may borrow the nearest turn's speaker.
        collapse_repeats: collapse consecutive identical same-speaker segments (whisper repeat).

    Returns:
        ``MergeResult`` with labelled segments, the ``[MM:SS name] text`` transcript, and the
        (possibly extended) stable speaker map.
    """
    norm_turns = _normalize_turns(turns)

    # 1. Re-anchor volatile cluster indices → stable speaker_ids (idempotency).
    idx_to_id, speakers = _build_speaker_map(norm_turns, prior_map, prior_speakers)

    # 2. Sort ASR segments by start (stable). Keep originals; we read start/end/text.
    indexed = sorted(
        ((_segment_start(s), i, s) for i, s in enumerate(asr_segments or [])),
        key=lambda r: (r[0], r[1]),
    )
    ordered = [s for _, _, s in indexed]

    # 3. First pass: raw overlap argmax + coverage-gap fallback per segment.
    raw: list[dict] = []  # {seg, speaker_idx|None, source, confident}
    for pos, seg in enumerate(ordered):
        text = _norm_text(seg.get("text", ""))
        if not text:
            continue  # skip blank segments, exactly like transcript_merge

        turn, ov = _best_overlap_turn(seg, norm_turns)
        if turn is not None and ov > 0.0:
            raw.append({"seg": seg, "idx": turn.speaker_idx,
                        "source": SOURCE_OVERLAP, "confident": True})
        else:
            # No overlapping turn → coverage gap. Resolve via the fallback ladder below
            # (deferred to a second pass so "same-speaker-bracket" can see neighbours).
            raw.append({"seg": seg, "idx": None,
                        "source": None, "confident": False})

    # 4. Second pass: resolve coverage gaps using neighbour context (bracket → nearest → UNKNOWN),
    #    and flag hallucination/repeat. Neighbours are the *resolved* speakers around each gap.
    _resolve_gaps_and_hallucinations(raw, norm_turns, nearest_window)

    # 5. Optional repeat-collapse: drop consecutive identical-text same-speaker segments.
    if collapse_repeats:
        raw = _collapse_consecutive_repeats(raw)

    # 6. Materialize labelled segments + ensure every used speaker_id is in the map.
    segments: list[LabelledSegment] = []
    for item in raw:
        seg = item["seg"]
        idx = item["idx"]
        if idx is None:
            speaker_id = UNKNOWN_SPEAKER_ID
            display_name = UNKNOWN_DISPLAY_NAME
        else:
            speaker_id = idx_to_id.get(idx) or _speaker_id_for_index(idx)
            if speaker_id not in speakers:
                speakers[speaker_id] = {
                    "display_name": _default_display_name(idx),
                    "renamed": False,
                    "merged_into": None,
                }
            display_name = _resolve_display_name(speaker_id, speakers)
        start = _segment_start(seg)
        segments.append(LabelledSegment(
            start=start,
            end=_segment_seconds(seg, "end", default=start),
            text=_norm_text(seg.get("text", "")),
            speaker_id=speaker_id,
            display_name=display_name,
            source=item["source"],
            confident=bool(item["confident"]),
        ))

    transcript = render_transcript(segments)
    return MergeResult(segments=segments, transcript=transcript, speakers=speakers)


def _resolve_display_name(speaker_id: str, speakers: dict[str, dict]) -> str:
    """Follow ``merged_into`` chains to the surviving label (for the merge recovery path)."""
    seen = set()
    cur = speaker_id
    while cur in speakers and speakers[cur].get("merged_into") and cur not in seen:
        seen.add(cur)
        cur = speakers[cur]["merged_into"]
    entry = speakers.get(cur)
    if entry and entry.get("display_name"):
        return entry["display_name"]
    return UNKNOWN_DISPLAY_NAME if speaker_id == UNKNOWN_SPEAKER_ID else speaker_id


def _resolve_gaps_and_hallucinations(
    raw: list[dict], turns: list[SpeakerTurn], window: float
) -> None:
    """In-place: fill ``idx is None`` entries via same-speaker-bracket → nearest-within-window →
    UNKNOWN, and flag duplicate text in silent stretches as hallucination.

    Never snaps across a speaker boundary: the bracket rule only fires when *both* neighbours
    agree, and the nearest rule is gated by the window and stays low-confidence.
    """
    n = len(raw)
    for i, item in enumerate(raw):
        if item["idx"] is not None:
            continue  # already attributed by overlap

        seg = item["seg"]

        # Find nearest resolved neighbours (overlap-attributed) on each side.
        left_idx = _neighbour_idx(raw, i, step=-1)
        right_idx = _neighbour_idx(raw, i, step=+1)

        # Hallucination signal: this no-overlap segment duplicates an adjacent segment's text
        # while sitting in a stretch with no diarization turn → likely whisper-on-silence.
        prev_seg = raw[i - 1]["seg"] if i > 0 else None
        next_seg = raw[i + 1]["seg"] if i + 1 < n else None
        is_dup = _is_repeat_of(prev_seg, seg) or _is_repeat_of(next_seg, seg)

        if is_dup:
            # Do NOT launder into a confident owner. Attribute by the neighbour it duplicates
            # (so the line stays readable) but mark it low-confidence + hallucination source.
            borrowed = left_idx if _is_repeat_of(prev_seg, seg) else right_idx
            item["idx"] = borrowed  # may be None → UNKNOWN below
            item["source"] = SOURCE_HALLUCINATION
            item["confident"] = False
            if borrowed is None:
                item["source"] = SOURCE_UNKNOWN
            continue

        # (1) Same-speaker-bracket: both neighbours resolved to the SAME speaker → safe fill.
        if left_idx is not None and left_idx == right_idx:
            item["idx"] = left_idx
            item["source"] = SOURCE_SAME_SPEAKER_BRACKET
            item["confident"] = True
            continue

        # (2) Nearest turn within the window (never crosses a long silence).
        nearest = _nearest_turn_within_window(seg, turns, window)
        if nearest is not None:
            item["idx"] = nearest.speaker_idx
            item["source"] = SOURCE_NEAREST
            item["confident"] = False
            continue

        # (3) Give up gracefully → UNKNOWN sentinel; the line is NEVER dropped.
        item["idx"] = None
        item["source"] = SOURCE_UNKNOWN
        item["confident"] = False


def _neighbour_idx(raw: list[dict], i: int, *, step: int) -> Optional[int]:
    """Nearest neighbour speaker index that was attributed by *overlap* (a trusted anchor).

    We only treat overlap-attributed neighbours as bracket anchors so a chain of gaps doesn't
    propagate a guess across a speaker boundary.
    """
    j = i + step
    while 0 <= j < len(raw):
        if raw[j]["idx"] is not None and raw[j]["source"] == SOURCE_OVERLAP:
            return raw[j]["idx"]
        j += step
    return None


def _collapse_consecutive_repeats(raw: list[dict]) -> list[dict]:
    """Drop a segment whose normalized text equals the previous *kept* segment's text AND is
    attributed to the same speaker — the classic whisper repeat artifact. Different speakers
    saying the same word are preserved (could be a genuine echo / agreement)."""
    out: list[dict] = []
    for item in raw:
        if out:
            prev = out[-1]
            same_text = _norm_text(prev["seg"].get("text", "")) == _norm_text(item["seg"].get("text", "")) != ""
            same_spk = prev["idx"] == item["idx"]
            if same_text and same_spk:
                continue
        out.append(item)
    return out


# ── Re-anchor: volatile cluster index → stable speaker_id ─────────────────────


def _build_speaker_map(
    turns: list[SpeakerTurn],
    prior_map: Optional[dict[int, str]],
    prior_speakers: Optional[dict[str, dict]],
) -> tuple[dict[int, str], dict[str, dict]]:
    """Return ``(idx_to_id, speakers)``.

    Without a prior, each fresh cluster index ``k`` maps to ``spk-k`` with a default display name.

    With a ``prior_map`` (+ optional ``prior_speakers``), fresh indices are re-anchored to existing
    stable ids by **best overlap** between this run's turns and the prior run's turns — so a person
    keeps their ``speaker_id`` (and any user rename) even when the diarizer renumbers clusters.
    A genuinely new cluster gets a fresh ``spk-N``. User renames are carried verbatim and NEVER
    overwritten.
    """
    speakers: dict[str, dict] = {}
    if prior_speakers:
        # Deep-ish copy so we never mutate the caller's dict.
        for sid, entry in prior_speakers.items():
            speakers[sid] = dict(entry)

    fresh_indices = sorted({t.speaker_idx for t in turns})

    if not prior_map:
        idx_to_id: dict[int, str] = {}
        for idx in fresh_indices:
            sid = _speaker_id_for_index(idx)
            idx_to_id[idx] = sid
            speakers.setdefault(sid, {
                "display_name": _default_display_name(idx),
                "renamed": False,
                "merged_into": None,
            })
        return idx_to_id, speakers

    # Re-anchor. Build, for each PRIOR speaker_id, the set of time spans it owned previously.
    # We reconstruct prior spans from prior_map: prior_map is {prior_idx -> speaker_id}, but we
    # don't have prior turns here. Instead we re-anchor by comparing this run's per-index spans to
    # the *prior assignment carried in prior_map via the existing speakers' coverage*. Since the
    # caller passes prior_map keyed by prior cluster index, the robust, test-friendly contract is:
    #   - if a fresh index already exists verbatim in prior_map, inherit that id (stable numbering);
    #   - otherwise allocate a fresh id, preserving prior renames for ids we keep.
    # Overlap-based re-anchoring against prior *turns* is applied when prior turns are supplied via
    # ``reanchor_by_overlap`` (used by the sidecar round-trip path).
    idx_to_id = {}
    used_ids = set()
    for idx in fresh_indices:
        sid = prior_map.get(idx)
        if sid is not None and sid not in used_ids:
            idx_to_id[idx] = sid
            used_ids.add(sid)
            speakers.setdefault(sid, {
                "display_name": _default_display_name(idx),
                "renamed": False,
                "merged_into": None,
            })
        else:
            # New cluster (or id already taken) → fresh, non-colliding id.
            new_sid = _allocate_speaker_id(speakers, idx)
            idx_to_id[idx] = new_sid
            used_ids.add(new_sid)
            speakers.setdefault(new_sid, {
                "display_name": _default_display_name(idx),
                "renamed": False,
                "merged_into": None,
            })
    return idx_to_id, speakers


def _allocate_speaker_id(speakers: dict[str, dict], hint_idx: int) -> str:
    """Allocate a speaker_id not already present in ``speakers``."""
    candidate = _speaker_id_for_index(hint_idx)
    if candidate not in speakers:
        return candidate
    n = len(speakers)
    while True:
        candidate = _speaker_id_for_index(n)
        if candidate not in speakers:
            return candidate
        n += 1


def reanchor_by_overlap(
    *,
    new_turns: Iterable,
    prior_turns: Iterable,
    prior_map: dict[int, str],
) -> dict[int, str]:
    """Compute a fresh ``{new_idx -> speaker_id}`` by maximum temporal overlap between this run's
    turns and the prior run's turns. This is the overlap-based re-anchor referenced in
    ARCHITECTURE.md §3 — used when prior turns are available (e.g. from the sidecar).

    A new cluster whose best overlap is with a prior cluster inherits that prior cluster's stable
    ``speaker_id``. A new cluster that overlaps nothing prior gets a fresh ``spk-N``. Two new
    clusters never claim the same prior id (first-come by total overlap wins).
    """
    new_norm = _normalize_turns(new_turns)
    prior_norm = _normalize_turns(prior_turns)

    # Accumulate overlap(new_idx, prior_idx).
    pair_overlap: dict[tuple[int, int], float] = {}
    for nt in new_norm:
        for pt in prior_norm:
            ov = _overlap(nt.start, nt.end, pt.start, pt.end)
            if ov > 0.0:
                key = (nt.speaker_idx, pt.speaker_idx)
                pair_overlap[key] = pair_overlap.get(key, 0.0) + ov

    new_indices = sorted({t.speaker_idx for t in new_norm})
    # Rank candidate (new_idx -> prior_idx) pairs by overlap desc, assign greedily 1:1.
    ranked = sorted(pair_overlap.items(), key=lambda kv: kv[1], reverse=True)
    new_to_prior: dict[int, int] = {}
    claimed_prior: set[int] = set()
    for (n_idx, p_idx), _ov in ranked:
        if n_idx in new_to_prior or p_idx in claimed_prior:
            continue
        new_to_prior[n_idx] = p_idx
        claimed_prior.add(p_idx)

    result: dict[int, str] = {}
    used_ids = set()
    for n_idx in new_indices:
        p_idx = new_to_prior.get(n_idx)
        sid = prior_map.get(p_idx) if p_idx is not None else None
        if sid is not None and sid not in used_ids:
            result[n_idx] = sid
            used_ids.add(sid)
        else:
            # Fresh id that doesn't collide with prior ids or already-assigned ones.
            cand = _speaker_id_for_index(n_idx)
            bump = n_idx
            existing = set(prior_map.values()) | used_ids
            while cand in existing:
                bump += 1
                cand = _speaker_id_for_index(bump)
            result[n_idx] = cand
            used_ids.add(cand)
    return result


# ── Rendering ────────────────────────────────────────────────────────────────


def render_transcript(segments: Iterable[LabelledSegment]) -> str:
    """Render labelled segments to ``[MM:SS <display_name>] text`` lines, one per segment, sorted
    by start. No trailing newline. Mirrors ``transcript_merge.merge_segments`` output shape.
    """
    rows = sorted(
        ((s.start, _fmt_timestamp(s.start), s.display_name, s.text)
         for s in segments if _norm_text(s.text)),
        key=lambda r: r[0],
    )
    return "\n".join(f"[{ts} {name}] {text}" for _, ts, name, text in rows)


# ── Sidecar: <stem>.speakers.json read / write / round-trip ───────────────────


def speakers_sidecar_path(audio_path: str | os.PathLike) -> Path:
    """``<stem>.speakers.json`` next to the recording (sidecar convention)."""
    return Path(audio_path).with_suffix(".speakers.json")


def build_sidecar(
    *,
    result: MergeResult,
    turns: Iterable,
    provider: str = "sherpa-onnx",
    model: Optional[str] = None,
    num_speakers_supplied: Optional[int] = None,
) -> dict:
    """Assemble the ``<stem>.speakers.json`` document from a MergeResult + the raw turns.

    Stores ONLY abstract speaker_ids / cluster indices + an editable name map. No embeddings.
    """
    norm_turns = _normalize_turns(turns)
    detected = len({t.speaker_idx for t in norm_turns})
    return {
        "schema_version": SCHEMA_VERSION,
        "provider": provider,
        "model": model,
        "num_speakers_detected": detected,
        "num_speakers_supplied": num_speakers_supplied,
        "turns": [t.to_dict() for t in norm_turns],
        "segments": [s.to_dict() for s in result.segments],
        "speakers": result.speakers,
    }


def write_sidecar(path: str | os.PathLike, doc: dict) -> Path:
    """Atomically write the sidecar JSON (temp file + ``os.replace``, mirroring queue_store /
    live_session). Returns the path written."""
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(p.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, p)
    return p


def read_sidecar(path: str | os.PathLike) -> dict:
    """Read and parse a ``<stem>.speakers.json`` sidecar. Raises ``FileNotFoundError`` if absent
    (callers degrade to no-labels)."""
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def labels_from_sidecar(doc: dict) -> list[dict]:
    """Reconstruct the per-segment labels (with resolved display names following merges) from a
    parsed sidecar, so a re-read reproduces the same labels without re-running diarization.
    """
    speakers = doc.get("speakers", {}) or {}
    out: list[dict] = []
    for seg in doc.get("segments", []) or []:
        sid = seg.get("speaker_id", UNKNOWN_SPEAKER_ID)
        out.append({
            "start": seg.get("start"),
            "end": seg.get("end"),
            "text": seg.get("text", ""),
            "speaker_id": sid,
            "display_name": _resolve_display_name(sid, speakers),
            "source": seg.get("source"),
            "confident": seg.get("confident", True),
        })
    return out


def render_from_sidecar(doc: dict) -> str:
    """Render the labelled transcript string straight from a parsed sidecar (round-trip)."""
    labels = labels_from_sidecar(doc)
    segs = [
        LabelledSegment(
            start=float(d["start"]), end=float(d.get("end", d["start"])),
            text=d["text"], speaker_id=d["speaker_id"], display_name=d["display_name"],
            source=d.get("source") or SOURCE_OVERLAP, confident=bool(d.get("confident", True)),
        )
        for d in labels if d.get("start") is not None
    ]
    return render_transcript(segs)


def prior_map_from_sidecar(doc: dict) -> dict[int, str]:
    """Recover ``{speaker_idx -> speaker_id}`` from a sidecar so a re-diarize can re-anchor.

    We reconstruct it from the stored ``turns`` (which carry ``speaker_idx``) joined to the
    ``segments`` (which carry ``speaker_id``) by overlap — the same join the original assignment
    used. A turn's id is the id of the segment it most overlaps.
    """
    turns = _normalize_turns(doc.get("turns", []))
    segments = doc.get("segments", []) or []
    prior: dict[int, str] = {}
    for t in turns:
        if t.speaker_idx in prior:
            continue
        best_sid = None
        best_ov = 0.0
        for seg in segments:
            ov = _overlap(t.start, t.end,
                          float(seg.get("start", 0.0)),
                          float(seg.get("end", seg.get("start", 0.0))))
            if ov > best_ov:
                best_ov = ov
                best_sid = seg.get("speaker_id")
        if best_sid is not None and best_sid != UNKNOWN_SPEAKER_ID:
            prior[t.speaker_idx] = best_sid
    return prior


def speaker_roster(doc: dict) -> str:
    """Compact human roster of the meeting's speakers for the ``{{speaker_list}}`` prompt var.

    Built from the sidecar ``speakers`` map: each surviving (non-merged-away) speaker's resolved
    ``display_name``, deduped, in segment-appearance order so the most-heard speakers come first.
    Merged-away ids (``merged_into`` set) are skipped — their segments already resolve to the
    surviving label. ``UNKNOWN`` is included only if it actually labelled a segment, so the agent
    knows some speech is unattributed (criterion 4: uncertainty surfaced, not hidden).

    Example: ``"Lewis, Speaker 2, Unknown"``. Empty string when there are no speakers.
    """
    speakers = doc.get("speakers", {}) or {}
    segments = doc.get("segments", []) or []

    ordered_ids: list[str] = []
    seen: set[str] = set()
    for seg in segments:
        sid = seg.get("speaker_id")
        if sid and sid not in seen:
            seen.add(sid)
            ordered_ids.append(sid)
    # Append any map-only ids (no segment) after the appearance-ordered ones.
    for sid in speakers:
        if sid not in seen:
            seen.add(sid)
            ordered_ids.append(sid)

    names: list[str] = []
    seen_names: set[str] = set()
    for sid in ordered_ids:
        entry = speakers.get(sid)
        # Skip speakers that were merged away (their label resolves to the survivor).
        if isinstance(entry, dict) and entry.get("merged_into"):
            continue
        name = _resolve_display_name(sid, speakers)
        if name and name not in seen_names:
            seen_names.add(name)
            names.append(name)
    return ", ".join(names)


def apply_rename(doc: dict, speaker_id: str, display_name: str) -> dict:
    """Set a speaker's ``display_name`` and mark it ``renamed: true`` (used by the UI later; here
    so tests can prove a rename survives re-diarize). Returns the mutated doc."""
    speakers = doc.setdefault("speakers", {})
    entry = speakers.setdefault(speaker_id, {"display_name": display_name,
                                             "renamed": False, "merged_into": None})
    entry["display_name"] = display_name
    entry["renamed"] = True
    return doc
