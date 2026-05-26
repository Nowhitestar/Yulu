"""Unit tests for transcript_merge: speaker-tagged ordered merge."""

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.transcript_merge import merge_segments, SPEAKER_MIC, SPEAKER_SYS


def test_merge_two_channels_non_overlapping():
    mic = [{"start": 5.0, "end": 6.0, "text": "你好"}]
    sys_ = [{"start": 8.0, "end": 9.0, "text": "hello"}]
    out = merge_segments(mic=mic, sys=sys_)
    assert out == (
        f"[00:05 {SPEAKER_MIC}] 你好\n"
        f"[00:08 {SPEAKER_SYS}] hello"
    )


def test_merge_two_channels_overlapping_sorts_by_start():
    mic = [{"start": 1.0, "end": 2.0, "text": "A"}, {"start": 5.0, "end": 6.0, "text": "C"}]
    sys_ = [{"start": 3.0, "end": 4.0, "text": "B"}]
    out = merge_segments(mic=mic, sys=sys_)
    lines = out.splitlines()
    assert lines == [
        f"[00:01 {SPEAKER_MIC}] A",
        f"[00:03 {SPEAKER_SYS}] B",
        f"[00:05 {SPEAKER_MIC}] C",
    ]


def test_merge_same_start_mic_wins():
    mic = [{"start": 10.0, "end": 11.0, "text": "M"}]
    sys_ = [{"start": 10.0, "end": 11.0, "text": "S"}]
    out = merge_segments(mic=mic, sys=sys_)
    lines = out.splitlines()
    assert lines[0].endswith("M"), lines
    assert lines[1].endswith("S"), lines


def test_merge_empty_sys_returns_only_mic():
    mic = [{"start": 0.5, "end": 1.0, "text": "hi"}]
    sys_ = []
    out = merge_segments(mic=mic, sys=sys_)
    assert out == f"[00:00 {SPEAKER_MIC}] hi"


def test_merge_empty_both_returns_empty_string():
    assert merge_segments(mic=[], sys=[]) == ""


def test_merge_formats_minutes_and_seconds():
    mic = [{"start": 125.0, "end": 126.0, "text": "two minutes in"}]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[02:05 {SPEAKER_MIC}] two minutes in"


def test_merge_strips_whitespace_in_segment_text():
    mic = [{"start": 0.0, "end": 1.0, "text": "  hello  "}]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[00:00 {SPEAKER_MIC}] hello"


def test_merge_skips_blank_segments():
    mic = [
        {"start": 0.0, "end": 1.0, "text": "  "},
        {"start": 2.0, "end": 3.0, "text": "real"},
    ]
    out = merge_segments(mic=mic, sys=[])
    assert out == f"[00:02 {SPEAKER_MIC}] real"
