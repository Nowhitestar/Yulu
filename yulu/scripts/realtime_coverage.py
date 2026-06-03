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

Single source of truth for BOTH paths — the meeting path (``transcribe.py``
fast_summary) and the voicemail path (``voicemail/recorder.py`` promote-to-final).
The transcription backend is one and the same; the two entry points differ only in
how the recording is tagged, so the reuse-vs-retranscribe decision must be identical.
Depends only on the standard library (no import cycles)."""

from __future__ import annotations

import json
import wave
from pathlib import Path
from typing import Optional

COVERAGE_MIN_RATIO = 0.85
COVERAGE_SLACK_SEC = 20.0


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
    return covered >= threshold
