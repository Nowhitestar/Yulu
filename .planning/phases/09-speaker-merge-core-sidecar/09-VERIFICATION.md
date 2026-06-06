---
phase: 09-speaker-merge-core-sidecar
verified: 2026-06-06T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: initial verification
gaps: []
human_verification: []
---

# Phase 9: Speaker-Merge Core + `.speakers.json` Sidecar — Verification Report

**Phase Goal:** The milestone's highest-risk *logic* exists as a pure, dependency-free module — assigning each ASR segment a speaker by timestamp overlap, surviving coverage gaps, hallucination, and re-runs — plus the sidecar data model whose "renames survive re-diarize" property is locked at the file level. Buildable and hardenable on fixtures with no sherpa, no daemon, no SQLite.

**Verified:** 2026-06-06
**Status:** passed
**Re-verification:** No — initial verification

This was an independent verification lane: I read the source + tests, ran the tests myself, AND wrote my own adversarial fixtures (distinct from the committed test file) to falsify the four flagged invariants. All held.

## Goal Achievement

### Observable Truths (the 5 ROADMAP Success Criteria = MERGE-01..05)

| # | Truth | Status | Evidence |
| --- | ----- | ------ | -------- |
| 1 | `assign_speakers()` returns labelled segments + `[MM:SS Speaker N]` string, picking the **max-overlap** speaker, zero sherpa/daemon/SQLite | ✓ VERIFIED | Impl: `speaker_merge.py:232` `assign_speakers`, `:170` `_best_overlap_turn` (argmax intersection), `:573` `render_transcript`. Tie/straddle correctness proven by my own probe (1.0–5.0 straddle → larger-overlap turn wins) + `test_assign_argmax_overlap_when_segment_straddles_two_turns`. Render format proven exact: `"[00:00 Speaker 1] hello\n[00:03 Speaker 2] world"` (`test_assign_picks_max_overlap_speaker_and_renders_string:64`). Empty→"" (`test_assign_empty_input_returns_empty`). |
| 2 | A no-overlap segment is **never dropped**: same-speaker-bracket → nearest-within-window → explicit `UNKNOWN`, and **never snapped across a speaker boundary** | ✓ VERIFIED | Impl: `_resolve_gaps_and_hallucinations:339` (3-rung ladder), `_neighbour_idx:397` (bracket anchors **only** on `SOURCE_OVERLAP`, so guesses can't propagate), `_nearest_turn_within_window:183` (refuses beyond window). Tests: `test_gap_same_speaker_bracket_fills_with_that_speaker`, `test_gap_between_different_speakers_does_not_snap_across_boundary` (→ UNKNOWN, confident=False), `test_no_segment_is_ever_dropped_under_partial_coverage` (10/10 lines survive). **My own probe** (gap ~0.1s from BOTH a spk-0 and a spk-1 turn): result was `source=nearest, confident=False` — i.e. a cross-boundary fill is **never marked confident**. Bracket-fill across *different* speakers does NOT fire (verified independently). |
| 3 | A whisper hallucination/repeat (duplicate text in a silent stretch) is VAD-gated/flagged, **never laundered into a confident wrong owner**; uncertain segments carry a confidence flag | ✓ VERIFIED | Impl: `_is_repeat_of:222`, hallucination branch `:365-374` (tags `SOURCE_HALLUCINATION` + forces `confident=False`; borrows neighbour label for readability ONLY when low-confidence; falls to UNKNOWN if no anchor), `_collapse_consecutive_repeats:411` (same-speaker only — different speakers preserved). Tests: `test_hallucination_duplicate_in_silence_is_flagged_not_confident`, `test_hallucination_borrows_neighbour_label_but_stays_low_confidence`, `test_repeat_collapse_keeps_same_word_from_different_speakers`. **My own probe**: dup deep in silence borrowed `spk-0` from a non-adjacent anchor but stayed `confident=False` — readable, never *confidently* owned. The criterion forbids *confident* wrong-owner attribution, which is enforced. |
| 4 | Speaker data round-trips through `<stem>.speakers.json` (raw turns + assignments + editable `speaker_id`→`display_name` map); re-read reproduces the same labels; **stores NO biometric embeddings** | ✓ VERIFIED | Impl: `speakers_sidecar_path:588`, `build_sidecar:593` (schema_version 1; turns + segments + speakers), `write_sidecar:619` (atomic temp + `os.replace` + `fsync`), `read_sidecar:633`, `render_from_sidecar:660`, `labels_from_sidecar:640`. Tests: `test_sidecar_roundtrip_reproduces_labels` (render + ids + names identical after reload), `test_sidecar_preserves_unknown_segments`, `test_sidecar_write_is_atomic_no_leftover_tmp`, `test_sidecar_stores_no_embeddings`. **My own probe**: union of all turn keys = `{start,end,speaker_idx}` only; zero `embedding/voiceprint/vector/biometric/feature` tokens in serialized JSON. Privacy lock holds — only abstract ids. |
| 5 | Re-diarizing with a `prior_map` re-anchors fresh cluster indices to existing stable `speaker_id`s **by overlap** and **never overwrites a user rename** | ✓ VERIFIED | Impl: `reanchor_by_overlap:512` (greedy 1:1 by accumulated overlap, larger wins; new cluster → fresh non-colliding `spk-N`), `_build_speaker_map:430` + `prior_map_from_sidecar:674`, renames copied verbatim and never re-defaulted. Tests: `test_reanchor_by_overlap_inherits_stable_ids_when_indices_flip`, `test_reanchor_new_cluster_gets_fresh_id`, `test_rediarize_with_prior_map_preserves_user_rename`, `test_rediarize_does_not_overwrite_rename_even_with_default_name_collision`, `test_reanchor_idempotent_same_turns_same_map`. **My own probe** (rename spk-0→"Lewis", then FLIP cluster numbering): `new_map={0:'spk-1',1:'spk-0'}`, segment at t=0 still renders **"Lewis"**, `renamed:True` never cleared. |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `yulu/scripts/stt_daemon/speaker_merge.py` | Pure I/O-free merge core + sidecar | ✓ VERIFIED | 710 lines. Imports are stdlib-only: `json, os, dataclasses, pathlib, typing`. Substantive (full ladder + re-anchor + sidecar). Committed `b57cf9c`. |
| `tests/test_speaker_merge.py` | Exhaustive fixture suite, all 5 criteria | ✓ VERIFIED | 512 lines, 32 tests grouped one-section-per-criterion + edge cases. Committed `babe8f2`. |

### Purity / Dependency Check (Hard Constraint)

| Check | Result | Evidence |
| ----- | ------ | -------- |
| No sherpa/sqlite/socket/network/numpy/torch/onnx/asyncio/subprocess **imports** | ✓ PASS | `grep` of import lines shows only `json, os, dataclasses, pathlib, typing`. The strings "sherpa"/"sqlite" appear ONLY in docstrings, comments, and the `provider="sherpa-onnx"` default value — never as imports. |
| Module is genuinely pure / I-O-free on the hot path | ✓ PASS | Only filesystem touch is the sidecar read/write helpers (by design, documented at `speaker_merge.py:7-9`); `assign_speakers` itself does zero I/O. |

### UI Gate (Hard Constraint)

| Check | Result | Evidence |
| ----- | ------ | -------- |
| NO `yulu/scripts/yulu_ui/**` file touched | ✓ PASS | `git diff --name-only main..HEAD` → no path contains `yulu_ui`. Only code files changed: `tests/test_speaker_merge.py`, `yulu/scripts/stt_daemon/speaker_merge.py` (rest are `.planning/**` docs/spikes). |

### Behavioral Spot-Checks (run independently, NOT the committed tests)

| Behavior | Result | Status |
| -------- | ------ | ------ |
| Cross-boundary gap fill is never `confident=True` | gap ~0.1s from two different-speaker turns → `source=nearest, confident=False` | ✓ PASS |
| Same-speaker bracket does NOT fire across different speakers | tight gap between spk-0/spk-1 → `source != bracket`, low-confidence | ✓ PASS |
| Hallucination never confidently owned | dup-in-silence → `source=hallucination, confident=False` (with and without adjacent anchor) | ✓ PASS |
| Sidecar carries only abstract ids | turn keys = `{start,end,speaker_idx}`; 0 forbidden tokens | ✓ PASS |
| Rename survives FLIPPED re-diarize | t=0 segment still "Lewis"; `renamed:True` preserved | ✓ PASS |
| Rename not stomped by default-name collision | prior "Alice" preserved through re-run | ✓ PASS |

### Test Execution (run by verifier, own processes)

| Suite | Command | Result | Status |
| ----- | ------- | ------ | ------ |
| Phase-9 targeted | `python3 -m pytest tests/test_speaker_merge.py -q` | **32 passed in 0.03s** | ✓ PASS |
| Full Python suite | `python3 -m pytest tests -q` | **873 passed, 1 skipped in 541s** (exit 0) | ✓ PASS |

The 1 skip is a pre-existing opt-in e2e test (`test_e2e_stt_daemon.py`, needs the real MLX model) — unrelated to this phase, matches the SUMMARY claim. No regressions. (A second, duplicate full-suite run was killed mid-flight by the verifier as redundant — its exit-144 is the kill, not a real failure; the authoritative run above completed clean.)

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| MERGE-01 | 09-PLAN | Pure I/O-free max-overlap assignment, fixture-testable | ✓ SATISFIED | Truth 1 |
| MERGE-02 | 09-PLAN | Coverage-gap fallback, never snap across boundary | ✓ SATISFIED | Truth 2 |
| MERGE-03 | 09-PLAN | VAD-gate hallucination, never confident wrong owner, confidence flag | ✓ SATISFIED | Truth 3 |
| MERGE-04 | 09-PLAN | `.speakers.json` sidecar, abstract ids, no synced SQLite source-of-truth | ✓ SATISFIED | Truth 4 |
| MERGE-05 | 09-PLAN | Idempotent re-anchor by overlap, never clobber renames | ✓ SATISFIED | Truth 5 |

No orphaned requirements: REQUIREMENTS.md maps exactly MERGE-01..05 to Phase 9, all claimed by 09-PLAN.

### Anti-Patterns Found

| File | Pattern | Severity | Impact |
| ---- | ------- | -------- | ------ |
| — | none | — | `grep` for TBD/FIXME/XXX/HACK/PLACEHOLDER/"not implemented"/"coming soon" across both code files → NONE. No debt markers. No stub returns that flow to output (UNKNOWN sentinel is intentional, tested behavior, not a stub). |

### Tests-Are-Not-Gamed Audit

I checked the committed tests for vacuousness and confirmed they assert real behavior, not tautologies:
- Criterion-1 tests assert the **exact** rendered string and the **specific** winning speaker on a straddle (argmax, not first-match).
- Criterion-2 tests assert both the surviving text AND the `source`/`confident` flags, and one asserts 10/10 lines survive partial coverage.
- Criterion-3 tests distinguish same-speaker collapse from different-speaker preservation — a gamed test would collapse both.
- Criterion-4 includes a privacy test that scans the serialized blob for forbidden tokens AND asserts the exact turn key-set.
- Criterion-5 deliberately FLIPS cluster numbering and asserts the rename follows the *person*, not the index — the hard case, not the trivial identity case (which is separately covered by the idempotency test).

My independent fixtures (different numbers, different gap geometries) reproduced every invariant, so the suite is not overfit to its own inputs.

### Human Verification Required

None. This phase is pure logic + local-file sidecar, fully verifiable programmatically. No visual/real-time/external-service surface (UI is Phase 14, gated).

### Gaps Summary

No gaps. All 5 success criteria (MERGE-01..05) are implemented with real logic and proven by genuine, non-gamed tests; both hard constraints (purity, UI gate) hold; the full suite is green with no regressions. Phase goal achieved.

---

_Verified: 2026-06-06_
_Verifier: Claude (independent verification lane)_
