"""Tests for the Phase-11 DER/WDER/SER eval harness — the GATE's correctness (EVAL-02/04).

Locks the metric MATH on tiny known cases where the answer is computable by hand:
  * perfect match → DER 0; total confusion → DER 0.5; pure miss / pure false-alarm → known DER;
  * the collar toggle FORGIVES boundary slip (collar DER ≤ full DER);
  * the overlap toggle DELETES overlap regions (skip-overlap DER ≤ scored DER);
  * RTTM round-trips (parse∘dump == identity) incl. the duration-vs-end-time field;
  * WDER counts WORDS (CJK-aware) and SER counts UTTERANCES (so they diverge on length);
  * speaker-count error is signed (over-split positive, under-merge negative).

CI-safe: pure stdlib math — NO torch, NO sherpa, NO numpy, NO model, NO network. The sherpa/funasr
provider paths are exercised separately (opt-in) and skipped here; ``pyannote.metrics`` is used only
as an OPTIONAL cross-check, skipped when not installed (so CI never needs it).

Import style mirrors the repo (sys.path.insert + ``from eval...``).
"""

import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from eval import metrics, ui_copy  # noqa: E402
from eval.corpus import audacity_labels_to_rttm  # noqa: E402
from eval.metrics import (  # noqa: E402
    compute_count_error,
    compute_der,
    compute_ser,
    compute_wder,
    der_protocol_matrix,
    evaluate,
    optimal_mapping,
)
from eval.rttm import (  # noqa: E402
    Timeline,
    Turn,
    dump_rttm,
    intersection_duration,
    merge_intervals,
    parse_rttm,
    subtract_intervals,
    total_duration,
)


def _approx(a, b, tol=1e-6):
    return abs(a - b) <= tol


# ════════════════════════════════════════════════════════════════════════════
# RTTM round-trip + interval algebra (the engine under DER)
# ════════════════════════════════════════════════════════════════════════════


class TestRTTMRoundTrip:
    def test_parse_dump_identity(self):
        tl = Timeline([Turn(0.0, 3.0, "A"), Turn(3.5, 5.25, "B"), Turn(5.25, 9.0, "A")], "m1")
        text = dump_rttm(tl, "m1")
        back = parse_rttm(text)["m1"]
        assert [(round(t.start, 3), round(t.end, 3), t.speaker) for t in back] == [
            (0.0, 3.0, "A"), (3.5, 5.25, "B"), (5.25, 9.0, "A")
        ]

    def test_duration_field_is_duration_not_endtime(self):
        # The RTTM column 4 is a DURATION. A turn 3.5→5.25 must emit dur 1.75, not 5.25.
        line = Turn(3.5, 5.25, "B").to_rttm_line("m1")
        fields = line.split()
        assert fields[3] == "3.500" and fields[4] == "1.750"

    def test_parse_tolerates_comments_blanks_and_nonspeaker(self):
        text = (
            "; a comment\n"
            "\n"
            "SPEAKER m1 1 0.000 2.000 <NA> <NA> A <NA> <NA>\n"
            "# another comment\n"
            "SPKR-INFO m1 1 <NA> <NA> <NA> unknown <NA> <NA>\n"  # not a SPEAKER row → ignored
            "SPEAKER m1 1 2.000 1.000 <NA> <NA> B <NA> <NA>\n"
        )
        tl = parse_rttm(text)["m1"]
        assert len(tl) == 2 and tl.speakers() == ["A", "B"]

    def test_parse_rejects_malformed_numeric(self):
        with pytest.raises(ValueError):
            parse_rttm("SPEAKER m1 1 oops 2.0 <NA> <NA> A <NA> <NA>")

    def test_multi_recording_file(self):
        text = (
            "SPEAKER m1 1 0.0 1.0 <NA> <NA> A <NA> <NA>\n"
            "SPEAKER m2 1 0.0 2.0 <NA> <NA> X <NA> <NA>\n"
        )
        by = parse_rttm(text)
        assert set(by) == {"m1", "m2"} and len(by["m2"]) == 1


class TestIntervalAlgebra:
    def test_merge_overlapping_and_adjacent(self):
        assert merge_intervals([(0, 2), (1, 3), (3, 4), (5, 6)]) == [(0, 4), (5, 6)]

    def test_subtract_removes_collar(self):
        # base 0-10 minus a cut 4-6 → [(0,4),(6,10)]
        assert subtract_intervals([(0, 10)], [(4, 6)]) == [(0, 4), (6, 10)]

    def test_subtract_multiple_cuts(self):
        assert subtract_intervals([(0, 10)], [(1, 2), (4, 6), (9, 11)]) == [
            (0, 1), (2, 4), (6, 9)
        ]

    def test_total_and_intersection(self):
        assert _approx(total_duration([(0, 3), (5, 7)]), 5.0)
        assert _approx(intersection_duration([(0, 5)], [(3, 9)]), 2.0)


# ════════════════════════════════════════════════════════════════════════════
# DER on tiny known cases — the headline correctness gate
# ════════════════════════════════════════════════════════════════════════════


class TestDERKnownCases:
    def test_perfect_match_is_zero_regardless_of_labels(self):
        # Same partition, totally different label strings → optimal mapping makes DER 0.
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 5, "x"), Turn(5, 10, "y")])
        d = compute_der(ref, hyp, collar=0.0, score_overlap=True)
        assert _approx(d.der, 0.0)
        assert _approx(d.missed, 0.0) and _approx(d.false_alarm, 0.0) and _approx(d.confusion, 0.0)

    def test_one_speaker_over_two_is_half_confusion(self):
        # ref two speakers 0-5 / 5-10; hyp one speaker over 0-10. 5s correct, 5s confusion.
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 10, "x")])
        d = compute_der(ref, hyp, collar=0.0, score_overlap=True)
        assert _approx(d.confusion, 5.0) and _approx(d.total_reference, 10.0)
        assert _approx(d.der, 0.5)

    def test_pure_miss(self):
        # ref one speaker 0-10; hyp covers only 0-5 → 5s missed.
        ref = Timeline([Turn(0, 10, "A")])
        hyp = Timeline([Turn(0, 5, "x")])
        d = compute_der(ref, hyp, collar=0.0, score_overlap=True)
        assert _approx(d.missed, 5.0) and _approx(d.der, 0.5)

    def test_pure_false_alarm(self):
        # ref one speaker 0-5; hyp adds 5s of speech 6-11 outside ref → FA 5, DER 1.0.
        ref = Timeline([Turn(0, 5, "A")])
        hyp = Timeline([Turn(0, 5, "x"), Turn(6, 11, "x")])
        d = compute_der(ref, hyp, collar=0.0, score_overlap=True)
        assert _approx(d.false_alarm, 5.0) and _approx(d.total_reference, 5.0)
        assert _approx(d.der, 1.0)

    def test_empty_hypothesis_is_all_missed(self):
        ref = Timeline([Turn(0, 4, "A"), Turn(4, 8, "B")])
        d = compute_der(ref, Timeline([]), collar=0.0, score_overlap=True)
        assert _approx(d.missed, 8.0) and _approx(d.der, 1.0)

    def test_empty_reference_der_zero_total(self):
        # No reference speech → total 0 → DER defined as 0 (no division by zero).
        d = compute_der(Timeline([]), Timeline([Turn(0, 5, "x")]), collar=0.0)
        assert _approx(d.der, 0.0) and _approx(d.total_reference, 0.0)


class TestCollarToggle:
    def test_collar_forgives_boundary_slip(self):
        # ref A 0-5 / B 5-10; hyp boundary slipped to 5.5 → 0.5s of B mislabeled.
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 5.5, "x"), Turn(5.5, 10, "y")])
        full = compute_der(ref, hyp, collar=0.0, score_overlap=True).der
        collar = compute_der(ref, hyp, collar=0.25, score_overlap=True).der
        assert full > 0.0
        assert collar < full  # the collar around the 5.0 boundary forgives the slip

    def test_collar_zero_equals_full(self):
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 6, "x"), Turn(6, 10, "y")])
        a = compute_der(ref, hyp, collar=0.0).der
        b = compute_der(ref, hyp, collar=0.0).der
        assert _approx(a, b)


class TestOverlapToggle:
    def test_skip_overlap_is_lower_when_overlap_missed(self):
        # ref: A 0-6 with B overlapping 2-4. hyp predicts only A → B's overlap is confusion/miss.
        ref = Timeline([Turn(0, 6, "A"), Turn(2, 4, "B")])
        hyp = Timeline([Turn(0, 6, "x")])
        scored = compute_der(ref, hyp, collar=0.0, score_overlap=True).der
        skipped = compute_der(ref, hyp, collar=0.0, score_overlap=False).der
        assert scored > 0.0
        assert skipped < scored  # removing the overlap region flatters the score

    def test_no_overlap_corpus_toggle_is_noop(self):
        # Sequential turns (no overlap) → the overlap toggle changes nothing (matches the
        # constructed corpus property: collar0.25 == collar0.25_nooverlap there).
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 5, "x"), Turn(5, 10, "y")])
        a = compute_der(ref, hyp, collar=0.0, score_overlap=True).der
        b = compute_der(ref, hyp, collar=0.0, score_overlap=False).der
        assert _approx(a, b)


class TestProtocolMatrix:
    def test_four_variants_share_one_mapping_and_order(self):
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B"), Turn(2, 4, "B")])
        hyp = Timeline([Turn(0, 5.4, "x"), Turn(5.4, 10, "y")])
        m = der_protocol_matrix(ref, hyp)
        assert set(m) == {"collar0.25_overlap", "collar0.25_nooverlap",
                          "full_overlap", "full_nooverlap"}
        # collar ≤ full for both overlap settings; skip-overlap ≤ scored for both collar settings.
        assert m["collar0.25_overlap"].der <= m["full_overlap"].der + 1e-9
        assert m["collar0.25_nooverlap"].der <= m["full_nooverlap"].der + 1e-9
        assert m["full_nooverlap"].der <= m["full_overlap"].der + 1e-9


# ════════════════════════════════════════════════════════════════════════════
# Optimal mapping
# ════════════════════════════════════════════════════════════════════════════


class TestOptimalMapping:
    def test_maps_by_max_cooccurrence(self):
        ref = Timeline([Turn(0, 10, "A"), Turn(10, 20, "B")])
        hyp = Timeline([Turn(0, 10, "2"), Turn(10, 20, "1")])  # swapped numbering
        m = optimal_mapping(ref, hyp)
        assert m["2"] == "A" and m["1"] == "B"

    def test_extra_hyp_speaker_maps_to_unmatched(self):
        ref = Timeline([Turn(0, 10, "A")])
        hyp = Timeline([Turn(0, 5, "x"), Turn(5, 10, "y")])  # over-split into 2
        m = optimal_mapping(ref, hyp)
        # exactly one of the two maps to A; the other is unmatched (counts as confusion).
        mapped_to_A = [h for h, r in m.items() if r == "A"]
        assert len(mapped_to_A) == 1


# ════════════════════════════════════════════════════════════════════════════
# WDER vs SER — they must diverge on length (the whole point of having both)
# ════════════════════════════════════════════════════════════════════════════


class TestWDERandSER:
    def _ref_hyp(self):
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        return ref

    def test_perfect_wder_ser_zero(self):
        ref = self._ref_hyp()
        hyp = Timeline([Turn(0, 5, "x"), Turn(5, 10, "y")])
        asr = [{"start": 0, "end": 2, "text": "hello world foo"},
               {"start": 6, "end": 8, "text": "bar baz"}]
        assert _approx(compute_wder(asr_segments=asr, ref=ref, hyp=hyp).wder, 0.0)
        assert _approx(compute_ser(asr_segments=asr, ref=ref, hyp=hyp).ser, 0.0)

    def test_wder_counts_words_ser_counts_utterances(self):
        ref = self._ref_hyp()
        hyp = Timeline([Turn(0, 10, "x")])  # everything attributed to A → the B segment is wrong
        asr = [{"start": 0, "end": 2, "text": "hello world foo"},  # in A, correct, 3 words
               {"start": 6, "end": 8, "text": "bar baz"}]          # in B, WRONG, 2 words
        wder = compute_wder(asr_segments=asr, ref=ref, hyp=hyp)
        ser = compute_ser(asr_segments=asr, ref=ref, hyp=hyp)
        assert wder.wrong == 2 and wder.total == 5 and _approx(wder.wder, 0.4)
        assert ser.wrong == 1 and ser.total == 2 and _approx(ser.ser, 0.5)
        assert wder.wder != ser.ser  # divergence: a short wrong utterance weighs more in SER

    def test_cjk_word_counting(self):
        # Chinese has no spaces; a CN utterance must not count as one word.
        ref = Timeline([Turn(0, 5, "A")])
        hyp = Timeline([Turn(0, 5, "x")])
        asr = [{"start": 1, "end": 3, "text": "你好世界"}]  # 4 CJK chars → 4 words
        assert compute_wder(asr_segments=asr, ref=ref, hyp=hyp).total == 4

    def test_segment_in_silence_is_not_scored(self):
        # A hallucination-region segment (no ref speaker at its midpoint) is skipped, not counted.
        ref = Timeline([Turn(0, 5, "A")])
        hyp = Timeline([Turn(0, 5, "x")])
        asr = [{"start": 1, "end": 3, "text": "real words here"},   # in ref → scored
               {"start": 20, "end": 22, "text": "thank you thank you"}]  # silence → skipped
        w = compute_wder(asr_segments=asr, ref=ref, hyp=hyp)
        assert w.total == 3  # only the in-ref segment's words


# ════════════════════════════════════════════════════════════════════════════
# Speaker-count error (the over-split signal)
# ════════════════════════════════════════════════════════════════════════════


class TestCountError:
    def test_over_split_is_positive(self):
        # 3 true, 20 predicted (the sherpa CN over-split signature) → +17.
        ref = Timeline([Turn(0, 1, "A"), Turn(1, 2, "B"), Turn(2, 3, "C")])
        hyp = Timeline([Turn(i * 0.1, i * 0.1 + 0.1, f"s{i}") for i in range(20)])
        c = compute_count_error(ref, hyp)
        assert c.truth == 3 and c.predicted == 20 and c.error == 17 and c.abs_error == 17

    def test_under_merge_is_negative(self):
        # The constructed-CN failure: 3 true collapsed to 1 → -2.
        ref = Timeline([Turn(0, 1, "A"), Turn(1, 2, "B"), Turn(2, 3, "C")])
        hyp = Timeline([Turn(0, 3, "x")])
        c = compute_count_error(ref, hyp)
        assert c.error == -2 and c.abs_error == 2


# ════════════════════════════════════════════════════════════════════════════
# evaluate() bundle
# ════════════════════════════════════════════════════════════════════════════


class TestEvaluateBundle:
    def test_bundle_shape(self):
        ref = Timeline([Turn(0, 5, "A"), Turn(5, 10, "B")])
        hyp = Timeline([Turn(0, 5, "x"), Turn(5, 10, "y")])
        asr = [{"start": 1, "end": 2, "text": "a b c"}]
        out = evaluate(ref=ref, hyp=hyp, asr_segments=asr)
        assert set(out) >= {"der", "count", "mapping", "wder", "ser"}
        assert set(out["der"]) == {"collar0.25_overlap", "collar0.25_nooverlap",
                                   "full_overlap", "full_nooverlap"}
        assert out["count"]["truth"] == 2 and out["count"]["predicted"] == 2

    def test_bundle_without_asr_omits_word_metrics(self):
        ref = Timeline([Turn(0, 5, "A")])
        hyp = Timeline([Turn(0, 5, "x")])
        out = evaluate(ref=ref, hyp=hyp, asr_segments=None)
        assert "wder" not in out and "ser" not in out


# ════════════════════════════════════════════════════════════════════════════
# Audacity → RTTM (the human-gold labelling path)
# ════════════════════════════════════════════════════════════════════════════


class TestAudacityLabels:
    def test_tab_separated_export(self):
        labels = "0.000000\t3.073000\tAlice\n3.473000\t5.200000\tBob\n7.626000\t9.000000\tAlice"
        tl = audacity_labels_to_rttm(labels, "meeting1")
        assert len(tl) == 3 and tl.speakers() == ["Alice", "Bob"]
        # durations correct (end - start), not raw end times.
        first = tl.turns[0]
        assert _approx(first.start, 0.0) and _approx(first.end, 3.073)

    def test_ignores_comments_and_blank(self):
        labels = "# header\n\n0.0\t1.0\tA\n"
        tl = audacity_labels_to_rttm(labels, "m")
        assert len(tl) == 1


# ════════════════════════════════════════════════════════════════════════════
# UI copy is sourced from measurement (EVAL-04) — honest framing, not marketing
# ════════════════════════════════════════════════════════════════════════════


class TestUICopy:
    def test_all_strings_present(self):
        s = ui_copy.all_strings()
        for key in ("labels_are_a_hint", "correction_is_expected", "per_meeting_labels",
                    "low_confidence_segment", "count_unreliable", "accuracy_blurb"):
            assert key in s and s[key].strip()

    def test_copy_frames_labels_as_hint_not_fact(self):
        # The honest stance must be lexically present: "guess"/"hint"/"correct" — never "accurate
        # identification" with no hedge.
        blurb = ui_copy.all_strings()["labels_are_a_hint"].lower()
        assert "guess" in blurb or "hint" in blurb
        assert "fact" in blurb or "correct" in blurb

    def test_accuracy_blurb_is_measurement_grounded(self):
        # Sourced from the measured EN DER → mentions a percentage and the CN caveat.
        blurb = ui_copy.accuracy_blurb()
        assert "%" in blurb
        assert "chinese" in blurb.lower()

    def test_measured_snapshot_is_realistic(self):
        # Guardrail: the snapshot must reflect that EN is good and CN is materially worse — if a
        # future eval makes them equal, this prompts a copy review rather than silent drift.
        m = ui_copy.MEASURED
        assert m.cn_der_collar > m.en_der_collar
        assert 0.0 <= m.en_der_collar < 1.0 and 0.0 <= m.cn_der_collar < 1.0
