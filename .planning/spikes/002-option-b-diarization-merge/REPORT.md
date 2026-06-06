# Spike 002 Report — Option-B Merge & Provider Choice (feeds /gsd-plan-phase)

**Date:** 2026-06-06 · **Machine:** M1 Pro, 16 GB, macOS 26.5 · Builds on spike 001.

## TL;DR — Recommendation

> **Build diarization. Use the cam++ *approach* — but via sherpa-onnx (ONNX), NOT FunASR (torch).**
> Option B (Whisper ASR + standalone diarization merged by timestamp) works mechanically. sherpa-onnx
> is ~10–60× lighter, torch-free, CPU-fast (RTF ~0.17, no GPU), offline-clean, and **genuinely
> cross-platform** — which directly satisfies this milestone's "must not hard-couple to macOS"
> mandate that FunASR+MPS violates. The cost: sherpa's auto speaker-count needs tuning, and absolute
> accuracy is unverified. So: ship sherpa-onnx behind the capability abstraction, add a coverage-gap
> fallback, and **measure DER on labelled meetings before promising accuracy.**

## Why this changes the research report's call

The report said "FunASR cam++". The spikes refine it:
- Spike 001: FunASR cam++ on MPS is *feasible* (correct, 5–11× realtime, no blow-up) — but drags in a
  1.13 GB torch/transformers/numba stack, is Apple-only for the fast path (CPU RTF 2.28 = unusable),
  and breaks offline without a modelscope patch.
- Spike 002: the **same cam++ model runs in sherpa-onnx** as a 27 MB ONNX file, torch-free, CPU-fast,
  cross-platform. For a 28 MB feature, FunASR's footprint and macOS-coupling aren't justified.

## Evidence

| dimension | FunASR | sherpa-onnx | winner |
|-----------|--------|-------------|--------|
| install / venv | 311 s / 1.13 GB | 61 s / 131 MB | **sherpa** |
| runtime dep | torch+transformers+numba | onnxruntime only | **sherpa** |
| diar models | cam++ 28 MB | seg 5.7 MB + cam++ 27 MB | ~tie (both tiny) |
| speed | RTF 0.09–0.18 (MPS only) | RTF 0.17 (CPU/ONNX) | **sherpa** (no GPU dep) |
| auto #speakers | 5, clean | over-splits (59→32 as thr 0.5→0.7) | **FunASR** |
| cross-platform | macOS/CUDA only | Android/iOS/RPi/x86/CoreML | **sherpa** (mandate) |
| offline | needs source patch | clean local files | **sherpa** |

**Option-B merge** (whisper.cpp 752-seg transcript, both diarizers forced to 5, overlay by overlap):
clustering agreement **0.843**, matched-label agreement **0.765**; ~8–12 % of ASR segments fall
outside diarization coverage (need fallback). whisper.cpp ASR is cleaner than FunASR's ASR →
confirms keeping Whisper for ASR.

## Honest caveats

- **Accuracy is unproven.** 0.765–0.843 is *inter-tool agreement*, not correctness. ~15–20 % of
  utterances get an arguable speaker. No ground-truth DER yet. Treat speaker labels as a helpful hint.
- **sherpa auto speaker-count is weak on Chinese meetings** (over-splits). Needs threshold tuning, a
  supplied/estimated count, or a calibration step. FunASR is better here — a reason to keep it as a
  fallback option, not the default.
- Measured the 20-min clip only for the merge; validate on 1h+ and on English/mixed before shipping.

## What /gsd-plan-phase should cover

1. **New capability: `diarization` provider** behind the existing capability-provider abstraction
   (alongside the agent providers), default impl **sherpa-onnx**; FunASR/MPS as an optional
   high-accuracy macOS provider only if DER later justifies it.
2. **Pipeline integration:** post-process step that takes (audio + STT transcript segments) →
   speaker-labelled transcript. Lives near `stt_daemon/backends/` but is its own stage; ASR stays MLX
   Whisper. Reuse the `warm_up`/`transcribe`/`is_ready`/`release` Protocol shape.
3. **Merge module:** overlap assignment + coverage-gap fallback (nearest/previous speaker) + handling
   whisper hallucination/repeat artefacts.
4. **Model provisioning:** bundle/download seg (5.7 MB) + cam++ (27 MB) ONNX at setup; offline by default.
5. **Speaker-count strategy:** auto threshold tuning vs user-hint vs segmentation-model estimate.
6. **Eval task (required):** label 2–3 real Yulu meetings (CN + EN), compute DER for sherpa (and
   FunASR), pick default on evidence; set the accuracy expectation in the UI copy.
7. **UI:** show speaker labels as editable/mergeable (users will want to rename/correct).
8. **Cross-platform:** confirm sherpa-onnx wheels/models on the non-macOS targets behind the abstraction.
