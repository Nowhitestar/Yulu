---
phase: 12-speaker-count-strategy
verified: 2026-06-07T00:00:00Z
status: passed
score: 4/4 success criteria verified (COUNT-01..03 + criterion 4); independently re-run
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: n/a
  note: "Initial independent verification (separate lane). No prior 12-VERIFICATION.md existed."
independent_eval:
  reproduced: true
  method: "Re-ran yulu/scripts/eval/harness.py in the spike venv (~/funasr-spike/venv-sherpa, sherpa-onnx 1.13.2) on a freshly-built constructed CN+EN corpus — auto baseline + --use-strategy."
  auto_baseline: "CN DER 0.682 (count -2), EN DER 0.007 (count +0) — exact match to committed report_auto_thr0.5.json"
  strategy_result: "CN DER 0.5051 (count +0), EN DER 0.0074 (count +0) — byte-for-byte match to committed report_reconcile.json"
honest_finding_assessment: "SUMMARY's caveat (constructed-corpus CN threshold sweep is INERT; cam++ cannot separate similar TTS voices; supplied count is the real CN lever) is ACCURATE and NOT overstated. The supplied-count lever is unit-tested (auto=20, prior=5 -> 5). Documented finding, not a gap."
gates:
  full_suite: "967 passed, 1 skipped (python3 -m pytest tests) — integration skips cleanly w/o markers deselected; SUMMARY claim of 961+1+6-deselected is consistent (same outcome, different marker handling). Zero failures, zero regressions."
  targeted: "tests/test_speaker_count.py + tests/test_diarize_backend.py: 43 passed in 0.16s"
  yulu_ui_changes: 0
  runtime_venv_mutation: none
---

# Phase 12: Speaker-Count Strategy (the Over-Split Fix) — Verification Report

**Phase Goal:** Mitigate sherpa's measured CN over-split weakness with a deliberate count-strategy ladder whose failure mode is recoverable under-merge, using the calendar-attendee count as a free prior, then a CN-calibrated threshold, verified not to regress English.
**Verified:** 2026-06-07 (independent / separate lane)
**Status:** passed
**Re-verification:** No — initial independent verification

## Goal Achievement

### Success Criteria (ROADMAP Phase 12) + Requirements COUNT-01..03

| # | Criterion / Req | Status | Evidence (file:line / test / re-run) |
|---|-----------------|--------|--------------------------------------|
| 1 | Calendar-attendee count used as a prior (num_clusters) BEFORE threshold auto-clustering (COUNT-01) | **PASS** | `speaker_count.py:170-230` `resolve_speaker_count` — precedence config-pin > calendar prior (clamped) > auto; `reconcile_count:233-284`. Calendar path real: `check_meetings.py::_fetch_google` returns `attendees` (line 121-133). Phase-13 interface documented in module docstring (`speaker_count.py:45-74`). Test `test_calendar_prior_used_as_num_clusters` (test_speaker_count.py:44). Harness `--use-strategy` runs it end-to-end (harness.py:148-185). |
| 2 | CN-calibrated threshold (not library default) for the no-count path; honest caveat accurate (COUNT-02) | **PASS (with documented finding)** | `CALIBRATED_THRESHOLD=0.5`, `CN_THRESHOLD=0.5` (`speaker_count.py:93,99`) — deliberate swept value, language-keyed seam. sherpa default is `DEFAULT_THRESHOLD=0.5` in backend but the calibration is a *decision* backed by the 0.2–0.8 sweep in SUMMARY. **Honest caveat verified accurate**: my re-run + committed JSONs show CN auto collapses to hyp=1 regardless of threshold; supplied count is the real CN lever, which IS unit-tested (`test_reconcile_over_split_is_pulled_down_to_prior` auto=20/prior=5→5, test_speaker_count.py:169). Not overstated. |
| 3 | Fail toward UNDER-merge; reconcile never increases count beyond prior (COUNT-03) | **PASS** | Clamp `[MIN_SPEAKERS=2, MAX_AUTO_SPEAKERS=8]` (`speaker_count.py:106,110,218-220`). reconcile keeps auto rather than pushing up; clamps oversized prior before comparing (`speaker_count.py:270-283`). Tests: `test_oversized_calendar_prior_is_clamped_down` (:115), `test_custom_max_speakers_ceiling` (:129), `test_reconcile_clamps_oversized_prior_before_comparing` (:161). |
| 4 | Validated on BOTH CN + EN; fixing CN does not regress EN | **PASS — INDEPENDENTLY RE-RUN** | **I re-ran the eval myself** (spike venv + harness + fresh corpus): auto CN 0.682/EN 0.007 → strategy CN **0.5051**/EN **0.0074** (both count +0). Byte-for-byte match to committed `report_reconcile.json`. `report_count3.json` confirms forcing-always breaks EN (0.318) — so the two-pass reconcile is necessary. Integration test `test_strategy_improves_cn_without_regressing_en` (test_speaker_count_integration.py:83) asserts the contract. |

**Score:** 4/4 criteria verified (3 unconditional PASS + 1 PASS-with-documented-finding for the threshold caveat, which the task explicitly permits).

### Carry-forward (Phase-10 override-bleed fix)

| Item | Status | Evidence |
|------|--------|----------|
| Count-keyed pipeline cache; per-call override cannot bleed into auto | **PASS** | `diarize.py:201-204` `_pipelines` dict + `_default_key`; `_config_key:289-300`; default seeded once at warm_up (`:276-278`) and never reassigned. Diff confirms this is the *new* mechanism, not cosmetic. |
| Regression test "auto-after-override returns auto count" | **PASS** | `test_auto_call_after_override_uses_auto_config` (test_diarize_backend.py:258) — asserts default cfg `num_clusters == -1` after an override call. Plus `test_override_does_not_mutate_default_pipeline` (:236), `test_release_clears_pipeline_cache` (:301), `test_per_call_threshold_builds_distinct_auto_pipeline` (:287). |

### Required Artifacts

| Artifact | Status | Details |
|----------|--------|---------|
| `yulu/scripts/stt_daemon/speaker_count.py` | VERIFIED | 296 lines; pure decision functions, no I/O/sherpa; frozen dataclass; documented Phase-13 interface |
| `yulu/scripts/stt_daemon/backends/diarize.py` | VERIFIED | count-keyed cache + per-call `threshold` arg added this phase |
| `yulu/scripts/eval/harness.py` | VERIFIED | `--use-strategy` + `--attendee-count` run the SHIPPED two-pass flow via the real backend (harness.py:148-185) |
| `tests/test_speaker_count.py` | VERIFIED | 21 unit tests, all named invariants present |
| `tests/test_diarize_backend.py` | VERIFIED | +6 override-bleed regression tests |
| `tests/test_speaker_count_integration.py` | VERIFIED | opt-in real eval; skips cleanly w/o sherpa |
| `.planning/.../eval-results/*.json` | VERIFIED + REPRODUCED | 3 JSONs; numbers independently regenerated and matched exactly |

### Behavioral Spot-Checks (independently executed)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Auto baseline DER (CN+EN) | harness `--build-corpus` (spike venv) | CN 0.682/-2, EN 0.007/+0 | PASS (matches committed) |
| Strategy DER (criterion 4) | harness `--use-strategy` same corpus | CN 0.5051/+0, EN 0.0074/+0 | PASS (matches `report_reconcile.json`) |
| Targeted unit suite | `pytest test_speaker_count.py test_diarize_backend.py` | 43 passed | PASS |
| Full suite | `pytest tests` | 967 passed, 1 skipped | PASS (zero regressions) |

### Anti-Patterns Found

None. No `TBD`/`FIXME`/`XXX`/`HACK`/`PLACEHOLDER`/stub patterns in any Phase-12 file.

### Gates

- **Test suite:** 967 passed, 1 skipped (full); 43 passed (targeted). Zero failures, zero regressions vs the Phase-11 baseline. (My count differs from the SUMMARY's "961+1+6 deselected" only because I did not deselect the integration markers — same pass/fail outcome.)
- **No `yulu_ui/**` changes:** confirmed — `git diff --name-only` across all 4 Phase-12 commits returns 0 `yulu_ui` files. UI gate honored.
- **No runtime-venv mutation:** all Phase-12 changes are in the repo tree; my re-run executed entirely in `/tmp` against the spike venv. No `~/.yulu` / `~/.config/yulu` writes.

### Gaps Summary

No gaps. All four success criteria + COUNT-01..03 + the Phase-10 carry-forward fix are verified in the codebase. Criterion 4 (the highest-risk claim) was **independently reproduced from source** with the real sherpa engine — CN DER 0.682→0.505 and EN held at 0.007 are not trusted from the SUMMARY, they were regenerated and matched byte-for-byte.

The constructed-corpus CN-threshold inertness is a **documented, honest finding** (not a gap): the SUMMARY accurately states the supplied-count is the reliable CN lever and the threshold is inert on this corpus, and that lever is unit-tested. The remaining real-CN-gold-corpus confirmation is correctly carried forward as `human_needed` from Phase 11.

---

_Verified: 2026-06-07 (independent separate-lane verification)_
_Verifier: Claude (gsd-verifier) — eval independently re-run, not SUMMARY-trusted_
