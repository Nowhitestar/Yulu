---
spike: 002
name: option-b-diarization-merge
type: comparison
validates: "Given an independent ASR transcript (whisper.cpp) and a standalone speaker diarization, when speakers are merged onto ASR segments by time-overlap, then who-said-what is recoverable — and FunASR vs sherpa-onnx as the diarization provider can be compared on footprint, cross-platform fit, and accuracy."
verdict: VALIDATED
related: [001]
tags: [diarization, sherpa-onnx, funasr, option-b, merge, cross-platform, feasibility]
---

# Spike 002: Option-B Diarization + Merge, FunASR vs sherpa-onnx

## What This Validates

Spike 001 proved FunASR cam++ diarization works on MPS. But option B = **MLX/whisper ASR +
standalone diarization merged by timestamp**, which spike 001 did NOT test (it used FunASR's own
coupled ASR+diarization). This spike validates the real option-B path and pressure-tests whether
**FunASR (torch, heavy)** or **sherpa-onnx (ONNX, light, cross-platform)** is the right diarization
provider — since pulling a 1.13 GB PyTorch stack for a 28 MB model fights Yulu's cross-platform mandate.

## Method

- ASR transcript: **whisper.cpp** (`ggml-large-v3-q5_0`, Yulu's own fallback engine) on
  `clip_core_20min.wav` → 752 segments with timestamps (segmentation independent of FunASR's VAD —
  the honest cross-tool merge test).
- FunASR diarization: reused spike-001 `core_cpu_dump.json` (5 speakers, per-sentence spk+timestamps).
- sherpa-onnx diarization: pyannote-3.0 segmentation + 3D-Speaker **cam++** embedding + fast clustering.
- Merge: assign each Whisper segment the speaker of max time-overlap. Compare FunASR vs sherpa
  (label-independent clustering agreement + Hungarian-matched label agreement).

## Results

### Provider comparison

| | FunASR (spike 001) | sherpa-onnx |
|---|---|---|
| install | 311 s, **1.13 GB** venv | **61 s, 131 MB** venv |
| runtime dep | torch + transformers + numba | **onnxruntime only (no torch)** |
| diarization models | cam++ 28 MB (+ 2.1 GB if full pipeline) | seg 5.7 MB + cam++ 27 MB = **33 MB** |
| device | MPS (Apple-only fast path; CPU unusable) | **CPU/ONNX, RTF 0.17–0.19** (no GPU needed) |
| auto #speakers | **5 (clean)** | 59 @thr0.5, 32 @thr0.7 — needs tuning |
| cross-platform | macOS/CUDA only | **native everywhere** (Android/iOS/RPi/x86/CoreML) |
| offline | needs modelscope patch | clean (local model files) |

### Option-B merge (both forced to 5 speakers, overlaid on the 752-seg Whisper transcript)

- **Clustering agreement (label-independent): 0.843** — they agree on same/different-speaker for
  84.3 % of segment pairs.
- **Matched-label agreement: 0.765** — 76.5 % of segments get the same speaker after optimal mapping.
- Coverage: FunASR assigned 690/752, sherpa 659/752 → **~8–12 % of ASR segments fall outside any
  diarization segment** and need a nearest-/previous-speaker fallback.
- whisper.cpp ASR is **cleaner** than FunASR's seaco-paraformer on CN/EN terms ("阿里 CDN",
  "Cloudflare/可乐费尔" vs FunASR "cloffair") → confirms option B's premise (keep Whisper for ASR).

## Investigation Trail

- sherpa auto-clustering badly over-splits on this CN meeting: **59 (thr 0.5) → 32 (0.7) → 20
  (0.85)** speakers — even an aggressive threshold never approaches the true ~5. FunASR auto-detected
  5 cleanly. So sherpa needs either a supplied speaker count or a real calibration step; FunASR's
  clustering is materially better out-of-the-box (the one dimension where FunASR wins).
- Forcing sherpa to 5 speakers makes it comparable, but the natural over-split suggests sherpa's
  embeddings/clustering are less discriminative here → FunASR's diarization may be the more accurate
  of the two on Chinese meetings (needs ground-truth DER to confirm).
- The merge mechanism itself is sound: contiguous Whisper segments get stable speakers; turn changes
  are captured. The two failure modes are (a) coverage gaps (~10 %) and (b) whisper.cpp
  hallucination/repeat on silence (an ASR artefact, not diarization).

## Verdict

**VALIDATED — option B works; provider choice is a real trade-off.**
- **Mechanically**: merging standalone diarization onto an independent Whisper transcript by overlap
  works; ~84 % structural agreement between two cam++ diarizers; needs a coverage-gap fallback rule.
- **Accuracy is moderate and tool-dependent** (~15–20 % of utterances arguable) → present speaker
  labels as a helpful hint, not ground truth; quantify DER on labelled data before promising accuracy.
- **Provider**: sherpa-onnx is ~10–60× lighter, torch-free, CPU-fast, and genuinely cross-platform
  (fits Yulu's mandate) but needs speaker-count/threshold tuning. FunASR has better auto speaker-count
  but drags in torch and is Apple-only for the fast path.

See [REPORT.md](REPORT.md) for the recommendation feeding `/gsd-plan-phase`.
