---
phase: 11
plan: 11
subsystem: diarization-eval
approach: build-on-prior-uncommitted-work
---

# Phase 11 Plan: DER/WDER Evaluation Harness

## Strategy

A prior run left a complete, **working** `yulu/scripts/eval/` package + 36 passing tests, uncommitted.
The plan is **build ON it, not rewrite**: (1) review the modules against the 5 criteria + PITFALLS,
fixing only real gaps; (2) execute the harness for real to turn the encoded `ui_copy.MEASURED`
numbers into reproduced, cross-checked evidence; (3) record the provider ADR from those numbers;
(4) add eval-venv hygiene; (5) write artifacts; (6) commit atomically with the full suite green.

## Modules under review (all pre-existing, dev/eval-only — never imported by runtime)

| Module | Responsibility | Criterion |
|---|---|---|
| `eval/rttm.py` | NIST RTTM I/O + `Turn`/`Timeline` + interval algebra (merge/subtract/intersect) | 1,2 |
| `eval/metrics.py` | DER (collar × overlap), WDER (CJK-aware), SER, signed count-error, optimal mapping | 2 |
| `eval/corpus.py` | CONSTRUCTED corpus (TTS voices → exact RTTM) + Audacity→RTTM (human-gold path) | 1 |
| `eval/harness.py` | re-runnable CLI: provider → hyp RTTM → bucketed metric table; pyannote cross-check | 2,5 |
| `eval/ui_copy.py` | honest accuracy strings sourced from `MEASURED` DER (backend home) | 4 |
| `tests/test_eval_metrics.py` | 36 CI-safe tests locking the metric math on hand-computable cases | 2 |

## Tasks

1. **Review** every module: confirm DER 4-way protocol, WDER/SER, count-error, language buckets,
   construction-unbiased corpus, re-runnability, torch-free. Fix gaps if any (none expected).
2. **Eval-venv hygiene:** verify runtime venv has no torch/pyannote; add `eval/requirements-eval.txt`
   pinning `pyannote.metrics==4.1` as dev-only.
3. **Run for real (criterion 3 evidence):**
   - Build constructed CN+EN corpus + run `SherpaDiarizeBackend` (auto threshold 0.5) → `report_sherpa_auto.json`.
   - Forced `--num-speakers 3` run → `report_sherpa_forced3.json` (isolates count from embedding).
   - `pyannote.metrics` cross-check on the auto hyp → `report_crosscheck_auto.json`.
   - FunASR comparison (optional) — attempt; record outcome honestly if it can't run.
   - Verify re-runnability + determinism of the pure-metric `--from-rttm` path.
4. **Provider ADR** (`yulu/spec/adr/005-diarization-provider.md`): default = sherpa-onnx, justified by
   the measured numbers + footprint/cross-platform/offline (spikes). Flag the CN gap honestly.
5. **UI copy:** confirm `ui_copy.MEASURED` matches the reproduced numbers; backend-side; no UI files.
6. **Artifacts:** `11-CONTEXT.md`, `11-PLAN.md`, `11-SUMMARY.md` + committed `eval-results/` JSON.
7. **Commit** atomically (`feat(eval)`, `test(eval)`, `docs(eval)`); `make pytest` zero regressions.

## Verification

- `python3 -m pytest tests/test_eval_metrics.py -q` → 36 passed (CI-safe subset).
- `make pytest` (full suite) → no regression vs the 904 passed / 1 skipped baseline.
- Real sherpa run reproduces the `ui_copy.MEASURED` numbers; pyannote cross-check agrees on CN exactly.
- Harness re-run on the fixed corpus is deterministic (identical JSON aggregate).

## Out of scope (owned elsewhere)

- Fixing the CN under-merge → **Phase 12** (count strategy; this phase only *measures* + *gates* it).
- Wiring labels into the pipeline/summary → **Phase 13**. Rendering labels in the UI → **Phase 14**.
- Human-gold real-meeting corpus → deferred **`human_needed`** task (the harness already accepts it).
