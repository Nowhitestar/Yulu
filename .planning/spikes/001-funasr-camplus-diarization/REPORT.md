# Spike Report — FunASR cam++ Speaker Diarization on Apple Silicon

**Date:** 2026-06-05 · **Machine:** Apple M1 Pro, 16 GB, macOS 26.5 (arm64) · **Spike:** 001 ·
**Throwaway venv:** `~/funasr-spike` (Python 3.10.19) — Yulu's real venv/code untouched.

## TL;DR — Verdict: **GO on MPS** ✅

> **MPS is viable and produces byte-identical output to CPU.** The full FunASR pipeline
> (paraformer-zh + fsmn-vad + ct-punc + cam++) runs **entirely on the M1 Pro GPU** at **RTF 0.185
> (5.4× realtime)** — about **12× faster than CPU**, which is itself unusable at RTF 2.28. Diarization
> is coherent (correct-looking who-said-what, sane speaker count). We are **not** stuck on CPU.
> Recommended integration: option B (MLX Whisper for ASR + FunASR **cam++ for diarization only**),
> which needs just the 28 MB cam++ model + 3.9 MB VAD on top of Yulu's existing stack.

## The real M-series numbers (20-min real CN meeting, full pipeline)

| device | model weights landed on | load | generate (20 min audio) | **RTF** | speed | extrapolated 1 h meeting |
|--------|------------------------|------|-------------------------|---------|-------|--------------------------|
| **CPU** | cpu | 46.9 s | 2730.8 s (45.5 min) | **2.28** | 0.44× | **~2.3 h** (unusable) |
| **MPS** | **mps:0 (all 4 models)** | 72.7 s | 222.4 s (3.7 min) | **0.185** | **5.4×** | **~11 min** |

- **MPS speedup ≈ 12.3×.** CPU is a non-starter for any real meeting length.
- 60 s warm-up clip on CPU was RTF 1.23 → 20 min worsened to 2.28 (CPU scales super-linearly).

## Does MPS produce CORRECT output, or break? — **CORRECT** ✅

- Every sub-model (asr, vad, punc, **cam++**) reported `device = mps:0`. No `NotImplementedError`,
  **no silent CPU fallback**, no empty/garbage output.
- MPS vs CPU dumps are **identical**: full text identical, per-sentence text identical, speaker-label
  sequence identical, speaker distribution identical (`{0:73, 2:240, 3:73, 1:17, 4:28}`).
- **Fallback NOT needed:** re-ran with `PYTORCH_ENABLE_MPS_FALLBACK` *unset* → still exit 0, all
  models on `mps:0`, output again byte-identical to CPU. The full pipeline runs native-MPS clean for
  this model set; the env var is a harmless safety net, not a requirement.

## Diarization accuracy impression — **coherent** ✅

- 5 speakers auto-detected on a 20-min product weekly; distribution realistic (one dominant
  presenter + others). `sentence_info` = `{spk, text, start, end, timestamp}` exactly as expected.
- Turn boundaries track the conversation (e.g. spk0 finishes a CDN/Cloudflare thread, spk2 takes the
  floor). Reads as real who-said-what.
- Caveat: rigorous speaker-count accuracy needs ground-truth labels (none for this clip); structure
  and turn-taking are sound. ASR term-noise (Cloudflare→"cloffair") is an ASR issue, not diarization
  — and moot under option B (MLX Whisper does ASR).

## Long-meeting clustering behaviour (78-min recording) — **no blow-up** ✅

Isolated cam++ cost = full − `--no-spk`, all on MPS:

| length | speech segments | full RTF | **cam++ marginal cost** |
|--------|-----------------|----------|-------------------------|
| 20 min | 431 | 0.185 (3.7 min) | 102.8 s |
| 78 min | 525 | **0.090 (7.0 min)** | 121.9 s |

- cam++ marginal cost grew only **+19 %** for **3.9× more audio** → ~linear in speech-segment count,
  **not** the feared O(n²) blow-up. The "10+ hours" pathology did **not** reproduce.
- Full-pipeline RTF *improves* with length on MPS (fixed costs amortize). 78-min meeting ≈ 7 min.
- Caveat: clustering is still O(segments²) — only a pathologically long *and* dense recording
  (thousands of speech segments) would risk it. Realistic Yulu meetings (hundreds of segments) are safe.

## Footprint

| item | size |
|------|------|
| venv (funasr+torch+torchaudio+modelscope) | **1.13 GB** |
| models total (ASR 954 MB + punc 1.1 GB + cam++ 28 MB + vad 3.9 MB) | **2.1 GB** |
| **diarization-only models (cam++ + vad)** — option B | **~32 MB** |
| install time (default PyPI) | **311 s (5m11s)** |
| model download (ModelScope, China-hosted, ~17–18 MB/s) | ~2 min |
| peak RAM, full pipeline (`/usr/bin/time -l`) | **RSS 1.4 GB; phys_footprint incl. MPS/GPU ~8.1 GB** |

- torch wheel on macOS arm64 is **88 MB** (no CUDA) — the "PyTorch is heavy" worry doesn't apply here.
- Models cache to `~/.cache/modelscope/hub/models/iic/`.

## Offline operation — **broken out-of-box; fixed by a 4-line patch** ⚠️→✅

Tested by forcing the process offline (dead HTTP proxy `127.0.0.1:1`; system network untouched).

- **`disable_update=True` is NOT enough.** With models fully cached, FunASR still hit
  `modelscope.cn/api/v1/models/...` → connection refused → 5 retries → failed with
  `RuntimeError: model 'paraformer-zh' is not registered` (it couldn't resolve the alias to the
  cached path). The documented bug reproduces exactly: FunASR never passes `local_files_only` down.
- **Documented patch fixes it.** Adding a cache short-circuit at the top of
  `modelscope/hub/snapshot_download.py::_snapshot_download` (return `cache.get_root_location()` when
  `len(cache.cached_files) > 1`) → re-ran offline → **`ok: True`, 0 network calls**, output identical
  to the online smoke (4 speakers / 24 sentences). Patch fired once per model.
- **Integration consequence:** Yulu's installer must apply this patch (or vendor a patched
  modelscope, or pin a version where this is fixed upstream) — otherwise diarization breaks the
  moment the user is offline, violating the local-first guarantee.

## Go / No-Go and integration notes

- **MPS viability: GO.** Build the diarization integration; do **not** assume CPU-only.
- **Architecture:** option B — keep MLX Whisper for ASR, add FunASR **cam++ diarization as a
  post-process**. Diarization-only models are ~32 MB; ASR (954 MB) + punc (1.1 GB) are NOT needed if
  ASR stays MLX Whisper. (Spike measured the full pipeline; option B will be lighter/faster.)
- **Python:** spike ran on 3.10; Yulu's venv is 3.14. Verify funasr's dep tree on 3.14 or give
  diarization its own venv (torch 2.12 itself does ship cp314 wheels).
- **Fits Yulu's STT backend Protocol** (`warm_up`/`transcribe`/`is_ready`/`release`) cleanly as a new
  engine that post-processes the MLX transcript.
- **Must-fix before shipping — offline patch.** The modelscope `snapshot_download` cache
  short-circuit is **required** (Yulu is local-first; without it diarization dies offline). Apply at
  install or vendor a patched modelscope.
- **Memory.** Full pipeline peaks ~8 GB unified memory on a 16 GB M1 Pro — heavy but fits. Option B
  (cam++ + VAD only) should be far lighter; measure it before assuming the 8 GB figure.
- **Warm-up.** First MPS run is ~2× slower (shader JIT). `warm_up()` should do a dummy diarization
  so the first real meeting isn't penalised. Steady-state RTF ≈ 0.09–0.10.
- **Open items for the build:** (1) measure the diarization-only path (standalone VAD+cam++, no
  paraformer/punc) — that's option B's true cost/footprint; (2) validate funasr on Python 3.14 vs a
  dedicated venv; (3) ground-truth a clip to quantify diarization error rate (DER), not just eyeball it.
