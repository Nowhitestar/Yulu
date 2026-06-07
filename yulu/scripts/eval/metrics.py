"""Torch-free diarization metrics: DER (collar + overlap toggles), WDER, SER, speaker-count error.

Pure stdlib Python — no torch, no numpy, no pyannote. This is the load-bearing math the Phase-11
gate runs in CI; ``pyannote.metrics`` is used only as an *optional* cross-check (``harness``), never
as the sole source of truth (STACK.md: "keep a tiny hand-rolled DER in the test suite as an
independent sanity check … collar/overlap handling is where naive impls silently diverge").

Why each metric exists (PITFALLS.md §4 — "wrong collar/overlap/metric makes the eval lie"):

* **DER** — the standard, but *meaningless without its protocol*. We expose both the 0.25 s collar
  and Full (no-collar) variants, and both overlap-scored and overlap-skipped, so every number is
  reported with its four-way protocol rather than a single ambiguous figure. DER is frame/time-
  weighted, so it *under*-weights the short-utterance errors users actually feel.
* **WDER** (word diarization error rate) — the metric that maps to "wrong speaker on *these words*."
  Approximated here at the ASR-segment level (each segment ≈ a few words): the share of reference
  speech words whose attributed speaker (under the optimal mapping) is wrong. This is the product
  decision metric (PITFALLS lead with it).
* **SER** (segment/utterance error rate) — each utterance counts *once*, regardless of length, so a
  mis-attributed backchannel ("嗯", "对", "OK") is as visible as a 30-second monologue. Catches the
  short-utterance failures DER's time-weighting hides (PITFALLS §7).
* **speaker-count error** — predicted #clusters minus true #speakers. The single number that
  surfaces sherpa's known CN over-split (PITFALLS §2): a 5-person meeting rendered as 20 "speakers".

DER definition (NIST):

    DER = (false_alarm + missed_detection + speaker_confusion) / total_reference_speech

computed over the union of speech regions, optionally with a collar removed around every reference
boundary, optionally excluding regions where >1 reference speaker is active (the overlap toggle).
The hypothesis↔reference speaker labels are matched by the *optimal* 1:1 mapping that minimizes
confusion (exhaustive permutation for ≤7 speakers — Yulu meetings; greedy for larger).
"""

from __future__ import annotations

from dataclasses import dataclass
from itertools import permutations
from typing import Optional

from .rttm import (
    Timeline,
    Turn,
    intersection_duration,
    merge_intervals,
    subtract_intervals,
    timeline_intervals,
    total_duration,
)

#: Research-convention collar: 250 ms each side of every reference-turn boundary (500 ms total).
DEFAULT_COLLAR = 0.25

#: Above this speaker count, exhaustive permutation mapping (n!) is too slow → greedy fallback.
_PERM_LIMIT = 7


# ── optimal speaker mapping (hypothesis label → reference label) ──────────────


def _overlap_matrix(
    ref: Timeline, hyp: Timeline
) -> tuple[list[str], list[str], dict[tuple[str, str], float]]:
    """Co-occurrence: for each (ref speaker, hyp speaker), the total time both are active.

    This is the cost basis for the optimal mapping — we want the hyp→ref assignment that maximizes
    total co-occurring (correctly-attributed) time.
    """
    ref_spk = ref.speakers()
    hyp_spk = hyp.speakers()
    ref_iv = {r: timeline_intervals(ref, r) for r in ref_spk}
    hyp_iv = {h: timeline_intervals(hyp, h) for h in hyp_spk}
    cooc: dict[tuple[str, str], float] = {}
    for r in ref_spk:
        for h in hyp_spk:
            ov = intersection_duration(ref_iv[r], hyp_iv[h])
            if ov > 0:
                cooc[(r, h)] = ov
    return ref_spk, hyp_spk, cooc


def optimal_mapping(ref: Timeline, hyp: Timeline) -> dict[str, str]:
    """Return ``{hyp_speaker -> ref_speaker}`` maximizing total co-occurring time (optimal 1:1).

    Exhaustive over permutations for small speaker counts (the DER convention), greedy otherwise.
    Hyp speakers with no good match map to a synthetic unmatched label so they count as confusion.
    """
    ref_spk, hyp_spk, cooc = _overlap_matrix(ref, hyp)
    if not hyp_spk:
        return {}
    if not ref_spk:
        return {h: f"__unmatched_{h}" for h in hyp_spk}

    n = max(len(ref_spk), len(hyp_spk))
    if n <= _PERM_LIMIT:
        return _optimal_mapping_exhaustive(ref_spk, hyp_spk, cooc)
    return _optimal_mapping_greedy(ref_spk, hyp_spk, cooc)


def _optimal_mapping_exhaustive(ref_spk, hyp_spk, cooc) -> dict[str, str]:
    # Try every assignment of hyp speakers onto ref-speaker slots (padded with placeholders for
    # the smaller set) and keep the one with the greatest correctly-attributed time.
    slots = list(ref_spk) + [f"__unmatched_{i}" for i in range(max(0, len(hyp_spk) - len(ref_spk)))]
    best_map: dict[str, str] = {}
    best_score = -1.0
    for perm in permutations(slots, len(hyp_spk)):
        score = sum(cooc.get((perm[i], h), 0.0) for i, h in enumerate(hyp_spk))
        if score > best_score:
            best_score = score
            best_map = {h: perm[i] for i, h in enumerate(hyp_spk)}
    return best_map


def _optimal_mapping_greedy(ref_spk, hyp_spk, cooc) -> dict[str, str]:
    pairs = sorted(cooc.items(), key=lambda kv: kv[1], reverse=True)
    mapping: dict[str, str] = {}
    used_ref: set[str] = set()
    for (r, h), _ov in pairs:
        if h in mapping or r in used_ref:
            continue
        mapping[h] = r
        used_ref.add(r)
    for i, h in enumerate(hyp_spk):
        mapping.setdefault(h, f"__unmatched_{i}")
    return mapping


# ── DER ────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class DERResult:
    """A DER number *plus its protocol* (collar/overlap) and the miss/FA/confusion breakdown.

    Always carry the protocol with the number — a bare DER is meaningless (PITFALLS §4).
    """

    der: float
    missed: float            # reference speech with no (mapped) hypothesis speaker — seconds
    false_alarm: float       # hypothesis speech outside reference speech — seconds
    confusion: float         # mapped speaker disagreement — seconds
    total_reference: float   # denominator: scored reference speech — seconds
    collar: float
    score_overlap: bool

    def as_dict(self) -> dict:
        return {
            "der": round(self.der, 4),
            "missed": round(self.missed, 3),
            "false_alarm": round(self.false_alarm, 3),
            "confusion": round(self.confusion, 3),
            "total_reference": round(self.total_reference, 3),
            "collar": self.collar,
            "score_overlap": self.score_overlap,
        }


def _overlap_regions(tl: Timeline) -> list[tuple[float, float]]:
    """Regions where 2+ speakers are simultaneously active (the bits the overlap toggle removes)."""
    spk_iv = [timeline_intervals(tl, s) for s in tl.speakers()]
    overlaps: list[tuple[float, float]] = []
    for i in range(len(spk_iv)):
        for j in range(i + 1, len(spk_iv)):
            a = spk_iv[i]
            b = spk_iv[j]
            k = m = 0
            while k < len(a) and m < len(b):
                lo = max(a[k][0], b[m][0])
                hi = min(a[k][1], b[m][1])
                if hi > lo:
                    overlaps.append((lo, hi))
                if a[k][1] < b[m][1]:
                    k += 1
                else:
                    m += 1
    return merge_intervals(overlaps)


def _collar_regions(ref: Timeline, collar: float) -> list[tuple[float, float]]:
    """A ``collar``-second window centred on every reference-turn boundary (onset *and* offset)."""
    if collar <= 0:
        return []
    half = collar / 2.0
    regions = []
    for t in ref:
        regions.append((t.start - half, t.start + half))
        regions.append((t.end - half, t.end + half))
    return merge_intervals(regions)


def compute_der(
    ref: Timeline,
    hyp: Timeline,
    *,
    collar: float = DEFAULT_COLLAR,
    score_overlap: bool = True,
    mapping: Optional[dict[str, str]] = None,
) -> DERResult:
    """DER with explicit collar + overlap protocol. The four product calls are the cartesian
    product of ``collar in {0, 0.25}`` × ``score_overlap in {True, False}``.

    * ``collar`` — seconds removed around each reference boundary (0 = "Full" DER).
    * ``score_overlap`` — when False, reference-overlap regions are excluded from scoring
      (the flattering setting a never-predict-overlap system exploits — we report both).
    """
    if mapping is None:
        mapping = optimal_mapping(ref, hyp)
    hyp_mapped = hyp.with_speaker_map(mapping)

    ref_union = timeline_intervals(ref)            # all reference speech (merged)
    hyp_union = timeline_intervals(hyp_mapped)

    # Build the scored region = ref_union, minus collar, minus overlap (if skipping overlap).
    # NOTE: false alarm must also be measured only inside the scored *timeline*, so we compute a
    # "scoring mask" = (ref_union ∪ hyp_union) minus the excluded regions, then intersect.
    excluded: list[tuple[float, float]] = []
    if collar > 0:
        excluded += _collar_regions(ref, collar)
    if not score_overlap:
        excluded += _overlap_regions(ref)
    excluded = merge_intervals(excluded)

    scored_ref = subtract_intervals(ref_union, excluded)
    total_reference = total_duration(scored_ref)

    # Missed: scored reference speech not covered by any mapped hypothesis speaker.
    missed = total_duration(subtract_intervals(scored_ref, hyp_union))

    # False alarm: hypothesis speech (inside the scored window) outside reference speech.
    scoring_mask = subtract_intervals(merge_intervals(ref_union + hyp_union), excluded)
    hyp_scored = _intersect(hyp_union, scoring_mask)
    false_alarm = total_duration(subtract_intervals(hyp_scored, ref_union))

    # Confusion: per scored reference speaker, time covered by a *different* mapped hyp speaker.
    confusion = _confusion_seconds(ref, hyp_mapped, excluded)

    der = (missed + false_alarm + confusion) / total_reference if total_reference > 0 else 0.0
    return DERResult(
        der=der,
        missed=missed,
        false_alarm=false_alarm,
        confusion=confusion,
        total_reference=total_reference,
        collar=collar,
        score_overlap=score_overlap,
    )


def _intersect(a: list[tuple[float, float]], b: list[tuple[float, float]]):
    """Intersection of two disjoint interval lists, as a disjoint list."""
    a = merge_intervals(a)
    b = merge_intervals(b)
    out: list[tuple[float, float]] = []
    i = j = 0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if hi > lo:
            out.append((lo, hi))
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return out


def _confusion_seconds(
    ref: Timeline, hyp_mapped: Timeline, excluded: list[tuple[float, float]]
) -> float:
    """Time where a reference speaker is active and a *different* mapped hyp speaker covers it.

    Per reference speaker R: take R's scored intervals; subtract R's own mapped-hyp intervals;
    intersect what remains with the union of *all other* mapped-hyp speakers. That intersected
    time is confusion (R was speaking, but the hypothesis attributed it to someone else).
    """
    total = 0.0
    hyp_spk = hyp_mapped.speakers()
    hyp_iv_by = {s: timeline_intervals(hyp_mapped, s) for s in hyp_spk}
    for r in ref.speakers():
        r_scored = subtract_intervals(timeline_intervals(ref, r), excluded)
        own = hyp_iv_by.get(r, [])
        # Reference-R speech not covered by hyp-R:
        not_own = subtract_intervals(r_scored, own)
        if not not_own:
            continue
        others: list[tuple[float, float]] = []
        for s, iv in hyp_iv_by.items():
            if s != r:
                others += iv
        others = merge_intervals(others)
        total += total_duration(_intersect(not_own, others))
    return total


def der_protocol_matrix(ref: Timeline, hyp: Timeline) -> dict[str, DERResult]:
    """All four DER variants (collar × overlap) under one shared optimal mapping.

    Keys: ``collar0.25_overlap``, ``collar0.25_nooverlap``, ``full_overlap``, ``full_nooverlap``.
    The mapping is computed once (no-collar, overlap-scored basis) and reused so the four numbers
    describe the *same* hyp→ref assignment.
    """
    mapping = optimal_mapping(ref, hyp)
    return {
        "collar0.25_overlap": compute_der(
            ref, hyp, collar=DEFAULT_COLLAR, score_overlap=True, mapping=mapping
        ),
        "collar0.25_nooverlap": compute_der(
            ref, hyp, collar=DEFAULT_COLLAR, score_overlap=False, mapping=mapping
        ),
        "full_overlap": compute_der(
            ref, hyp, collar=0.0, score_overlap=True, mapping=mapping
        ),
        "full_nooverlap": compute_der(
            ref, hyp, collar=0.0, score_overlap=False, mapping=mapping
        ),
    }


# ── WDER (word/segment-level) ───────────────────────────────────────────────────


@dataclass(frozen=True)
class WDERResult:
    wder: float
    wrong: int        # words whose attributed speaker disagrees with the reference
    total: int        # reference-speech words considered
    mapping: dict[str, str]

    def as_dict(self) -> dict:
        return {"wder": round(self.wder, 4), "wrong": self.wrong, "total": self.total}


def _word_count(text: str) -> int:
    """Words in a transcript segment. Counts whitespace-split tokens (EN) plus CJK characters
    (CN has no spaces) so a Chinese utterance isn't scored as one giant 'word'."""
    if not text:
        return 0
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿")
    latin = len([w for w in text.split() if any(c.isalnum() and not _is_cjk(c) for c in w)])
    return max(1, cjk + latin)


def _is_cjk(ch: str) -> bool:
    return "一" <= ch <= "鿿" or "㐀" <= ch <= "䶿"


def _speaker_at(time: float, tl: Timeline) -> Optional[str]:
    """The speaker active at ``time`` (first match; arbitrary tie-break in overlap)."""
    for t in tl:
        if t.start <= time < t.end:
            return t.speaker
    return None


def compute_wder(
    *,
    asr_segments: list[dict],
    ref: Timeline,
    hyp: Timeline,
    mapping: Optional[dict[str, str]] = None,
) -> WDERResult:
    """Word-level diarization error over ASR segments.

    For each ASR segment we count its words (``_word_count``) and compare the *reference* speaker
    at the segment midpoint with the *mapped hypothesis* speaker at the same midpoint. Words whose
    hyp speaker disagrees with the ref speaker are "wrong." This is the metric that captures
    "wrong speaker on these words" (PITFALLS §4 — lead with WDER for the product decision).

    Segments whose midpoint has no reference speaker (silence / hallucination region) are skipped —
    they have no ground-truth owner to be wrong about (Whisper-on-silence is handled in merge, not
    scored here).
    """
    if mapping is None:
        mapping = optimal_mapping(ref, hyp)
    hyp_mapped = hyp.with_speaker_map(mapping)
    wrong = total = 0
    for seg in asr_segments:
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        mid = (start + end) / 2.0
        ref_spk = _speaker_at(mid, ref)
        if ref_spk is None:
            continue  # no ground-truth speaker here → not scorable
        words = _word_count(str(seg.get("text", "")))
        total += words
        hyp_spk = _speaker_at(mid, hyp_mapped)
        if hyp_spk != ref_spk:
            wrong += words
    wder = wrong / total if total else 0.0
    return WDERResult(wder=wder, wrong=wrong, total=total, mapping=mapping)


# ── SER (segment/utterance error rate) ──────────────────────────────────────────


@dataclass(frozen=True)
class SERResult:
    ser: float
    wrong: int
    total: int

    def as_dict(self) -> dict:
        return {"ser": round(self.ser, 4), "wrong": self.wrong, "total": self.total}


def compute_ser(
    *,
    asr_segments: list[dict],
    ref: Timeline,
    hyp: Timeline,
    mapping: Optional[dict[str, str]] = None,
) -> SERResult:
    """Utterance error rate: each ASR segment counts ONCE (length-independent), so a misattributed
    backchannel weighs as much as a monologue (PITFALLS §7 — DER's time-weighting hides these)."""
    if mapping is None:
        mapping = optimal_mapping(ref, hyp)
    hyp_mapped = hyp.with_speaker_map(mapping)
    wrong = total = 0
    for seg in asr_segments:
        start = float(seg.get("start", 0.0))
        end = float(seg.get("end", start))
        mid = (start + end) / 2.0
        ref_spk = _speaker_at(mid, ref)
        if ref_spk is None:
            continue
        total += 1
        if _speaker_at(mid, hyp_mapped) != ref_spk:
            wrong += 1
    ser = wrong / total if total else 0.0
    return SERResult(ser=ser, wrong=wrong, total=total)


# ── speaker-count error ─────────────────────────────────────────────────────────


@dataclass(frozen=True)
class CountResult:
    predicted: int
    truth: int

    @property
    def error(self) -> int:
        """Signed: positive = over-split (the sherpa-on-CN failure), negative = under-merge."""
        return self.predicted - self.truth

    @property
    def abs_error(self) -> int:
        return abs(self.predicted - self.truth)

    def as_dict(self) -> dict:
        return {
            "predicted": self.predicted,
            "truth": self.truth,
            "error": self.error,
            "abs_error": self.abs_error,
        }


def compute_count_error(ref: Timeline, hyp: Timeline) -> CountResult:
    return CountResult(predicted=hyp.num_speakers(), truth=ref.num_speakers())


# ── one-call bundle ─────────────────────────────────────────────────────────────


def evaluate(
    *,
    ref: Timeline,
    hyp: Timeline,
    asr_segments: Optional[list[dict]] = None,
) -> dict:
    """Compute the whole metric bundle for one recording under one shared optimal mapping.

    Returns a plain dict (JSON-serializable) so the harness can aggregate and the ADR can quote it.
    WDER/SER are only computed when ``asr_segments`` are supplied (they need word counts).
    """
    mapping = optimal_mapping(ref, hyp)
    der = {k: v.as_dict() for k, v in der_protocol_matrix(ref, hyp).items()}
    count = compute_count_error(ref, hyp).as_dict()
    out: dict = {"der": der, "count": count, "mapping": mapping}
    if asr_segments is not None:
        out["wder"] = compute_wder(
            asr_segments=asr_segments, ref=ref, hyp=hyp, mapping=mapping
        ).as_dict()
        out["ser"] = compute_ser(
            asr_segments=asr_segments, ref=ref, hyp=hyp, mapping=mapping
        ).as_dict()
    return out
