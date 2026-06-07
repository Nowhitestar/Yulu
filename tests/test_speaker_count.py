"""Unit tests for the speaker-count strategy (COUNT-01..03) — pure logic, CI-safe (no sherpa).

Locks the Phase-12 over-split-fix invariants:

- supplied count wins over auto (COUNT-01) — config pin > calendar prior > auto;
- the calibrated threshold is selected for the no-count path, language-aware (COUNT-02);
- fail-toward-under-merge: a too-large calendar prior is clamped down, never blown up (COUNT-03);
- the two-pass reconcile decision forces the prior ONLY when auto disagrees, so a case auto already
  got right (EN) is never regressed (criterion 4).

The override-bleed cache fix in the backend is covered separately in test_diarize_backend.py.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon.speaker_count import (  # noqa: E402
    CALIBRATED_THRESHOLD,
    CN_THRESHOLD,
    MAX_AUTO_SPEAKERS,
    MIN_SPEAKERS,
    SOURCE_AUTO,
    SOURCE_AUTO_AGREED,
    SOURCE_CALENDAR,
    SOURCE_CALENDAR_CLAMPED,
    SOURCE_CONFIG,
    SpeakerCountStrategy,
    calibrated_threshold,
    reconcile_count,
    resolve_speaker_count,
)


# ════════════════════════════════════════════════════════════════════════════
# COUNT-01 — supplied count wins (config pin > calendar prior > auto)
# ════════════════════════════════════════════════════════════════════════════


def test_calendar_prior_used_as_num_clusters():
    """A calendar attendee count becomes the forced num_clusters (the free prior, COUNT-01)."""
    s = resolve_speaker_count(attendee_count=4, language="en")
    assert s.num_clusters == 4
    assert s.source == SOURCE_CALENDAR
    assert s.is_supplied is True


def test_config_pin_beats_calendar_prior():
    """An explicit operator pin (config) wins over the calendar prior."""
    s = resolve_speaker_count(attendee_count=4, config_num_speakers=2, language="zh")
    assert s.num_clusters == 2
    assert s.source == SOURCE_CONFIG


def test_no_count_falls_through_to_auto():
    """No config + no calendar prior → auto clustering (num_clusters None)."""
    s = resolve_speaker_count(attendee_count=None, language="en")
    assert s.num_clusters is None
    assert s.source == SOURCE_AUTO
    assert s.is_supplied is False


def test_calendar_prior_below_min_falls_through_to_auto():
    """A prior of 0/1 is meaningless for clustering → auto (1 speaker needs no diarization)."""
    for n in (0, 1):
        s = resolve_speaker_count(attendee_count=n, language="zh")
        assert s.num_clusters is None, f"attendee_count={n} should fall through to auto"
        assert s.source == SOURCE_AUTO


def test_min_speakers_constant_is_two():
    assert MIN_SPEAKERS == 2


# ════════════════════════════════════════════════════════════════════════════
# COUNT-02 — calibrated threshold selection, language-aware
# ════════════════════════════════════════════════════════════════════════════


def test_calibrated_threshold_default_when_no_count():
    """The auto path carries the calibrated threshold (not a hand-picked/library default)."""
    s = resolve_speaker_count(attendee_count=None, language="en")
    assert s.threshold == CALIBRATED_THRESHOLD


def test_threshold_selection_cn_vs_en():
    """CN and EN each get their calibrated threshold via the language hint (COUNT-02 seam)."""
    assert calibrated_threshold("en") == CALIBRATED_THRESHOLD
    assert calibrated_threshold("zh") == CN_THRESHOLD
    assert calibrated_threshold("zh-CN") == CN_THRESHOLD
    assert calibrated_threshold("cn") == CN_THRESHOLD
    assert calibrated_threshold(None) == CALIBRATED_THRESHOLD


def test_config_threshold_overrides_calibrated():
    """An explicit config threshold overrides the calibrated default."""
    s = resolve_speaker_count(attendee_count=None, language="en", config_threshold=0.7)
    assert s.threshold == 0.7


def test_config_threshold_ignored_when_nonpositive():
    s = resolve_speaker_count(attendee_count=None, language="en", config_threshold=0.0)
    assert s.threshold == CALIBRATED_THRESHOLD


# ════════════════════════════════════════════════════════════════════════════
# COUNT-03 — fail toward UNDER-merge (clamp a too-large prior, bias down)
# ════════════════════════════════════════════════════════════════════════════


def test_oversized_calendar_prior_is_clamped_down():
    """A 30-person invite clamps to the under-merge ceiling — never 30 phantom clusters (COUNT-03)."""
    s = resolve_speaker_count(attendee_count=30, language="zh")
    assert s.num_clusters == MAX_AUTO_SPEAKERS
    assert s.source == SOURCE_CALENDAR_CLAMPED
    assert s.attendee_count == 30  # raw prior preserved for transparency


def test_prior_at_ceiling_is_not_marked_clamped():
    s = resolve_speaker_count(attendee_count=MAX_AUTO_SPEAKERS, language="en")
    assert s.num_clusters == MAX_AUTO_SPEAKERS
    assert s.source == SOURCE_CALENDAR  # exactly at the ceiling → not clamped


def test_custom_max_speakers_ceiling():
    s = resolve_speaker_count(attendee_count=10, language="zh", max_speakers=5)
    assert s.num_clusters == 5
    assert s.source == SOURCE_CALENDAR_CLAMPED


# ════════════════════════════════════════════════════════════════════════════
# Criterion 4 — reconcile: force the prior ONLY when auto disagrees (no EN regress)
# ════════════════════════════════════════════════════════════════════════════


def test_reconcile_forces_prior_when_auto_disagrees():
    """CN case: auto under-merged to 1, prior says 3 → force 3 (the reliable CN lever)."""
    s = reconcile_count(auto_count=1, attendee_count=3, language="zh")
    assert s.num_clusters == 3
    assert s.source == SOURCE_CALENDAR


def test_reconcile_keeps_auto_when_it_agrees_with_prior():
    """EN case: auto already got 3, prior says 3 → keep auto (criterion 4: do NOT regress EN)."""
    s = reconcile_count(auto_count=3, attendee_count=3, language="en")
    assert s.num_clusters is None  # None ⇒ "keep the auto result, no second pass"
    assert s.source == SOURCE_AUTO_AGREED


def test_reconcile_keeps_auto_when_no_prior():
    """No calendar prior → nothing to reconcile against → keep auto."""
    s = reconcile_count(auto_count=5, attendee_count=None, language="zh")
    assert s.num_clusters is None
    assert s.source == SOURCE_AUTO


def test_reconcile_clamps_oversized_prior_before_comparing():
    """A huge prior is clamped to the ceiling first; auto at the ceiling then 'agrees' (under-merge bias)."""
    s = reconcile_count(auto_count=MAX_AUTO_SPEAKERS, attendee_count=30, language="zh")
    # auto == clamped ceiling → agreed, keep auto (we never push toward more speakers).
    assert s.num_clusters is None
    assert s.source == SOURCE_AUTO_AGREED


def test_reconcile_over_split_is_pulled_down_to_prior():
    """The spike's real-CN failure: auto OVER-splits (20), prior says 5 → pull down to 5."""
    s = reconcile_count(auto_count=20, attendee_count=5, language="zh")
    assert s.num_clusters == 5
    assert s.source == SOURCE_CALENDAR


def test_reconcile_tolerance_allows_off_by_one_when_set():
    """With tolerance=1, an off-by-one auto count is accepted (keeps auto) instead of forced."""
    s = reconcile_count(auto_count=4, attendee_count=5, language="zh", tolerance=1)
    assert s.num_clusters is None
    assert s.source == SOURCE_AUTO_AGREED
    # …but with the default tolerance=0 the same disagreement forces the prior.
    s0 = reconcile_count(auto_count=4, attendee_count=5, language="zh")
    assert s0.num_clusters == 5


# ════════════════════════════════════════════════════════════════════════════
# Dataclass / provenance shape
# ════════════════════════════════════════════════════════════════════════════


def test_strategy_as_dict_round_trip():
    s = resolve_speaker_count(attendee_count=3, language="zh")
    d = s.as_dict()
    assert d == {"num_clusters": 3, "threshold": CN_THRESHOLD,
                 "source": SOURCE_CALENDAR, "attendee_count": 3}


def test_strategy_is_frozen():
    s = resolve_speaker_count(attendee_count=3)
    import dataclasses
    try:
        s.num_clusters = 9  # type: ignore[misc]
        assert False, "SpeakerCountStrategy should be frozen"
    except dataclasses.FrozenInstanceError:
        pass


def test_config_pin_of_one_is_honored_as_explicit():
    """An operator who pins 1 means 'single speaker' — honored as a supplied count, not auto."""
    s = resolve_speaker_count(attendee_count=5, config_num_speakers=1)
    assert s.num_clusters == 1
    assert s.source == SOURCE_CONFIG
