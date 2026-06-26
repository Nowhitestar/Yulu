"""Unit tests for speaker_merge: N-speaker overlap-assignment + <stem>.speakers.json sidecar.

Covers all 5 Phase-9 ROADMAP success criteria (MERGE-01..05) on fixtures, with ZERO sherpa /
daemon / SQLite / network. Each criterion is grouped under a header below; edge cases included.

Mirrors tests/test_transcript_merge.py conventions (sys.path.insert + `from stt_daemon...`).
"""

import json
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.speaker_merge import (  # noqa: E402
    SCHEMA_VERSION,
    SOURCE_HALLUCINATION,
    SOURCE_NEAREST,
    SOURCE_OVERLAP,
    SOURCE_SAME_SPEAKER_BRACKET,
    SOURCE_UNKNOWN,
    UNKNOWN_DISPLAY_NAME,
    UNKNOWN_SPEAKER_ID,
    apply_rename,
    assign_speakers,
    build_sidecar,
    labels_from_sidecar,
    prior_map_from_sidecar,
    reanchor_by_overlap,
    read_sidecar,
    render_from_sidecar,
    render_transcript,
    speakers_sidecar_path,
    write_sidecar,
)


# ════════════════════════════════════════════════════════════════════════════
# Criterion 1 — assign_speakers() returns labelled segments + [MM:SS Speaker N]
#               rendered string, picking the MAX-overlap speaker. Zero deps.
# ════════════════════════════════════════════════════════════════════════════


def test_assign_picks_max_overlap_speaker_and_renders_string():
    asr = [
        {"start": 0.0, "end": 2.0, "text": "hello"},
        {"start": 3.0, "end": 5.0, "text": "world"},
    ]
    turns = [
        {"start": 0.0, "end": 2.5, "speaker": 0},
        {"start": 2.5, "end": 6.0, "speaker": 1},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)

    # Labelled segments returned.
    assert len(result.segments) == 2
    assert result.segments[0].speaker_id == "spk-0"
    assert result.segments[1].speaker_id == "spk-1"
    assert result.segments[0].source == SOURCE_OVERLAP
    assert result.segments[0].confident is True

    # Rendered string in the [MM:SS name] text format (transcript_merge lineage).
    assert result.transcript == "[00:00 Speaker 1] hello\n[00:03 Speaker 2] world"


def test_assign_argmax_overlap_when_segment_straddles_two_turns():
    # Segment 1.0–5.0 overlaps turn0 (0–2 → 1.0s) and turn1 (2–10 → 3.0s) → turn1 wins.
    asr = [{"start": 1.0, "end": 5.0, "text": "spanning"}]
    turns = [
        {"start": 0.0, "end": 2.0, "speaker": 0},
        {"start": 2.0, "end": 10.0, "speaker": 1},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert result.segments[0].speaker_id == "spk-1"
    assert result.segments[0].source == SOURCE_OVERLAP


def test_assign_three_speakers_default_names_are_one_based():
    asr = [
        {"start": 0.0, "end": 1.0, "text": "a"},
        {"start": 2.0, "end": 3.0, "text": "b"},
        {"start": 4.0, "end": 5.0, "text": "c"},
    ]
    turns = [
        {"start": 0.0, "end": 1.5, "speaker": 0},
        {"start": 1.5, "end": 3.5, "speaker": 1},
        {"start": 3.5, "end": 6.0, "speaker": 2},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)
    names = [s.display_name for s in result.segments]
    assert names == ["Speaker 1", "Speaker 2", "Speaker 3"]
    assert set(result.speakers) == {"spk-0", "spk-1", "spk-2"}


def test_assign_uses_calendar_speaker_hints_as_editable_default_names():
    asr = [
        {"start": 0.0, "end": 1.0, "text": "a"},
        {"start": 2.0, "end": 3.0, "text": "b"},
    ]
    turns = [
        {"start": 0.0, "end": 1.5, "speaker": 0},
        {"start": 1.5, "end": 3.5, "speaker": 1},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns, speaker_hints=["Lewis", "Ciel"])

    assert [s.display_name for s in result.segments] == ["Lewis", "Ciel"]
    assert result.speakers["spk-0"]["renamed"] is False
    assert result.speakers["spk-0"]["name_source"] == "calendar_attendee"
    assert result.speakers["spk-0"]["name_confidence"] == "candidate"


def test_calendar_speaker_hints_do_not_override_user_renames():
    asr = [{"start": 0.0, "end": 1.0, "text": "a"}]
    turns = [{"start": 0.0, "end": 1.5, "speaker": 0}]
    prior = {"spk-0": {"display_name": "Yuxing", "renamed": True, "merged_into": None}}

    result = assign_speakers(
        asr_segments=asr,
        turns=turns,
        prior_map={0: "spk-0"},
        prior_speakers=prior,
        speaker_hints=["Lewis"],
    )

    assert result.segments[0].display_name == "Yuxing"
    assert result.speakers["spk-0"]["display_name"] == "Yuxing"
    assert result.speakers["spk-0"]["renamed"] is True


def test_assign_accepts_speaker_idx_and_spk_aliases():
    asr = [{"start": 0.0, "end": 1.0, "text": "x"}, {"start": 2.0, "end": 3.0, "text": "y"}]
    turns = [
        {"start": 0.0, "end": 1.5, "speaker_idx": 0},  # sherpa-style key
        {"start": 1.5, "end": 4.0, "spk": 1},          # FunASR-style key
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert [s.speaker_id for s in result.segments] == ["spk-0", "spk-1"]


def test_assign_sorts_by_start_and_skips_blank_text():
    asr = [
        {"start": 5.0, "end": 6.0, "text": "second"},
        {"start": 1.0, "end": 2.0, "text": "  "},      # blank → skipped
        {"start": 2.0, "end": 3.0, "text": "first"},
    ]
    turns = [{"start": 0.0, "end": 10.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert result.transcript == "[00:02 Speaker 1] first\n[00:05 Speaker 1] second"


def test_assign_formats_minutes_and_seconds():
    asr = [{"start": 125.0, "end": 126.0, "text": "two minutes in"}]
    turns = [{"start": 120.0, "end": 130.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert result.transcript == "[02:05 Speaker 1] two minutes in"


def test_assign_accepts_mlx_start_ms_segments():
    asr = [{"start_ms": 125_000, "end_ms": 126_000, "text": "mlx timed"}]
    turns = [{"start": 120.0, "end": 130.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert result.segments[0].start == 125.0
    assert result.segments[0].end == 126.0
    assert result.transcript == "[02:05 Speaker 1] mlx timed"


def test_assign_empty_input_returns_empty():
    result = assign_speakers(asr_segments=[], turns=[])
    assert result.transcript == ""
    assert result.segments == []
    assert result.speakers == {}


def test_render_transcript_is_pure_helper():
    result = assign_speakers(
        asr_segments=[{"start": 0.0, "end": 1.0, "text": "hi"}],
        turns=[{"start": 0.0, "end": 2.0, "speaker": 0}],
    )
    assert render_transcript(result.segments) == "[00:00 Speaker 1] hi"


# ════════════════════════════════════════════════════════════════════════════
# Criterion 2 — a no-overlap ASR segment is NEVER dropped: same-speaker-bracket
#               → nearest-within-window → explicit UNKNOWN; never crosses a boundary.
# ════════════════════════════════════════════════════════════════════════════


def test_gap_same_speaker_bracket_fills_with_that_speaker():
    # Middle segment (5.0–6.0) overlaps no turn; both neighbours are spk-0 → fill spk-0.
    asr = [
        {"start": 0.0, "end": 2.0, "text": "a"},
        {"start": 5.0, "end": 6.0, "text": "gap"},     # no turn covers this
        {"start": 9.0, "end": 11.0, "text": "c"},
    ]
    turns = [
        {"start": 0.0, "end": 2.5, "speaker": 0},
        {"start": 8.5, "end": 12.0, "speaker": 0},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)
    gap_seg = result.segments[1]
    assert gap_seg.text == "gap"
    assert gap_seg.speaker_id == "spk-0"
    assert gap_seg.source == SOURCE_SAME_SPEAKER_BRACKET
    assert gap_seg.confident is True


def test_gap_between_different_speakers_does_not_snap_across_boundary():
    # Gap bracketed by DIFFERENT speakers. With a small nearest-window the gap must NOT
    # be confidently assigned either neighbour — it must fall to nearest(low-conf) or UNKNOWN,
    # and crucially never be marked confident across the boundary.
    asr = [
        {"start": 0.0, "end": 2.0, "text": "left"},
        {"start": 20.0, "end": 21.0, "text": "gap"},   # far from both turns
        {"start": 40.0, "end": 42.0, "text": "right"},
    ]
    turns = [
        {"start": 0.0, "end": 2.5, "speaker": 0},
        {"start": 39.5, "end": 43.0, "speaker": 1},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=2.0)
    gap_seg = result.segments[1]
    assert gap_seg.text == "gap"          # never dropped
    # No same-speaker bracket (neighbours differ) and both turns are >window away → UNKNOWN.
    assert gap_seg.speaker_id == UNKNOWN_SPEAKER_ID
    assert gap_seg.source == SOURCE_UNKNOWN
    assert gap_seg.confident is False


def test_gap_nearest_within_window_fills_low_confidence():
    # Single trailing segment just outside the only turn, within the window → nearest fill.
    asr = [
        {"start": 0.0, "end": 2.0, "text": "covered"},
        {"start": 2.6, "end": 3.0, "text": "just after"},  # 0.1s gap < window
    ]
    turns = [{"start": 0.0, "end": 2.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=2.0)
    near = result.segments[1]
    assert near.text == "just after"
    assert near.speaker_id == "spk-0"
    assert near.source == SOURCE_NEAREST
    assert near.confident is False        # nearest is a guess → low confidence


def test_gap_beyond_window_becomes_unknown_not_dropped():
    asr = [
        {"start": 0.0, "end": 2.0, "text": "covered"},
        {"start": 100.0, "end": 101.0, "text": "way later"},  # far beyond window
    ]
    turns = [{"start": 0.0, "end": 2.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=2.0)
    late = result.segments[1]
    assert late.text == "way later"       # NEVER dropped
    assert late.speaker_id == UNKNOWN_SPEAKER_ID
    assert late.display_name == UNKNOWN_DISPLAY_NAME
    assert late.source == SOURCE_UNKNOWN
    assert late.confident is False


def test_full_coverage_gap_no_turns_all_unknown_but_kept():
    # No diarization turns at all → every ASR line survives as UNKNOWN.
    asr = [
        {"start": 0.0, "end": 1.0, "text": "one"},
        {"start": 2.0, "end": 3.0, "text": "two"},
    ]
    result = assign_speakers(asr_segments=asr, turns=[])
    assert len(result.segments) == 2
    assert all(s.speaker_id == UNKNOWN_SPEAKER_ID for s in result.segments)
    assert all(not s.confident for s in result.segments)
    assert result.transcript == "[00:00 Unknown] one\n[00:02 Unknown] two"


def test_no_segment_is_ever_dropped_under_partial_coverage():
    asr = [{"start": float(i), "end": i + 0.5, "text": f"seg{i}"} for i in range(10)]
    # Only cover the first 3 seconds.
    turns = [{"start": 0.0, "end": 3.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=1.0)
    assert len(result.segments) == 10            # not one line lost
    assert {s.text for s in result.segments} == {f"seg{i}" for i in range(10)}


# ════════════════════════════════════════════════════════════════════════════
# Criterion 3 — a whisper hallucination/repeat (duplicate text in a silent stretch)
#               is VAD-gated/flagged, never laundered into a confident wrong owner;
#               uncertain segments carry a confidence flag.
# ════════════════════════════════════════════════════════════════════════════


def test_hallucination_duplicate_in_silence_is_flagged_not_confident():
    # "thank you" is covered (real). A second identical "thank you" sits in a silent stretch
    # (no turn) → must be flagged hallucination + low-confidence, never a confident owner.
    asr = [
        {"start": 0.0, "end": 2.0, "text": "thank you"},
        {"start": 30.0, "end": 31.0, "text": "thank you"},   # phantom repeat in silence
    ]
    turns = [{"start": 0.0, "end": 2.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=2.0,
                             collapse_repeats=False)
    phantom = result.segments[1]
    assert phantom.text == "thank you"
    assert phantom.source == SOURCE_HALLUCINATION
    assert phantom.confident is False


def test_hallucination_borrows_neighbour_label_but_stays_low_confidence():
    # The phantom duplicate is adjacent to a real spk-0 line → may borrow spk-0 for readability,
    # but MUST remain low-confidence (not laundered into a confident attribution).
    asr = [
        {"start": 0.0, "end": 2.0, "text": "okay"},
        {"start": 2.2, "end": 2.6, "text": "okay"},   # immediate repeat, no covering turn
    ]
    turns = [{"start": 0.0, "end": 2.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=0.0,
                             collapse_repeats=False)
    dup = result.segments[1]
    assert dup.source == SOURCE_HALLUCINATION
    assert dup.confident is False
    # borrowed the neighbour's id (readable) — but the flag tells downstream not to trust it
    assert dup.speaker_id in {"spk-0", UNKNOWN_SPEAKER_ID}


def test_repeat_collapse_drops_consecutive_identical_same_speaker():
    asr = [
        {"start": 0.0, "end": 1.0, "text": "重复"},
        {"start": 1.0, "end": 2.0, "text": "重复"},   # whisper repeat artifact
        {"start": 2.0, "end": 3.0, "text": "重复"},
        {"start": 3.0, "end": 4.0, "text": "结束"},
    ]
    turns = [{"start": 0.0, "end": 4.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, collapse_repeats=True)
    texts = [s.text for s in result.segments]
    assert texts == ["重复", "结束"]   # the 2 extra repeats collapsed away


def test_repeat_collapse_keeps_same_word_from_different_speakers():
    # Same word, different speakers (genuine agreement/echo) → both kept.
    asr = [
        {"start": 0.0, "end": 1.0, "text": "yes"},
        {"start": 2.0, "end": 3.0, "text": "yes"},
    ]
    turns = [
        {"start": 0.0, "end": 1.5, "speaker": 0},
        {"start": 1.5, "end": 4.0, "speaker": 1},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns, collapse_repeats=True)
    assert len(result.segments) == 2
    assert [s.speaker_id for s in result.segments] == ["spk-0", "spk-1"]


def test_confident_flag_present_on_every_segment():
    asr = [{"start": 0.0, "end": 1.0, "text": "a"}]
    turns = [{"start": 0.0, "end": 2.0, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns)
    assert isinstance(result.segments[0].confident, bool)


# ════════════════════════════════════════════════════════════════════════════
# Criterion 4 — speaker data round-trips through <stem>.speakers.json
#               (raw turns + assignments + editable speaker_id→display_name map);
#               re-reading reproduces the same labels.
# ════════════════════════════════════════════════════════════════════════════


def test_sidecar_path_is_stem_speakers_json():
    p = speakers_sidecar_path("/data/Movies/Yulu/Meeting_2026.wav")
    assert p.name == "Meeting_2026.speakers.json"


def test_sidecar_build_has_schema_turns_segments_speakers():
    asr = [{"start": 0.0, "end": 1.0, "text": "hi"}, {"start": 2.0, "end": 3.0, "text": "bye"}]
    turns = [{"start": 0.0, "end": 1.5, "speaker": 0}, {"start": 1.5, "end": 4.0, "speaker": 1}]
    result = assign_speakers(asr_segments=asr, turns=turns)
    doc = build_sidecar(result=result, turns=turns, provider="sherpa-onnx",
                        model="cam++ zh-cn 27MB")
    assert doc["schema_version"] == SCHEMA_VERSION
    assert doc["provider"] == "sherpa-onnx"
    assert doc["num_speakers_detected"] == 2
    assert len(doc["turns"]) == 2
    assert len(doc["segments"]) == 2
    assert set(doc["speakers"]) == {"spk-0", "spk-1"}


def test_sidecar_build_records_calendar_speaker_hints():
    asr = [{"start": 0.0, "end": 1.0, "text": "hi"}]
    turns = [{"start": 0.0, "end": 1.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, speaker_hints=["Lewis"])

    doc = build_sidecar(result=result, turns=turns, speaker_hints=["Lewis"])

    assert doc["speaker_hints"] == {
        "source": "calendar_attendees",
        "names": ["Lewis"],
    }


def test_sidecar_roundtrip_reproduces_labels(tmp_path):
    asr = [
        {"start": 0.0, "end": 2.0, "text": "你好"},
        {"start": 3.0, "end": 5.0, "text": "hello"},
        {"start": 6.0, "end": 7.0, "text": "再见"},
    ]
    turns = [
        {"start": 0.0, "end": 2.5, "speaker": 0},
        {"start": 2.5, "end": 5.5, "speaker": 1},
        {"start": 5.5, "end": 8.0, "speaker": 0},
    ]
    result = assign_speakers(asr_segments=asr, turns=turns)
    doc = build_sidecar(result=result, turns=turns)

    audio = tmp_path / "Meeting.wav"
    path = write_sidecar(speakers_sidecar_path(audio), doc)
    assert path.exists()

    reloaded = read_sidecar(path)
    # Re-reading reproduces the SAME labels (same speaker_ids + display names + order).
    assert render_from_sidecar(reloaded) == result.transcript
    labels = labels_from_sidecar(reloaded)
    assert [l["speaker_id"] for l in labels] == [s.speaker_id for s in result.segments]
    assert [l["display_name"] for l in labels] == [s.display_name for s in result.segments]


def test_sidecar_write_is_atomic_no_leftover_tmp(tmp_path):
    asr = [{"start": 0.0, "end": 1.0, "text": "x"}]
    turns = [{"start": 0.0, "end": 2.0, "speaker": 0}]
    doc = build_sidecar(result=assign_speakers(asr_segments=asr, turns=turns), turns=turns)
    path = write_sidecar(tmp_path / "a.speakers.json", doc)
    # No temp sibling left behind.
    leftovers = list(tmp_path.glob("*.tmp"))
    assert leftovers == []
    # Valid JSON on disk.
    json.loads(path.read_text(encoding="utf-8"))


def test_sidecar_preserves_unknown_segments(tmp_path):
    asr = [{"start": 0.0, "end": 1.0, "text": "covered"},
           {"start": 50.0, "end": 51.0, "text": "orphan"}]
    turns = [{"start": 0.0, "end": 1.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns, nearest_window=1.0)
    doc = build_sidecar(result=result, turns=turns)
    reloaded = read_sidecar(write_sidecar(tmp_path / "m.speakers.json", doc))
    labels = labels_from_sidecar(reloaded)
    assert labels[1]["speaker_id"] == UNKNOWN_SPEAKER_ID
    assert labels[1]["text"] == "orphan"      # round-trips, not dropped


def test_sidecar_stores_no_embeddings():
    # Privacy: the sidecar must carry only abstract ids, never biometric voiceprints.
    asr = [{"start": 0.0, "end": 1.0, "text": "x"}]
    turns = [{"start": 0.0, "end": 2.0, "speaker": 0}]
    doc = build_sidecar(result=assign_speakers(asr_segments=asr, turns=turns), turns=turns)
    blob = json.dumps(doc).lower()
    for forbidden in ("embedding", "voiceprint", "vector", "biometric"):
        assert forbidden not in blob
    # Turns carry only abstract speaker_idx, no feature vectors.
    for t in doc["turns"]:
        assert set(t.keys()) == {"start", "end", "speaker_idx"}


def test_read_sidecar_missing_raises(tmp_path):
    try:
        read_sidecar(tmp_path / "nope.speakers.json")
    except FileNotFoundError:
        pass
    else:
        raise AssertionError("expected FileNotFoundError for a missing sidecar")


# ════════════════════════════════════════════════════════════════════════════
# Criterion 5 — re-diarizing with a prior_map re-anchors fresh cluster indices to
#               existing stable speaker_ids by overlap and NEVER overwrites a rename.
# ════════════════════════════════════════════════════════════════════════════


def test_reanchor_by_overlap_inherits_stable_ids_when_indices_flip():
    # Prior run: idx 0 = spk-0 (a person), idx 1 = spk-1 (another).
    prior_map = {0: "spk-0", 1: "spk-1"}
    prior_turns = [
        {"start": 0.0, "end": 10.0, "speaker": 0},
        {"start": 10.0, "end": 20.0, "speaker": 1},
    ]
    # Re-diarize FLIPS the cluster numbering: now idx 1 occupies 0–10, idx 0 occupies 10–20.
    new_turns = [
        {"start": 0.0, "end": 10.0, "speaker": 1},
        {"start": 10.0, "end": 20.0, "speaker": 0},
    ]
    new_map = reanchor_by_overlap(new_turns=new_turns, prior_turns=prior_turns,
                                  prior_map=prior_map)
    # new idx 1 (0–10) should re-anchor to spk-0 (who was there 0–10 before); new idx 0 → spk-1.
    assert new_map[1] == "spk-0"
    assert new_map[0] == "spk-1"


def test_reanchor_new_cluster_gets_fresh_id():
    prior_map = {0: "spk-0"}
    prior_turns = [{"start": 0.0, "end": 10.0, "speaker": 0}]
    # A new person appears 10–20 (idx 1) plus the original 0–10 (idx 0).
    new_turns = [
        {"start": 0.0, "end": 10.0, "speaker": 0},
        {"start": 10.0, "end": 20.0, "speaker": 1},
    ]
    new_map = reanchor_by_overlap(new_turns=new_turns, prior_turns=prior_turns,
                                  prior_map=prior_map)
    assert new_map[0] == "spk-0"          # original person keeps id
    assert new_map[1] != "spk-0"          # genuinely new cluster → fresh id


def test_rediarize_with_prior_map_preserves_user_rename():
    # First diarize.
    asr1 = [{"start": 0.0, "end": 2.0, "text": "我是 Lewis"},
            {"start": 3.0, "end": 5.0, "text": "I am Bob"}]
    turns1 = [{"start": 0.0, "end": 2.5, "speaker": 0},
              {"start": 2.5, "end": 5.5, "speaker": 1}]
    r1 = assign_speakers(asr_segments=asr1, turns=turns1)
    doc = build_sidecar(result=r1, turns=turns1)

    # User renames spk-0 → "Lewis".
    apply_rename(doc, "spk-0", "Lewis")
    assert doc["speakers"]["spk-0"]["display_name"] == "Lewis"
    assert doc["speakers"]["spk-0"]["renamed"] is True

    # Re-diarize: cluster indices come back FLIPPED.
    prior_map = prior_map_from_sidecar(doc)
    turns2 = [{"start": 0.0, "end": 2.5, "speaker": 1},   # Lewis now labelled idx 1
              {"start": 2.5, "end": 5.5, "speaker": 0}]
    new_map = reanchor_by_overlap(new_turns=turns2, prior_turns=doc["turns"],
                                  prior_map=prior_map)
    r2 = assign_speakers(
        asr_segments=asr1, turns=turns2,
        prior_map=new_map, prior_speakers=doc["speakers"],
    )

    # The rename SURVIVES: whichever cluster now covers 0.0–2.5 is still "Lewis".
    seg0 = [s for s in r2.segments if abs(s.start - 0.0) < 1e-6][0]
    assert seg0.display_name == "Lewis"
    assert r2.speakers["spk-0"]["display_name"] == "Lewis"
    assert r2.speakers["spk-0"]["renamed"] is True       # flag never cleared


def test_rediarize_does_not_overwrite_rename_even_with_default_name_collision():
    # prior_speakers already has a rename; re-running must not stomp it with "Speaker 1".
    prior_speakers = {
        "spk-0": {"display_name": "Alice", "renamed": True, "merged_into": None},
    }
    prior_map = {0: "spk-0"}
    asr = [{"start": 0.0, "end": 2.0, "text": "hi"}]
    turns = [{"start": 0.0, "end": 2.5, "speaker": 0}]
    result = assign_speakers(asr_segments=asr, turns=turns,
                             prior_map=prior_map, prior_speakers=prior_speakers)
    assert result.speakers["spk-0"]["display_name"] == "Alice"
    assert result.speakers["spk-0"]["renamed"] is True
    assert result.segments[0].display_name == "Alice"


def test_prior_map_from_sidecar_recovers_index_to_id():
    asr = [{"start": 0.0, "end": 2.0, "text": "a"}, {"start": 3.0, "end": 5.0, "text": "b"}]
    turns = [{"start": 0.0, "end": 2.5, "speaker": 0}, {"start": 2.5, "end": 5.5, "speaker": 1}]
    doc = build_sidecar(result=assign_speakers(asr_segments=asr, turns=turns), turns=turns)
    prior = prior_map_from_sidecar(doc)
    assert prior == {0: "spk-0", 1: "spk-1"}


def test_reanchor_idempotent_same_turns_same_map():
    # Re-diarizing with identical turns must reproduce the identical mapping (stability).
    prior_map = {0: "spk-0", 1: "spk-1"}
    turns = [{"start": 0.0, "end": 10.0, "speaker": 0},
             {"start": 10.0, "end": 20.0, "speaker": 1}]
    new_map = reanchor_by_overlap(new_turns=turns, prior_turns=turns, prior_map=prior_map)
    assert new_map == prior_map
