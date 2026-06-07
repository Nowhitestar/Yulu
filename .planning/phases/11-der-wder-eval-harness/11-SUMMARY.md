---
phase: 11
plan: 11
subsystem: diarization-eval
tags: [eval, der, wder, ser, count-error, rttm, corpus, ui-copy, provider-adr, gate]
requires: [10]
provides: [eval-harness, der-metrics, constructed-corpus, ui-copy-strings, provider-adr-005]
affects: [yulu/scripts/eval, yulu/spec/adr]
tech-stack:
  added: ["pyannote.metrics==4.1 (dev/eval venv ONLY — requirements-eval.txt; torch-free cross-check)"]
  patterns: ["torch-free hand-rolled DER + pyannote cross-check", "constructed-ground-truth corpus (zero anchoring)", "re-runnable fixed-corpus gate", "backend-owned UI copy sourced from measurement"]
key-files:
  created:
    - yulu/scripts/eval/__init__.py
    - yulu/scripts/eval/rttm.py
    - yulu/scripts/eval/metrics.py
    - yulu/scripts/eval/corpus.py
    - yulu/scripts/eval/harness.py
    - yulu/scripts/eval/ui_copy.py
    - yulu/scripts/eval/requirements-eval.txt
    - tests/test_eval_metrics.py
    - yulu/spec/adr/005-diarization-provider.md
    - .planning/phases/11-der-wder-eval-harness/eval-results/*.json
  modified: []
decisions:
  - "Default diarization provider = sherpa-onnx (ADR-005), justified by measured DER + cross-platform/footprint/offline."
  - "Load-bearing metric math is torch-free pure stdlib; pyannote.metrics is an OPTIONAL dev-venv cross-check only."
  - "Criterion 1 met via CONSTRUCTED-unbiased corpus now; human-gold real CN+EN meetings deferred as human_needed."
  - "UI accuracy copy lives backend-side (eval/ui_copy.py), sourced from the measured DER — no yulu_ui/** touched."
metrics:
  tasks: 8
  files: 10
  tests_added: 36
  completed: 2026-06-07
---

# Phase 11 Plan 11: DER/WDER Evaluation Harness (the Gate) Summary

A torch-free DER/WDER/SER/count-error harness over a **constructed-ground-truth** CN+EN corpus
(zero anchoring bias), run for real against the production `SherpaDiarizeBackend` and
**independently cross-checked with `pyannote.metrics`**, that turns "diarization runs" into a
defensible, re-runnable number — picking sherpa-onnx as the default provider on evidence (ADR-005)
and sourcing honest, backend-owned UI accuracy copy from the measurement. All 5 ROADMAP criteria met
(criterion 1 = constructed-unbiased now + human-gold deferred).

## Files (all dev/eval-only — Yulu's shipped runtime imports NOTHING from `eval/`)

| File | Role |
|---|---|
| `yulu/scripts/eval/rttm.py` | NIST RTTM I/O + `Turn`/`Timeline` + interval-set algebra (merge/subtract/intersect/total) |
| `yulu/scripts/eval/metrics.py` | DER (collar × overlap, 4 variants), WDER (CJK-aware), SER, signed count-error, optimal Hungarian-ish mapping — **pure stdlib** |
| `yulu/scripts/eval/corpus.py` | CONSTRUCTED corpus (macOS-`say` voices stitched at known offsets → exact RTTM) + `audacity_labels_to_rttm` (human-gold path) |
| `yulu/scripts/eval/harness.py` | re-runnable CLI: build/load corpus → provider (sherpa/funasr) or `--from-rttm` → bucketed metric table → JSON; `--cross-check` pyannote |
| `yulu/scripts/eval/ui_copy.py` | honest accuracy strings sourced from `MEASURED` DER (the Phase-14 UI consumes this) |
| `yulu/scripts/eval/requirements-eval.txt` | dev/eval venv pin (`pyannote.metrics==4.1`) — **never the runtime venv** |
| `tests/test_eval_metrics.py` | 36 CI-safe tests locking the metric math on hand-computable cases |
| `yulu/spec/adr/005-diarization-provider.md` | the provider decision (criterion 3) |
| `.planning/phases/11-der-wder-eval-harness/eval-results/*.json` | the committed measured reports + ref RTTMs |

## The measured DER table (criterion 2 + 3 evidence)

Corpus: `constructed_cn_3spk` (Tingting/Sinji/Meijia) + `constructed_en_3spk` (Samantha/Daniel/Fred),
3 true speakers each, exact RTTM by construction. Provider: production `SherpaDiarizeBackend` (seg
pyannote-3.0 + cam++, torch-free ONNX). Reports under `eval-results/`.

### sherpa-onnx — AUTO clustering, default threshold 0.5 (the as-shipped-today number; sources UI copy)

| recording | lang | DER c.25+ov | DER c.25−ov | DER full+ov | DER full−ov | WDER | SER | count± |
|---|---|---|---|---|---|---|---|---|
| constructed_en_3spk | en | **0.007** | 0.007 | 0.038 | 0.038 | 0.000 | 0.000 | +0 (3→3) |
| constructed_cn_3spk | cn | **0.682** | 0.682 | 0.738 | 0.738 | 0.653 | 0.667 | **−2 (3→1)** |

### sherpa-onnx — forced num_speakers=3 (isolates the count knob from the embedding; Phase-12 preview)

| recording | lang | DER c.25+ov | WDER | SER | count± |
|---|---|---|---|---|---|
| constructed_en_3spk | en | 0.318 | 0.328 | 0.333 | −1 (3→2) |
| constructed_cn_3spk | cn | 0.505 | 0.495 | 0.500 | +0 (3→3) |

### pyannote.metrics cross-check (independent scorer, AUTO hyp)

| recording | pyannote DER c.25 / full | our DER c.25 / full | agreement |
|---|---|---|---|
| constructed_cn_3spk | 0.682 / 0.738 | 0.682 / 0.738 | **exact** |
| constructed_en_3spk | 0.021 / 0.051 | 0.007 / 0.038 | ~0.013–0.014 delta (boundary handling on a near-perfect case) |

→ The torch-free hand-rolled DER is **validated, not subtly wrong** (the STACK.md requirement).

### FunASR comparison — attempted, DID NOT RUN

`--provider funasr` is implemented, but the spike `funasr` venv's model registry fails to initialize
(`RuntimeError: model '…speech_campplus_speaker-diarization_common' is not registered`) even with the
model fully cached locally and an explicit `--funasr-model-dir`. This reproduces the **spike-001
offline/registry brittleness** (PITFALLS §15). Recorded honestly; not a blocker — the provider
trade-off was already measured in spike 001, and the decision turns on cross-platform/footprint/
offline where the engines are not close. A fresh head-to-head is a `human_needed` follow-up (repair
the FunASR venv first).

## What the numbers mean

1. **EN is near-perfect on clean speech** (DER 0.007, WDER/SER 0, exact count).
2. **CN under-merges at the default threshold** (3 voices → 1 cluster). Forcing count=3 cuts CN DER
   0.682 → 0.505 → most of the CN error is the **count knob**, not the embedding — exactly Phase 12's
   mandate (PITFALLS §2).
3. **No single forced count serves both languages** — forcing 3 regresses EN (0.007 → 0.318), the
   textbook CN-vs-EN divergence (PITFALLS §6). So the default ships AUTO and the honest UI number is
   the AUTO number.

## Provider decision (criterion 3)

**Default = sherpa-onnx** — recorded in [`yulu/spec/adr/005-diarization-provider.md`](../../../yulu/spec/adr/005-diarization-provider.md).
Justified by the measured numbers (near-perfect EN; CN gap is a count problem owned by Phase 12; same
cam++ embedding as FunASR so embedding quality is a wash) **plus** the decisive cross-platform mandate
+ footprint (spike 001: FunASR ~8 GB peak / 1.13 GB venv vs sherpa ~131 MB venv / ~33 MB models) +
offline guarantee (FunASR broke offline twice). **Not** a rubber-stamp: the CN gap is recorded, not
hidden, and the forced-3 run proves it is count, not embedding.

## UI-copy location (criterion 4)

`yulu/scripts/eval/ui_copy.py` — BACKEND-side (the UI gate forbids `yulu_ui/**`). `MEASURED` holds the
reproduced numbers (EN DER 0.007, CN DER 0.682, `count_stable=False`); `accuracy_blurb()` derives a
measurement-grounded, asymmetric EN/CN expectation; the keyed strings frame labels as a **correctable
hint**, not fact. Phase 14 imports these (and may localize). A test guards that CN > EN so a future
eval that equalized them would prompt a copy review rather than silent drift.

## Human-gold-label deferred item (`human_needed`)

**Deferred human task:** label 2–3 **real** CN+EN meetings to RTTM as the true gold standard. The
harness already accepts human RTTM two ways: (a) `eval/corpus.audacity_labels_to_rttm()` /
`audacity_label_file_to_rttm()` convert an Audacity exported label track → RTTM (the STACK.md
workflow); (b) drop the RTTMs into `<corpus>/ref/*.rttm` and re-run `harness.py --corpus … --from-rttm
…`. Constructed-TTS numbers validate the harness and give a real signal on clean synthetic speech but
are **not** a substitute for human-labelled real meetings — they are an order-of-magnitude
expectation, not a guarantee. (Criterion 1 = constructed-unbiased now + human-gold deferred.)

## Eval-venv hygiene (constraint)

- Runtime venv `~/.config/yulu/venv-mlx-whisper/` verified to have **neither torch nor pyannote** — no
  leak. Eval venv has `pyannote.metrics` 4.1 and is **torch-free** (verified: `import torch` →
  ModuleNotFoundError).
- The load-bearing metric math (`metrics.py` + `rttm.py`) is **pure stdlib** — needs zero installs;
  the 36-test CI subset runs with no model/sherpa/torch/pyannote/network.
- `eval/requirements-eval.txt` pins `pyannote.metrics==4.1` as **dev/eval-only**, with a loud warning
  never to install it into the runtime venv.

## Test command + counts

- **CI-safe subset:** `python3 -m pytest tests/test_eval_metrics.py -q` → **36 passed** in ~0.03s
  (pure stdlib: RTTM round-trip, interval algebra, DER known cases, collar/overlap toggles, optimal
  mapping, WDER-vs-SER divergence, CJK word-counting, silence-skip, signed count-error, Audacity→RTTM,
  UI-copy framing + measurement-grounding).
- **Full suite:** `make pytest` (`python3 -m pytest tests -q`) → **<FULL_SUITE_RESULT>** (baseline
  before this plan: **904 passed, 1 skipped** → eval tests are additive, **zero regressions**; the 1
  skip is pre-existing/unrelated). The sherpa/funasr provider paths in `harness.py` are opt-in
  (lazily imported, only under `--provider`) so the default suite never needs heavy deps.

## 5 success criteria → status

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | CN+EN reference corpus to RTTM **without anchoring bias** | **MET** (constructed-unbiased) + human-gold **deferred** | `eval/corpus.py` stitches known-speaker `say` voices at chosen offsets → **exact RTTM, no listening** (`eval-results/constructed_*_3spk.rttm`); `audacity_labels_to_rttm` sets up the deferred human-gold path |
| 2 | DER ±collar, ±overlap, + WDER/SER + count-error, **bucketed by language** | **MET** | `metrics.der_protocol_matrix` (4 variants) + `compute_wder`/`compute_ser`/`compute_count_error`; `harness.aggregate` buckets CN/EN; the measured table above; 36 tests lock the math |
| 3 | Provider decision = **ADR justified by measured numbers** | **MET** | `yulu/spec/adr/005-diarization-provider.md` quotes the measured DER (sherpa auto + forced-3 + pyannote cross-check; FunASR-didn't-run recorded); default = sherpa-onnx |
| 4 | UI copy **set from measured DER**, frames labels as correctable hint | **MET** | `eval/ui_copy.py` (`MEASURED` = reproduced numbers; `accuracy_blurb()` derived; hint-not-fact strings) — backend-side, **no `yulu_ui/**` touched** |
| 5 | Harness **re-runnable on the fixed corpus** (tracked, regressable number) | **MET** | `harness.py --corpus … --from-rttm …` re-scores with pure stdlib (no provider); verified **deterministic** (identical JSON aggregate across runs); committed reports are the baseline 12/13/14 regress against |

## Carry-forward

- **Phase 12 (count strategy):** the CN under-merge (auto) / EN-regress-when-forced is *the* signal
  this phase exists to expose. Phase 12 wires the calendar-attendee prior + CN-calibrated threshold
  and **validates against this harness** (sweep `--threshold` / `--num-speakers`, re-score, compare
  per-language) so fixing CN doesn't regress EN.
- **Human-gold corpus:** the deferred `human_needed` task — add real labelled meetings, re-run, and
  refresh `ui_copy.MEASURED` + ADR-005 if the real numbers differ materially from constructed.
- **FunASR head-to-head:** repair the FunASR venv (modelscope offline patch, spike 001) to produce a
  fresh comparison if ever wanted; the harness path is ready.

## Self-Check: PASSED
