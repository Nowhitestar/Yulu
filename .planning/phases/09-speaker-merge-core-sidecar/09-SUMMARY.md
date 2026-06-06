---
phase: 9
plan: 09
subsystem: stt_daemon / speaker-diarization
tags: [diarization, speaker-merge, sidecar, pure-logic, fixtures]
requires: []
provides:
  - stt_daemon.speaker_merge.assign_speakers       # pure N-speaker overlap assignment
  - stt_daemon.speaker_merge.reanchor_by_overlap   # idempotent re-diarize re-anchor
  - "<stem>.speakers.json sidecar (schema_version 1)"  # data model + read/write/round-trip
affects:
  - Phase 13 (pipeline wiring: transcribe.py calls assign_speakers + writes the sidecar)
  - Phase 14 (UI: renders speakers map; rename/merge mutate display_name — GATED)
tech-stack:
  added: []          # ZERO new deps — stdlib only (json, os, dataclasses, pathlib)
  patterns:
    - "pure merge/assignment module (transcript_merge.py lineage)"
    - "per-recording structured sidecar as source-of-truth (.speakers.json)"
    - "stable speaker_id decoupled from volatile cluster index"
    - "atomic JSON write via temp + os.replace (queue_store/live_session convention)"
key-files:
  created:
    - yulu/scripts/stt_daemon/speaker_merge.py
    - tests/test_speaker_merge.py
  modified: []
decisions:
  - "speaker_id is stable (spk-N); cluster index is volatile and re-anchored by overlap"
  - "default display name is 1-based (Speaker 1..N) for friendlier UI"
  - "nearest-window default 2.0s — refuse to guess a speaker across a longer silence"
  - "per-segment source + confident flag carries uncertainty downstream (never laundered)"
  - "sidecar stores only abstract speaker_ids — no biometric embeddings (privacy lock)"
metrics:
  duration: ~25min
  completed: 2026-06-06
  tests_added: 32
  test_command: "make pytest  (== python3 -m pytest tests -q)"
  test_result: "873 passed, 1 skipped (pre-existing opt-in e2e); new suite 32/32 green"
---

# Phase 9 Plan 09: Speaker-Merge Core + `.speakers.json` Sidecar Summary

Pure, dependency-free N-speaker overlap-assignment engine (`stt_daemon/speaker_merge.py`) plus the
`<stem>.speakers.json` sidecar data model — assigns each ASR segment a speaker by timestamp overlap,
survives ~10% coverage gaps and whisper hallucination, and re-anchors cluster indices to stable ids
on re-diarize without ever overwriting a user rename. Built and hardened entirely on fixtures with
**no sherpa, no daemon, no SQLite, no network**.

## What Was Built

- **`yulu/scripts/stt_daemon/speaker_merge.py`** (pure module, 709 lines incl. docstrings):
  - `assign_speakers(asr_segments, turns, prior_map=…, prior_speakers=…, nearest_window=2.0, collapse_repeats=True) -> MergeResult` — the public entry point. Returns labelled `LabelledSegment`s + a `[MM:SS <display_name>] text` transcript string + the stable `speakers` map.
  - **Overlap argmax** (`_best_overlap_turn`): each ASR segment gets the diarization turn with maximum temporal intersection.
  - **Coverage-gap fallback ladder** (`_resolve_gaps_and_hallucinations`): same-speaker-bracket (both overlap-anchored neighbours agree) → nearest-turn-within-window (low confidence, gated by `nearest_window`, never crosses a long silence) → explicit `UNKNOWN` sentinel. A segment is **never dropped**.
  - **Hallucination / repeat guard**: duplicate text in a no-turn (silent) stretch is tagged `SOURCE_HALLUCINATION` + `confident=False` (borrows a neighbour label for readability but is never confidently owned); `_collapse_consecutive_repeats` drops the classic whisper same-speaker repeat artifact (different speakers saying the same word are preserved).
  - **Per-segment provenance**: every `LabelledSegment` carries a `source` (`overlap`/`bracket`/`nearest`/`unknown`/`hallucination`) and a `confident: bool` so uncertainty flows downstream rather than being laundered into false ownership.
  - **`<stem>.speakers.json` sidecar**: `build_sidecar` / `write_sidecar` (atomic temp + `os.replace` + `fsync`) / `read_sidecar` / `render_from_sidecar` / `labels_from_sidecar` / `prior_map_from_sidecar` / `apply_rename`. Schema v1: `{schema_version, provider, model, num_speakers_detected, num_speakers_supplied, turns, segments, speakers}`. Stores only abstract `speaker_id`s — **no biometric embeddings**.
  - **Idempotent re-anchor**: `reanchor_by_overlap(new_turns, prior_turns, prior_map)` computes a fresh `{new_idx -> speaker_id}` by maximum overlap between this run's turns and the prior run's turns (greedy 1:1, larger-overlap wins), so a person keeps their `speaker_id` (and rename) when the diarizer renumbers clusters. `prior_speakers` renames are copied verbatim and never overwritten; `merged_into` chains resolve for the future UI merge recovery path.

- **`tests/test_speaker_merge.py`** (32 tests, mirrors `test_transcript_merge.py` conventions): one group per success criterion + edge cases. Zero sherpa/daemon/SQLite/network.

## Test Command + Results

- Canonical: `make pytest` (== `python3 -m pytest tests -q`).
- Targeted (fast): `python3 -m pytest tests/test_speaker_merge.py -q` → **32 passed**.
- Full suite: **873 passed, 1 skipped in 672.61s**. The 1 skip is the pre-existing opt-in
  `e2e` test that needs the real MLX model (`tests/test_e2e_stt_daemon.py`) — unrelated to this phase.
  Nothing regressed.

## Success Criteria → Proving Tests

| # | ROADMAP Success Criterion | Proving test(s) in `tests/test_speaker_merge.py` |
|---|---------------------------|--------------------------------------------------|
| **1** | `assign_speakers()` returns labelled segments + `[MM:SS Speaker N]` string, picking the max-overlap speaker; zero sherpa/daemon/SQLite | `test_assign_picks_max_overlap_speaker_and_renders_string`, `test_assign_argmax_overlap_when_segment_straddles_two_turns`, `test_assign_three_speakers_default_names_are_one_based`, `test_assign_accepts_speaker_idx_and_spk_aliases`, `test_assign_sorts_by_start_and_skips_blank_text`, `test_assign_formats_minutes_and_seconds`, `test_assign_empty_input_returns_empty`, `test_render_transcript_is_pure_helper` |
| **2** | A no-overlap segment is never dropped: same-speaker-bracket → nearest-within-window → explicit `UNKNOWN`, never snapped across a speaker boundary | `test_gap_same_speaker_bracket_fills_with_that_speaker`, `test_gap_between_different_speakers_does_not_snap_across_boundary`, `test_gap_nearest_within_window_fills_low_confidence`, `test_gap_beyond_window_becomes_unknown_not_dropped`, `test_full_coverage_gap_no_turns_all_unknown_but_kept`, `test_no_segment_is_ever_dropped_under_partial_coverage` |
| **3** | A whisper hallucination/repeat (duplicate text in silence) is VAD-gated/flagged, never a confident wrong owner; uncertain segments carry a confidence flag | `test_hallucination_duplicate_in_silence_is_flagged_not_confident`, `test_hallucination_borrows_neighbour_label_but_stays_low_confidence`, `test_repeat_collapse_drops_consecutive_identical_same_speaker`, `test_repeat_collapse_keeps_same_word_from_different_speakers`, `test_confident_flag_present_on_every_segment` |
| **4** | Speaker data round-trips through `<stem>.speakers.json` (raw turns + assignments + editable `speaker_id`→`display_name` map); re-reading reproduces the same labels | `test_sidecar_path_is_stem_speakers_json`, `test_sidecar_build_has_schema_turns_segments_speakers`, `test_sidecar_roundtrip_reproduces_labels`, `test_sidecar_write_is_atomic_no_leftover_tmp`, `test_sidecar_preserves_unknown_segments`, `test_sidecar_stores_no_embeddings`, `test_read_sidecar_missing_raises` |
| **5** | Re-diarizing with a `prior_map` re-anchors fresh cluster indices to existing stable `speaker_id`s by overlap and never overwrites a user rename | `test_reanchor_by_overlap_inherits_stable_ids_when_indices_flip`, `test_reanchor_new_cluster_gets_fresh_id`, `test_rediarize_with_prior_map_preserves_user_rename`, `test_rediarize_does_not_overwrite_rename_even_with_default_name_collision`, `test_prior_map_from_sidecar_recovers_index_to_id`, `test_reanchor_idempotent_same_turns_same_map` |

## Deviations from Plan

None — plan executed as written. A few discretion calls (explicitly left to Claude by `09-CONTEXT.md`):

- **Two re-anchor seams.** `assign_speakers(prior_map=…)` does verbatim-index inheritance (stable when numbering is preserved); `reanchor_by_overlap(new_turns, prior_turns, prior_map)` does the overlap-based re-anchor for the renumbered/flip case. The pipeline (Phase 13) will call `prior_map_from_sidecar(prior_doc)` → `reanchor_by_overlap(...)` → `assign_speakers(prior_map=new_map, prior_speakers=prior_doc["speakers"])`. This split keeps each function single-purpose and table-testable.
- **`nearest_window` default = 2.0s.** Conservative on purpose: a far-away turn is not evidence of who spoke, so beyond the window a gap becomes `UNKNOWN` rather than a guess. Tunable per call.
- **1-based default display names** (`Speaker 1..N`) over 0-based, matching how users count people.

## Threat Flags

None. The module is pure logic + local file I/O for a per-recording sidecar in `data_dir`. The privacy-relevant decision (no biometric embeddings in the sidecar) is **enforced by a test** (`test_sidecar_stores_no_embeddings`), not just convention.

## Carry into Phase 13 (Pipeline Wiring)

- **Call shape (first diarize):**
  `r = assign_speakers(asr_segments=segs, turns=turns)` →
  `write_sidecar(speakers_sidecar_path(audio), build_sidecar(result=r, turns=turns, model=…, num_speakers_supplied=…))` →
  persist `r.transcript` to `.transcript.txt` (replacing the dual-track `merge_segments` output when diarization is enabled) → `search.upsert_doc`.
- **Re-diarize shape:** read prior sidecar → `prior_map_from_sidecar(doc)` → `reanchor_by_overlap(new_turns, doc["turns"], prior_map)` → `assign_speakers(prior_map=new_map, prior_speakers=doc["speakers"])`.
- **Graceful degrade:** when diarization is absent/disabled, `transcribe.py` keeps today's plain/dual-track transcript and writes no `.speakers.json` (Phase 13 owns the conditional; this module is only invoked when turns exist).
- **Summary vars (Phase 13):** the labelled `r.transcript` already carries inline `[MM:SS name]` labels, so `{{transcript}}` gets speaker context for free; the additive `{{speaker_list}}` roster can be built from `r.speakers` (`display_name` per `speaker_id`, skipping `merged_into`).
- **Low-confidence handoff:** pass `LabelledSegment.confident` / `source` downstream — do NOT collapse it into confident ownership in the summary (the milestone's "labels are a hint" rule). `UNKNOWN`/`nearest`/`hallucination` segments should be surfaced as uncertain, not attributed to a named owner.
- **`num_speakers` strategy (Phase 12)** feeds the *diarizer*, not this module — `assign_speakers` is count-agnostic and simply labels whatever turns it receives.

## Self-Check: PASSED
- `yulu/scripts/stt_daemon/speaker_merge.py` — FOUND (committed `b57cf9c`)
- `tests/test_speaker_merge.py` — FOUND (committed `babe8f2`)
- Full `make pytest` — 873 passed, 1 pre-existing skip; new 32 tests green.
