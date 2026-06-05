"""Phase A.2 tests: parse_stem owns the <title>_YYYYMMDD_HHMMSS regex."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search.indexer import parse_stem, StemInfo


def test_parse_stem_meeting_title():
    info = parse_stem("30minwithYuxingMasonLee_20260513_140012")
    assert info == StemInfo(
        meeting_title="30minwithYuxingMasonLee",
        recorded_at="2026-05-13T14:00:12",
    )


def test_parse_stem_memo_literal():
    info = parse_stem("Memo_20260513_140012")
    assert info is not None
    assert info.meeting_title == "Memo"
    assert info.recorded_at == "2026-05-13T14:00:12"


def test_parse_stem_title_with_underscore():
    """Titles can themselves contain underscores; the regex's non-greedy
    `.+?` plus the date+time anchor must still split correctly."""
    info = parse_stem("AgentKey_Product_Weekly_20260521_160008")
    assert info is not None
    assert info.meeting_title == "AgentKey_Product_Weekly"
    assert info.recorded_at == "2026-05-21T16:00:08"


def test_parse_stem_rejects_missing_time():
    assert parse_stem("meeting_20260513") is None


def test_parse_stem_rejects_realtime_infix():
    """`.realtime.transcript.txt` should be skipped — the stem regex must
    not accidentally match the bare stem either; but more importantly,
    callers strip suffixes before calling. Here we verify the regex
    rejects a stem that carries `realtime` instead of a digit block."""
    assert parse_stem("meeting_20260513_realtime") is None


def test_parse_stem_rejects_plain_filename():
    assert parse_stem("notes") is None
    assert parse_stem("anything-without-pattern") is None


def test_parse_stem_rejects_impossible_date():
    # Regex matches digits but the date is invalid → None.
    assert parse_stem("meeting_20260230_140000") is None  # Feb 30
    assert parse_stem("meeting_20260513_250000") is None  # 25h


def test_parse_stem_handles_six_digit_zero_padded():
    info = parse_stem("Memo_20260513_000000")
    assert info is not None
    assert info.recorded_at == "2026-05-13T00:00:00"


def test_stem_info_is_frozen():
    """Dataclass is frozen so it can be hashed / put in sets."""
    a = parse_stem("Memo_20260513_140012")
    b = parse_stem("Memo_20260513_140012")
    assert {a, b} == {a}
