"""Merge per-channel Whisper segments into a speaker-tagged transcript.

Output format (one line per segment):
    [MM:SS 我]   <text>
    [MM:SS 对方] <text>
Sorted by segment.start; same start → mic first.
"""

from __future__ import annotations

from typing import Iterable

SPEAKER_MIC = "我"
SPEAKER_SYS = "对方"


def _fmt_timestamp(seconds: float) -> str:
    s = max(0, int(seconds))
    return f"{s // 60:02d}:{s % 60:02d}"


def _tag(segments: Iterable[dict], speaker: str, channel_priority: int) -> list[tuple]:
    out: list[tuple] = []
    for seg in segments or []:
        text = (seg.get("text") or "").strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        out.append((start, channel_priority, _fmt_timestamp(start), speaker, text))
    return out


def merge_segments(*, mic: list[dict], sys: list[dict]) -> str:
    """Return a single speaker-tagged transcript string, no trailing newline."""
    tagged = _tag(mic, SPEAKER_MIC, channel_priority=0) + _tag(sys, SPEAKER_SYS, channel_priority=1)
    tagged.sort(key=lambda r: (r[0], r[1]))
    lines = [f"[{ts} {speaker}] {text}" for _, _, ts, speaker, text in tagged]
    return "\n".join(lines)
