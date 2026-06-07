---
phase: 11
subsystem: diarization-eval
tags: [eval, der, wder, ser, count-error, rttm, corpus, ui-copy, provider-adr, gate]
requires: [10]
runs-alongside: [12, 13, 14]
provides: [eval-harness, der-metrics, constructed-corpus, ui-copy-strings, provider-adr]
affects: [yulu/scripts/eval, yulu/spec/adr]
---

# Phase 11 Context: DER/WDER Evaluation Harness (the Gate)

## Goal (from ROADMAP)

The product **gate**: a labelled CN+EN reference corpus + a torch-free metrics harness that converts
"it runs" into a defensible number, picks the default provider (sherpa-onnx vs optional FunASR) on
evidence, and sets the UI's accuracy copy from measurement rather than feel. Lands early/parallel
because hand-labelling is slow and every later tuning change must be measured against it.

## The 5 success criteria (verbatim intent)

1. A reference corpus of CN+EN meetings labelled to RTTM **without anchoring bias** (labels from
   audio, not derived from a tool's own output).
2. The harness reports DER **both with and without the 0.25s collar** and **both with and without
   overlap scored**, plus a short-utterance metric (WDER/SER) and speaker-count error, **bucketed by
   language**.
3. The default-provider decision (sherpa vs FunASR) recorded as an **ADR justified by the measured
   numbers**, not footprint/feel alone.
4. The UI accuracy copy is **set from the measured DER** and frames labels as a correctable hint.
5. The harness is **re-runnable on the fixed corpus** so accuracy is a tracked number every later
   phase can regress against.

## Constraints (hard)

- **UI gate:** do NOT touch `yulu/scripts/yulu_ui/**` (Phase 14 is gated on a UI redesign). The
  honest copy therefore lives BACKEND-side (`eval/ui_copy.py`), ready for Phase 14 to consume.
- **No runtime mutation:** no changes to Yulu's runtime venv (`~/.config/yulu/venv-mlx-whisper/`),
  `~/.yulu`, or `~/.config/yulu`. Eval deps are dev-only.
- **Torch-free:** the load-bearing metric math must be torch-free / pyannote-free (pure stdlib).
  `pyannote.metrics` is an OPTIONAL cross-check in a dev/eval venv only (`requirements-eval.txt`),
  never the runtime, never the sole source of truth.

## Key methodology traps this phase must dodge (PITFALLS.md)

- **§1** Eval is the gate, not a tail — it must exist before later tuning so 12/13/14 regress on it.
- **§4** DER lies without its protocol — report collar×overlap, lead WDER, add SER, bucket by
  language, use a standard scorer as cross-check, and **do not anchor the reference to tool output**.
- **§2** sherpa over/under-splits on CN — count-error is the surfacing metric (Phase 12 fixes it).
- **§6** CN vs EN divergence — bucket every metric; a single pooled number is dishonest.
- **§12** Over-promising accuracy — copy must be sourced from the measured number, framed as a hint.

## Anchoring-bias resolution (the autonomous-run twist)

Criterion 1 wants human-labelled-from-audio references. This phase is built autonomously — no human
to listen. Resolution: a **constructed-ground-truth** corpus — stitch known-single-speaker audio
(macOS `say` voices, distinct voice = distinct true speaker) at offsets we choose, so the RTTM is
**exact by construction** with *zero* listening and *zero* anchoring. This validates the harness and
gives a real acoustic signal (genuine speech through sherpa's VAD+cam++), but is explicitly **not** a
substitute for human-gold real meetings → that remains a deferred `human_needed` task (criterion 1 =
constructed-unbiased now + human-gold deferred).

## Environment (this machine)

- Spike sherpa venv: `~/funasr-spike/venv-sherpa/bin/python` (Python 3.10, sherpa-onnx 1.13.2,
  soundfile+numpy) — runs the production `SherpaDiarizeBackend`.
- Eval venv: `~/funasr-spike/venv-eval/bin/python` (pyannote.metrics 4.1, **torch-free** — verified).
- Models: `~/funasr-spike/sherpa-models/` (seg `sherpa-onnx-pyannote-segmentation-3-0/model.onnx`,
  `campplus.onnx`).
- Runtime venv `~/.config/yulu/venv-mlx-whisper/` verified to have **neither torch nor pyannote** —
  no leak. macOS `say` + ffmpeg + sox all present (corpus generator works).

## Prior-run inheritance

A previous (interrupted) run left the full `yulu/scripts/eval/` package + `tests/test_eval_metrics.py`
(36 passing) UNCOMMITTED, with `eval/ui_copy.MEASURED` already populated (EN 0.007 / CN 0.682 / count
unstable). This phase **builds on** that: review for gaps, then actually RUN the harness to produce
real, cross-checked evidence behind those numbers, write the ADR + artifacts, and commit atomically.
