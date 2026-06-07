"""RTTM I/O + the value types the metrics consume. Pure stdlib, torch-free, CI-safe.

RTTM (Rich Transcription Time Marked) is the NIST 10-field, space-separated text format that is
the lingua franca of diarization eval — both ``pyannote.metrics`` and ``spy-der`` read it, and the
spike's hand labels / sherpa output both project onto it. Making reference *and* hypothesis share
one format turns "score this" into a one-line call.

Field layout (10 columns), one turn per line::

    SPEAKER <file-id> <chan> <onset> <dur> <NA> <NA> <speaker-label> <NA> <NA>
       0         1        2      3      4    5    6         7          8    9

We read columns 1 (file id), 3 (onset), 4 (duration), 7 (speaker label); the rest are ``<NA>``.
Lines that are blank, comments (``;``/``#``), or not ``SPEAKER`` records are ignored, so a file
that interleaves multiple recordings round-trips cleanly.

This module is deliberately tiny and dependency-free so the metric tests never need pyannote.
``Turn``/``Timeline`` are the shared currency: ``metrics`` operates on ``Timeline``s, and the
constructed-corpus generator emits ``Timeline``s it writes straight to ``ref/<stem>.rttm``.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator


# A tiny epsilon so float boundary arithmetic (collar trimming, interval clipping) doesn't leave
# spurious sub-microsecond slivers that inflate "speech" totals.
_EPS = 1e-9


@dataclass(frozen=True)
class Turn:
    """A single attributed span. ``start``/``end`` are SECONDS; ``speaker`` is a label string.

    Frozen + hashable so turns can live in sets and be compared cheaply in tests.
    """

    start: float
    end: float
    speaker: str

    @property
    def duration(self) -> float:
        return max(0.0, self.end - self.start)

    def to_rttm_line(self, file_id: str) -> str:
        # Duration column (4) is a duration, not an end time — the classic RTTM foot-gun.
        return (
            f"SPEAKER {file_id} 1 {self.start:.3f} {self.duration:.3f} "
            f"<NA> <NA> {self.speaker} <NA> <NA>"
        )


class Timeline:
    """An ordered collection of ``Turn``s for one recording — the unit the metrics score.

    Not merged or normalized on construction: overlap is *preserved* (real meetings overlap, and
    the DER ``score_overlap`` toggle must be able to see it). Helpers below compute the derived
    quantities the metrics need (total speech, per-speaker support, the set of distinct speakers).
    """

    def __init__(self, turns: Iterable[Turn] = (), file_id: str = "meeting"):
        self.file_id = file_id
        self._turns: list[Turn] = sorted(
            (t for t in turns if t.end > t.start), key=lambda t: (t.start, t.end)
        )

    # — container protocol —
    def __iter__(self) -> Iterator[Turn]:
        return iter(self._turns)

    def __len__(self) -> int:
        return len(self._turns)

    def __bool__(self) -> bool:
        return bool(self._turns)

    @property
    def turns(self) -> list[Turn]:
        return list(self._turns)

    def speakers(self) -> list[str]:
        """Distinct speaker labels, sorted for determinism."""
        return sorted({t.speaker for t in self._turns})

    def num_speakers(self) -> int:
        return len(self.speakers())

    def extent(self) -> tuple[float, float]:
        """(min onset, max offset) over all turns; ``(0.0, 0.0)`` when empty."""
        if not self._turns:
            return (0.0, 0.0)
        return (self._turns[0].start, max(t.end for t in self._turns))

    def for_speaker(self, speaker: str) -> "Timeline":
        return Timeline((t for t in self._turns if t.speaker == speaker), self.file_id)

    def with_speaker_map(self, mapping: dict[str, str]) -> "Timeline":
        """Relabel speakers (used by DER's optimal mapping). Unmapped labels pass through."""
        return Timeline(
            (Turn(t.start, t.end, mapping.get(t.speaker, t.speaker)) for t in self._turns),
            self.file_id,
        )


# ── interval-set algebra (the engine under DER) ───────────────────────────────
#
# DER is computed over the *union of speech regions*, optionally per-speaker, with optional
# collar trimming around boundaries. Doing this honestly requires real interval-set ops rather
# than frame quantization (which silently biases short turns). These three functions — merge,
# subtract, total — are the whole engine, and they are exhaustively unit-tested.


def merge_intervals(intervals: Iterable[tuple[float, float]]) -> list[tuple[float, float]]:
    """Union overlapping/adjacent ``(start, end)`` intervals into a minimal disjoint list."""
    ivs = sorted((s, e) for s, e in intervals if e > s + _EPS)
    if not ivs:
        return []
    out = [ivs[0]]
    for s, e in ivs[1:]:
        ls, le = out[-1]
        if s <= le + _EPS:
            out[-1] = (ls, max(le, e))
        else:
            out.append((s, e))
    return out


def subtract_intervals(
    base: list[tuple[float, float]], cut: list[tuple[float, float]]
) -> list[tuple[float, float]]:
    """``base`` minus ``cut`` (both are disjoint, sorted lists). Used to remove the collar."""
    if not cut:
        return list(base)
    out: list[tuple[float, float]] = []
    cut = merge_intervals(cut)
    ci = 0
    for s, e in base:
        cur = s
        j = ci
        while j < len(cut) and cut[j][1] <= cur + _EPS:
            j += 1
        ci = j
        k = j
        while k < len(cut) and cut[k][0] < e - _EPS:
            cs, ce = cut[k]
            if cs > cur + _EPS:
                out.append((cur, min(cs, e)))
            cur = max(cur, ce)
            if cur >= e - _EPS:
                break
            k += 1
        if cur < e - _EPS:
            out.append((cur, e))
    return [(s, e) for s, e in out if e > s + _EPS]


def total_duration(intervals: Iterable[tuple[float, float]]) -> float:
    """Total length of a disjoint interval list (merges defensively first)."""
    return sum(e - s for s, e in merge_intervals(intervals))


def intersection_duration(
    a: list[tuple[float, float]], b: list[tuple[float, float]]
) -> float:
    """Total length of the intersection of two disjoint interval lists."""
    a = merge_intervals(a)
    b = merge_intervals(b)
    i = j = 0
    total = 0.0
    while i < len(a) and j < len(b):
        lo = max(a[i][0], b[j][0])
        hi = min(a[i][1], b[j][1])
        if hi > lo + _EPS:
            total += hi - lo
        if a[i][1] < b[j][1]:
            i += 1
        else:
            j += 1
    return total


def timeline_intervals(tl: Timeline, speaker: str | None = None) -> list[tuple[float, float]]:
    """Merged speech intervals for the whole timeline (or one speaker)."""
    src = tl.for_speaker(speaker) if speaker is not None else tl
    return merge_intervals((t.start, t.end) for t in src)


# ── file I/O ──────────────────────────────────────────────────────────────────


def parse_rttm(text: str) -> dict[str, Timeline]:
    """Parse RTTM text → ``{file_id: Timeline}``. Tolerant of blanks / comments / non-SPEAKER rows.

    Returns a dict so a single file holding several recordings round-trips. Malformed numeric
    fields raise ``ValueError`` (a corrupt label file should fail loud, not silently score wrong).
    """
    by_file: dict[str, list[Turn]] = {}
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line[0] in ";#":
            continue
        parts = line.split()
        if not parts or parts[0].upper() != "SPEAKER":
            continue
        if len(parts) < 8:
            raise ValueError(f"RTTM SPEAKER line has <8 fields: {raw!r}")
        file_id = parts[1]
        try:
            onset = float(parts[3])
            dur = float(parts[4])
        except ValueError as exc:  # noqa: TRY003 - want the offending line in the message
            raise ValueError(f"RTTM bad onset/dur in line: {raw!r}") from exc
        speaker = parts[7]
        by_file.setdefault(file_id, []).append(Turn(onset, onset + dur, speaker))
    return {fid: Timeline(turns, fid) for fid, turns in by_file.items()}


def load_rttm(path: str | Path) -> dict[str, Timeline]:
    return parse_rttm(Path(path).read_text(encoding="utf-8"))


def load_rttm_one(path: str | Path) -> Timeline:
    """Load an RTTM that contains exactly one recording; return its ``Timeline``.

    If the file holds several, the one whose id matches the file stem wins; otherwise the first.
    """
    by_file = load_rttm(path)
    if not by_file:
        return Timeline(file_id=Path(path).stem)
    stem = Path(path).stem
    if stem in by_file:
        return by_file[stem]
    return next(iter(by_file.values()))


def dump_rttm(timeline: Timeline, file_id: str | None = None) -> str:
    fid = file_id or timeline.file_id
    return "\n".join(t.to_rttm_line(fid) for t in timeline) + ("\n" if len(timeline) else "")


def write_rttm(path: str | Path, timeline: Timeline, file_id: str | None = None) -> Path:
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(dump_rttm(timeline, file_id), encoding="utf-8")
    return p
