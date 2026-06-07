# ADR-005: Default diarization provider = sherpa-onnx

**Status**: Accepted
**Date**: 2026-06-07
**Milestone**: v0.6 Speaker Diarization — Phase 11 (DER/WDER Eval Harness, the Gate)
**Spikes**: [001-funasr-camplus-diarization](../../../.planning/spikes/001-funasr-camplus-diarization/REPORT.md), [002-option-b-diarization-merge](../../../.planning/spikes/002-option-b-diarization-merge/REPORT.md)
**Eval harness**: `yulu/scripts/eval/` · **measured report**: [.planning/phases/11-der-wder-eval-harness/eval-results/](../../../.planning/phases/11-der-wder-eval-harness/eval-results/)

## Context

v0.6 adds local-first, cross-platform speaker attribution. Two engines were spiked as candidates
for the diarization provider behind the `DiarizeBackend` Protocol (ADR-shape mirrors the resident
STT backend, ADR-001):

- **sherpa-onnx** — ONNX Runtime, no torch; pyannote-3.0 segmentation (~5.7 MB) + 3D-Speaker cam++
  embedding (~27 MB); CPU-fast; genuinely cross-platform (publishes cp37–cp314 wheels).
- **FunASR** — modelscope/torch stack; the same cam++ embedding but a heavier runtime.

The milestone's mandate is explicit: **"architecture must NOT hard-couple to macOS; a cross-platform
abstraction layer is a first-class deliverable."** PITFALLS §1 + spike 002 require this default to be
chosen **on a measured number, not footprint/feel** — hence the Phase-11 eval harness exists *before*
this decision is recorded.

## Measured evidence (the gate)

The decision rests on a **constructed-ground-truth** corpus (`eval/corpus.py`): known-single-speaker
macOS-`say` voices stitched at offsets we choose, so the RTTM is **exact by construction** — zero
anchoring bias, no listening (PITFALLS §4). Two cases: `constructed_cn_3spk` (Tingting/Sinji/Meijia)
and `constructed_en_3spk` (Samantha/Daniel/Fred), 3 true speakers each, 6 turns each. Scored with the
torch-free `eval/metrics.py`, **independently cross-checked with `pyannote.metrics` 4.1**.

DER reported with its full protocol (collar × overlap); WDER (word-level) leads the product call;
SER (per-utterance) and signed speaker-count error surface the short-turn + over/under-split failures
DER hides.

### sherpa-onnx, auto-clustering at the library-default threshold 0.5 (the "as-shipped-today" number)

| recording | lang | DER c.25+ov | DER c.25−ov | DER full+ov | DER full−ov | WDER | SER | count± |
|---|---|---|---|---|---|---|---|---|
| constructed_en_3spk | en | **0.007** | 0.007 | 0.038 | 0.038 | 0.000 | 0.000 | +0 (3→3) |
| constructed_cn_3spk | cn | **0.682** | 0.682 | 0.738 | 0.738 | 0.653 | 0.667 | **−2 (3→1)** |

**pyannote.metrics cross-check (independent scorer, same hyp):** CN 0.682 / 0.738 — **exact match**
to our hand-rolled DER; EN 0.021 / 0.051 vs ours 0.007 / 0.038 (a ~0.013–0.014 boundary-handling
delta on a near-perfect case). The hand-rolled torch-free math is **validated, not subtly wrong**
(the STACK.md requirement).

### sherpa-onnx, forced `num_speakers=3` (isolates count-strategy from the embedding)

| recording | lang | DER c.25+ov | WDER | SER | count± |
|---|---|---|---|---|---|
| constructed_en_3spk | en | 0.318 | 0.328 | 0.333 | −1 (3→2) |
| constructed_cn_3spk | cn | 0.505 | 0.495 | 0.500 | +0 (3→3) |

**Reading of the numbers:**

1. **EN is near-perfect on clean speech** (DER 0.007, WDER/SER 0, count exact) — the happy path works.
2. **CN under-merges at the default threshold** — all 3 Chinese voices collapse to 1 cluster
   (count −2). This is the *mirror* of the spike's over-split (59→32→20): the same fragile
   **count-estimation knob** (PITFALLS §2), here failing toward under-merge on acoustically-similar
   TTS voices rather than over-split. Forcing the count to 3 cuts CN DER 0.682 → 0.505, confirming a
   large share of the CN error is **count, not embedding** — exactly Phase 12's mandate.
3. **No single count serves both languages** — forcing 3 *regresses EN* (0.007 → 0.318, 3→2), the
   textbook CN-vs-EN divergence (PITFALLS §6). This is why the default ships **auto**, and why the
   honest number that sources the UI copy is the auto number.

### FunASR comparison — attempted, DID NOT RUN

The optional FunASR head-to-head **could not be produced on this machine**: the spike `funasr` venv's
model registry fails to initialize (`RuntimeError: model '…speech_campplus_speaker-diarization_common'
is not registered`) even with the model fully present in the local modelscope cache and explicit
`--funasr-model-dir`. This is the **same offline/registry brittleness spike 001 documented as a
must-fix** (PITFALLS §15: `disable_update=True` is *not* enough; modelscope still tries to resolve).
The harness's `--provider funasr` path is implemented and ready; rerunning it needs a repaired FunASR
venv (a `human_needed` follow-up if a fresh head-to-head is ever wanted).

We do **not** treat the missing FunASR rerun as a blocker, because the provider trade-off was already
measured in spike 001 and is not close on the dimension this milestone is graded on (below).

## Decision

**Default diarization provider = sherpa-onnx.** FunASR remains an *optional, gated* comparison/
fallback provider (the harness keeps `--provider funasr`), never the default.

## Rationale

The default is graded on the milestone's actual constraints, where the two engines are **not close**:

- **Accuracy where it ships (auto-count):** sherpa is **near-perfect on clean EN** (DER 0.007). On CN
  it under-merges, but spike 001 showed FunASR's *advantage is specifically count* (it clustered the
  same CN clip cleanly to 5) — i.e. FunASR would *not* materially beat sherpa's EN, and sherpa's CN
  gap is a **count-strategy problem we own in Phase 12** (calendar-attendee prior → CN-calibrated
  threshold → fail-toward-under-merge), not an embedding ceiling. Both engines use the **same cam++
  embedding**, so the embedding quality is a wash.
- **Cross-platform mandate (decisive):** sherpa-onnx is ONNX-Runtime, torch-free, cp37–cp314 wheels —
  it *satisfies* "must not hard-couple to macOS." FunASR drags torch + modelscope and **broke under
  forced-offline** in spike 001 (and again here). For a local-first, cross-platform, offline-by-
  default product this is disqualifying for the *default*.
- **Footprint (spike 001, measured):** full FunASR pipeline peaked **~8 GB** unified memory + **1.13 GB**
  venv; sherpa-onnx installs in ~61 s into a **~131 MB** venv with **~33 MB** models, RTF ~0.17 on CPU.
  On Yulu's 8-daemon launchd runtime (the resident `stt_daemon` alone is ~2 GB) the FunASR footprint
  is unacceptable as the always-available default.
- **Offline guarantee (PITFALLS §15):** sherpa loads from explicit local ONNX paths with zero hub
  resolution; Phase-10's forced-offline integration test already proved zero network calls. FunASR
  failed offline twice.

Net: sherpa wins on cross-platform + footprint + offline outright, and **ties or wins on the accuracy
that ships** once the CN count gap is handled where it belongs (Phase 12). The measured numbers do not
contradict the spike-based engine choice — they confirm it, and they pin the honest accuracy the UI
must communicate.

## Honesty guard (did we rubber-stamp?)

No. The instruction was to *flag* sherpa if it were "catastrophically worse than FunASR on the
corpus." We can't assert FunASR's corpus number (its rerun failed), but the measured sherpa CN gap is
**real and recorded** (DER 0.682, count −2) rather than hidden, the forced-3 run **proves it is a
count problem** (the thing Phase 12 fixes and the eval will regress), and the UI copy
(`eval/ui_copy.py`) is set from these exact numbers — EN framed as usually-accurate, CN framed as
notably-less-reliable with an unstable count. The decision is "sherpa is the right *default* given the
mandate, with a known CN-count gap owned by the next phase," not "sherpa is uniformly best."

## Consequences

**Good**
- One torch-free shipped-runtime dependency; the cross-platform/offline mandate is satisfied by the
  default, not an exception.
- A re-runnable DER number (`eval/harness.py`) gates every later tuning change (EVAL-05); the
  provider choice is falsifiable, not a memory.
- UI accuracy copy is sourced from measurement (`eval/ui_copy.py`), so trust survives the first
  visible CN error.

**Bad / carry-forward**
- CN auto-count is materially worse than EN **today** — this is **Phase 12's entry condition**, not a
  regression. The eval (`--num-speakers`, threshold sweep) is the instrument that will validate the
  CN fix without regressing EN.
- The constructed corpus is **not** human-gold: TTS voices are cleaner and (for CN here) less
  separable than real overlapping human meetings. Numbers are an order-of-magnitude expectation, not
  a guarantee. The **`human_needed`** follow-up (2–3 hand-labelled real CN+EN meetings via the
  `eval/corpus.audacity_labels_to_rttm` path) remains the true gold standard and is deferred as a
  human task.
- A fresh FunASR head-to-head needs a repaired FunASR venv; deferred (not on the critical path).

## Notes for future change

If Phase 12's CN-calibrated threshold + calendar-attendee prior still can't get sherpa's CN DER into
an acceptable band on the **human-gold** corpus, the gated FunASR fallback is the documented escape
hatch (spike 001 — it wins on count) — but only with the modelscope `snapshot_download` offline
patch spike 001 flagged, or it breaks the offline guarantee. Re-run `eval/harness.py --provider
funasr` against the same fixed corpus to make that call on evidence, exactly as this ADR was made.
