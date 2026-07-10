#!/usr/bin/env python3
"""Shared realtime-transcript coverage guard.

A realtime transcript may only be reused as the FINAL transcript when it actually
covered (nearly) the whole recording. If the live tail fell behind or dropped on a
long recording, reusing its partial transcript would silently discard the rest — so
callers fall back to a full whole-file daemon transcription instead.

"Covered" = the max ended_ms the live tail reported (written to
``<stem>.realtime.coverage.json`` by realtime_transcribe.py) must be at least
``COVERAGE_MIN_RATIO`` of the WAV duration, with a small absolute slack
(``COVERAGE_SLACK_SEC``) for the trailing partial chunk + silence trim.

Single source of truth for the meeting transcription path (``transcribe.py``
fast_summary / promote-to-final). The reuse-vs-retranscribe decision must be
identical wherever the realtime transcript is promoted.
Depends only on the standard library (no import cycles)."""

from __future__ import annotations

import json
import math
import re
import wave
from pathlib import Path
from typing import Optional

COVERAGE_MIN_RATIO = 0.85
COVERAGE_SLACK_SEC = 20.0
QUALITY_CHECK_MIN_DURATION_SEC = 120.0
MIN_INFORMATION_UNITS_PER_MINUTE = 2.0
_SOURCE_TAG_RE = re.compile(r"\[(?:Me|Them)\]", re.IGNORECASE)
OBVIOUS_HALLUCINATION_RE = re.compile(
    r"请不吝点赞\s*订阅\s*转发\s*打赏支持明镜与点点栏目"
)
_EMPTY_SOURCE_LINE_RE = re.compile(r"(?mi)^\s*\[(?:Me|Them)\]\s*$")


def strip_obvious_hallucination_text(text: str) -> str:
    cleaned = OBVIOUS_HALLUCINATION_RE.sub("", text or "")
    cleaned = _EMPTY_SOURCE_LINE_RE.sub("", cleaned)
    return cleaned.strip(" \t\r\n，。,.")


def repeat_key(text: str) -> str:
    return "".join(str(text or "").lower().split())


def is_repetitive_hallucination(text: str) -> bool:
    raw = str(text or "").lower()
    key = repeat_key(raw)
    if len(key) < 16:
        return False
    counts: dict[str, int] = {}
    for char in key:
        counts[char] = counts.get(char, 0) + 1
    if counts and max(counts.values()) / len(key) >= 0.45 and len(counts) <= 10:
        return True
    for unit_size in range(1, min(24, len(key) // 4) + 1):
        repeats, remainder = divmod(len(key), unit_size)
        if remainder == 0 and repeats >= 4 and key == key[:unit_size] * repeats:
            return True
    tokens = re.findall(r"[a-z]+|[\u3040-\u30ff]+", raw)
    if len(tokens) >= 8:
        token_counts: dict[str, int] = {}
        for token in tokens:
            token_counts[token] = token_counts.get(token, 0) + 1
        if max(token_counts.values()) / len(tokens) >= 0.6:
            return True
    return False


def wav_duration_sec(wav_path: Path) -> Optional[float]:
    """Duration of a PCM WAV in seconds, or None if unreadable. Best-effort: a
    malformed/short header must never crash the reuse decision."""
    try:
        with wave.open(str(wav_path), "rb") as wf:
            rate = wf.getframerate()
            frames = wf.getnframes()
        if rate <= 0:
            return None
        return frames / float(rate)
    except (wave.Error, OSError, EOFError):
        return None


def realtime_covered_sec(wav_path: Path) -> Optional[float]:
    """Audio-seconds the live tail reported transcribing, from the coverage sidecar
    written by realtime_transcribe.py. None if absent/unreadable."""
    cov_path = wav_path.with_suffix(".realtime.coverage.json")
    if not cov_path.exists():
        return None
    try:
        data = json.loads(cov_path.read_text(encoding="utf-8"))
        covered_ms = data.get("covered_ms")
        if isinstance(covered_ms, (int, float)) and covered_ms >= 0:
            return float(covered_ms) / 1000.0
    except (ValueError, OSError):
        return None
    return None


def _realtime_transcript_quality_ok(wav_path: Path, duration: float) -> bool:
    """Reject implausibly sparse live text for a long recording.

    Coverage only proves that the live tail processed the timeline. Silence-gated
    chunks also advance it, so a 10-minute recording can otherwise be promoted
    with only one short utterance. Missing sidecars and short recordings preserve
    the previous permissive behavior.
    """
    transcript_path = wav_path.with_suffix(".realtime.transcript.txt")
    if duration < QUALITY_CHECK_MIN_DURATION_SEC or not transcript_path.exists():
        return True
    try:
        text = transcript_path.read_text(encoding="utf-8")
    except OSError:
        return True
    text = strip_obvious_hallucination_text(_SOURCE_TAG_RE.sub("", text))
    if is_repetitive_hallucination(text):
        return False
    information_units = sum(char.isalnum() for char in text)
    minimum_units = max(
        4,
        math.ceil(duration / 60.0 * MIN_INFORMATION_UNITS_PER_MINUTE),
    )
    return information_units >= minimum_units


def realtime_coverage_ok(wav_path: Path) -> bool:
    """True when a realtime transcript covered enough of the recording to be reused
    as the final. Conservative: when coverage CAN'T be measured (no WAV duration, or
    no coverage sidecar), do NOT block reuse — preserving prior behavior for short
    recordings where realtime is reliable and the sidecar may be absent."""
    duration = wav_duration_sec(wav_path)
    if duration is None or duration <= 0:
        return True
    covered = realtime_covered_sec(wav_path)
    if covered is None:
        return True
    threshold = min(duration * COVERAGE_MIN_RATIO, duration - COVERAGE_SLACK_SEC)
    return covered >= threshold and _realtime_transcript_quality_ok(wav_path, duration)
