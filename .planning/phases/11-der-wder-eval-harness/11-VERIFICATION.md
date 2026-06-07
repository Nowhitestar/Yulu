---
phase: 11-der-wder-eval-harness
verified: 2026-06-07T01:30:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: "Initial independent verification (separate lane)"
deferred:
  - truth: "Reference corpus of 2-3 *real* CN+EN meetings labelled to RTTM (human-gold standard)"
    addressed_in: "Deferred human_needed follow-up (acknowledged in EVAL-01, ADR-005, 11-SUMMARY.md)"
    evidence: "Criterion 1 = constructed-unbiased NOW + human-gold deferred. Harness already accepts human RTTM two ways (eval/corpus.audacity_labels_to_rttm + <corpus>/ref/*.rttm + --from-rttm). Constructed corpus satisfies the anti-anchoring intent (exact-by-construction, never derived from a diarizer)."
---

# Phase 11: DER/WDER Evaluation Harness (the Gate) Verification Report

**Phase Goal:** A labelled CN+EN reference corpus + a torch-free metrics harness that converts "it runs" into a defensible number, picks the default provider (sherpa-onnx vs FunASR) on evidence, and sets the UI's accuracy copy from measurement.
**Verified:** 2026-06-07 (independent lane — code and numbers checked directly, not from SUMMARY claims)
**Status:** passed
**Re-verification:** No — initial independent verification

## Goal Achievement

### Observable Truths (the 5 ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Reference corpus labelled to RTTM **without anchoring bias** (labels from audio, not a tool's output) | ✓ VERIFIED (constructed-unbiased now; human-gold deferred) | `eval/corpus.py:177` `stitch_known_segments` concatenates known-single-speaker TTS clips at chosen offsets → RTTM is **exact by construction**, never derived from any diarizer. Committed refs `eval-results/constructed_{cn,en}_3spk.rttm` (3 spk, 6 turns each, durations correct). Human-gold path `audacity_labels_to_rttm` (`corpus.py:330`) exists + `--from-rttm`. |
| 2 | DER ±collar AND ±overlap + short-utterance metric (WDER/SER) + speaker-count error, bucketed by language | ✓ VERIFIED | `metrics.der_protocol_matrix` (`metrics.py:294`) returns all 4 variants `{collar0.25,full}×{overlap,nooverlap}`; `compute_wder` (CJK-aware, `metrics.py:354`), `compute_ser` (`metrics.py:405`), `compute_count_error` (signed, `metrics.py:458`); `harness.aggregate` buckets by `cn`/`en` (`harness.py:237`). **Math independently hand-verified** (see below). 36/36 tests pass. |
| 3 | Default-provider decision recorded as ADR justified by **measured numbers** | ✓ VERIFIED | `yulu/spec/adr/005-diarization-provider.md` — default=sherpa-onnx, quotes measured DER table (auto + forced-3 + pyannote cross-check), FunASR-didn't-run recorded honestly, CN gap flagged as **Phase-12 entry condition not a Phase-11 failure** (lines 132-141), explicit "did we rubber-stamp? No" honesty guard (line 112). |
| 4 | UI accuracy copy set from measured DER, frames labels as a correctable hint | ✓ VERIFIED | `eval/ui_copy.py` — `MEASURED` snapshot (EN 0.007 / CN 0.682 / `count_stable=False`, `ui_copy.py:54`); `accuracy_blurb()` derives asymmetric EN/CN expectation from the number; strings frame labels as "best guess … not a fact … expect to correct some". **BACKEND-side; NO `yulu_ui/**` file touched** (git diff confirmed). |
| 5 | Harness re-runnable on the fixed corpus (tracked, regressable number) | ✓ VERIFIED | `harness.py --corpus … --from-rttm …` pure-stdlib scoring path (no provider import). **Determinism proven empirically**: re-ran twice → run1.json == run2.json byte-identical; self-score (hyp==ref) → DER 0 sanity. Committed reports are the 12/13/14 baseline. |

**Score:** 5/5 truths verified

### Deferred Items

| # | Item | Addressed In | Evidence |
|---|------|-------------|----------|
| 1 | 2-3 **real** human-labelled CN+EN meetings (true gold standard) | Deferred `human_needed` | Acknowledged in EVAL-01, ADR-005 (lines 136-140), 11-SUMMARY.md. Harness already accepts human RTTM. Criterion 1 explicitly = "constructed-unbiased now + human-gold deferred." Per verification scope: acceptable, not a gap. |

### Independent Math Verification (criterion 2 — the load-bearing check)

I hand-computed DER on toy RTTM pairs I constructed myself (NOT reusing the repo's test cases) and ran them through `compute_der`:

| Toy case | Hand-computed | Harness output | Match |
|---|---|---|---|
| ref A 0-10 / B 10-20; hyp boundary slip A 0-12 / B 12-20 (conf 2s / total 20s) | DER 0.1000 | 0.1000 | ✓ exact |
| ref A/B/C 0-9 (3 eq); hyp 1 spk 0-9 (conf 6 / total 9) | DER 0.6667 | 0.6667 | ✓ exact |
| collar 0.25 on the slip case | < full DER | 0.0962 < 0.1000 | ✓ correct direction |
| overlap-skip (ref A 0-6 + B 2-4 overlap; hyp A only) | < scored DER | 0.0000 < 0.3333 | ✓ correct direction |

→ The torch-free hand-rolled DER is **correct, not subtly wrong**. Collar forgives boundary slip; overlap-skip flatters the score — both toggles move the number in the right direction.

### Headline-Number Sanity Check (criterion 7)

Committed `eval-results/report_sherpa_auto.json` contains **real run data** matching the SUMMARY exactly:

| recording | DER c.25+ov | DER full+ov | WDER | SER | count± |
|---|---|---|---|---|---|
| constructed_en_3spk | 0.007 | 0.038 | 0.000 | 0.000 | +0 (3→3) |
| constructed_cn_3spk | 0.682 | 0.738 | 0.653 | 0.667 | −2 (3→1) |

- **Not a collar/overlap artifact:** the CN gap persists across ALL 4 protocol variants (full+ov 0.738 is even higher). EN stays near-perfect across all 4.
- **pyannote.metrics cross-check (independent scorer):** CN **0.6824/0.738 EXACT** match to our DER; EN 0.0206/0.0508 vs ours 0.007/0.038 (~0.013 boundary-handling delta on a near-perfect case). Methodology validated.
- **forced-3 run** (`report_sherpa_forced3.json`): EN 0.318 (regressed from 0.007), CN 0.505 (improved from 0.682) — confirms the CN error is a **count knob, not embedding ceiling**, and that no single forced count serves both languages → ship AUTO. Sound analysis.
- **CN DER 0.682 is a MEASURED FINDING**, correctly diagnosed as Phase-12's calibration target — not a Phase-11 gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `yulu/scripts/eval/metrics.py` | DER 4-variant + WDER/SER + count-error, pure stdlib | ✓ VERIFIED | 488 lines, stdlib-only imports, math hand-verified |
| `yulu/scripts/eval/rttm.py` | RTTM I/O + interval algebra | ✓ VERIFIED | Duration-vs-endtime foot-gun handled correctly; exhaustively tested |
| `yulu/scripts/eval/corpus.py` | Constructed-unbiased corpus + human-gold path | ✓ VERIFIED | `stitch_known_segments` exact-by-construction; `audacity_labels_to_rttm` for human path |
| `yulu/scripts/eval/harness.py` | Re-runnable CLI, buckets by language, pyannote cross-check | ✓ VERIFIED | Imports REAL Phase-10 `SherpaDiarizeBackend` (lazy); `--from-rttm` CI-safe path; determinism proven |
| `yulu/scripts/eval/ui_copy.py` | Honest copy from measured DER, backend-side | ✓ VERIFIED | `MEASURED`=reproduced numbers; no `yulu_ui/**` touched |
| `yulu/scripts/eval/requirements-eval.txt` | pyannote.metrics dev/eval-only pin | ✓ VERIFIED | Pins `pyannote.metrics==4.1`, loud "NEVER install into runtime venv" warning, torch-free |
| `tests/test_eval_metrics.py` | CI-safe metric tests | ✓ VERIFIED | **36 tests collected, 36 passed** (Python 3.14, 0.04s, pure stdlib) |
| `yulu/spec/adr/005-diarization-provider.md` | Provider ADR from measured numbers | ✓ VERIFIED | Thorough, honest, CN-gap-as-Phase-12 framing correct |
| `eval-results/*.json` + `*.rttm` | Committed measured reports | ✓ VERIFIED | 3 JSON reports + 2 ref RTTMs, all real data |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `harness.run_provider_sherpa` | `stt_daemon.backends.diarize.SherpaDiarizeBackend` | lazy import (`harness.py:129`) | ✓ WIRED | Harness scores the SAME engine Yulu ships, not a re-implementation |
| `ui_copy.MEASURED` | committed `report_sherpa_auto.json` | EN 0.007 / CN 0.682 / count_stable=False | ✓ WIRED | Copy numbers == reproduced run numbers |
| shipped runtime (`yulu/scripts/**` non-eval) | `eval/**` | (must be NONE) | ✓ CORRECTLY ISOLATED | grep confirms NO runtime file imports from eval/ |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Metric tests pass | `python3 -m pytest tests/test_eval_metrics.py -q` | 36 passed in 0.04s | ✓ PASS |
| DER math correct on independent toy | hand-computed vs `compute_der` | 0.10/0.6667 exact match | ✓ PASS |
| Collar toggle direction | `compute_der collar=0.25 < collar=0` | 0.0962 < 0.1000 | ✓ PASS |
| Overlap toggle direction | `score_overlap=False < True` | 0.0 < 0.3333 | ✓ PASS |
| Harness re-run determinism | `--from-rttm` twice → diff JSON | byte-identical | ✓ PASS |
| Self-score sanity (hyp==ref) | `--from-rttm` with ref as hyp | DER 0.0 | ✓ PASS |
| Full test suite regression | `python3 -m pytest tests -q` | **940 passed, 1 skipped** (546s); baseline 904+1 → +36 eval tests, exactly additive, **zero regressions** | ✓ PASS |

### Gate Constraints (criterion 6 + 7)

| Constraint | Status | Evidence |
|---|---|---|
| Eval dep `pyannote.metrics` NOT in runtime venv | ✓ PASS | `~/.config/yulu/venv-mlx-whisper`: `import pyannote.metrics` → ModuleNotFoundError. The Phase-11-introduced dep did NOT leak. |
| `requirements-eval.txt` not referenced by install/setup | ✓ PASS | grep of `setup.sh`/`install.sh`/`Makefile`/runtime: zero references |
| Load-bearing modules torch-free | ✓ PASS | `metrics.py`/`rttm.py`/`ui_copy.py` import only stdlib at top-level; heavy deps (sherpa/pyannote/funasr) lazy-imported only under `--provider`/`--cross-check` |
| No `~/.config/yulu` / `~/.yulu` mutation | ✓ PASS | `eval/*.py` never references those paths; harness writes only to `--out` (default `/tmp/yulu-eval`) |
| No `yulu_ui/**` touched (criterion 4) | ✓ PASS | git diff of all 4 Phase-11 commits (684ff61..234ccac): zero `yulu_ui/` files |

### Requirements Coverage

| Requirement | Source | Description | Status | Evidence |
|---|---|---|---|---|
| EVAL-01 | Phase 11 | CN+EN corpus to RTTM without anchoring bias | ✓ SATISFIED (constructed) + human-gold deferred | `corpus.py` exact-by-construction; "real meetings" = deferred human_needed |
| EVAL-02 | Phase 11 | DER/WDER harness, dev-only, collar+overlap policy + short-utterance metric | ✓ SATISFIED | `metrics.py` 4-variant DER + WDER/SER + count-error; 36 tests |
| EVAL-03 | Phase 11 | Eval is the GATE that picks default provider on evidence | ✓ SATISFIED | ADR-005 from measured numbers |
| EVAL-04 | Phase 11 | UI copy from measured DER, correctable hint | ✓ SATISFIED | `ui_copy.py` backend-side, sourced from MEASURED |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| — | — | none | — | No TBD/FIXME/XXX debt markers in eval/. The two `human_needed` deferrals (real-meeting gold corpus; FunASR rerun) are explicitly scoped follow-ups documented in ADR-005 + SUMMARY, not unreferenced debt. |

### Note: torch in the local runtime venv (investigated, NOT a Phase-11 violation)

`~/.config/yulu/venv-mlx-whisper` contains `torch 2.11.0`. Investigation:
- **`pyannote.metrics` (the actual Phase-11 eval dep) is ABSENT** — the gate constraint that matters is satisfied.
- torch's site-packages **mtime is May 9**, ~1 month BEFORE the Phase-11 commits (Jun 7). It is a **pre-existing local-machine artifact** (this dev's env), not introduced by this phase. Phase 11 added zero runtime deps; its load-bearing math is pure stdlib and the shipped code imports nothing from eval/.
- The SUMMARY's claim "runtime venv verified to have neither torch nor pyannote" is slightly inaccurate about torch on *this* machine, but the substantive constraint (Phase-11 eval deps stay out of the runtime venv) holds. Not a gate violation.

### Human Verification Required

None blocking. One acknowledged deferred `human_needed` task (not a gate for Phase 11): label 2-3 real CN+EN meetings as true gold and refresh `ui_copy.MEASURED` + ADR-005 if real numbers differ materially from constructed.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are independently verified against the codebase and the committed numbers. The DER math is hand-confirmed correct (not just "tests pass"), the headline numbers come from real runs and are pyannote-cross-checked, the harness is provably deterministic, the UI-copy constraint (no `yulu_ui/**`) is git-confirmed, and the eval-dep isolation holds. The CN DER 0.682 is a sound measured finding correctly routed to Phase 12; the human-gold real-meeting corpus is an acknowledged deferred item. Phase goal achieved.

---

_Verified: 2026-06-07_
_Verifier: Claude (gsd-verifier, independent lane)_
