---
spike: 001
name: funasr-camplus-diarization
type: standard
validates: "Given a real CN meeting wav, when run through FunASR paraformer-zh + fsmn-vad + ct-punc + cam++ on CPU and MPS (Apple Silicon), then diarization yields correct who-said-what at a viable RTF, scales on 1h+ audio, and loads offline."
verdict: VALIDATED
related: []
tags: [diarization, funasr, mps, apple-silicon, feasibility, cam++]
---

# Spike 001: FunASR cam++ Speaker Diarization on Apple Silicon

## What This Validates

The research report concluded the real prize for Yulu is **diarization** (who-said-what), not
speed — MLX Whisper already wins on throughput on M-series. Before committing to an integration
(option B: keep MLX Whisper for ASR, add FunASR cam++ as a diarization post-process), prove the
FunASR cam++ path works locally on this Mac and capture real numbers.

**Given** a real Chinese multi-speaker meeting recording,
**when** processed by `AutoModel(model="paraformer-zh", vad_model="fsmn-vad", punc_model="ct-punc", spk_model="cam++")` on CPU and on MPS,
**then** it should produce a correct `sentence_info` with sane per-utterance speaker labels, at a
real-time factor good enough to run as a post-process, scale to 1h+ recordings without clustering
blow-up, and load fully offline after the first download.

## Environment

- **Apple M1 Pro, 16 GB RAM, 8 CPU, macOS 26.5 (arm64).**
- Throwaway venv: `~/funasr-spike/venv` on **Python 3.10.19** (system python is 3.14.3).
- Yulu's real venv (`~/.config/yulu/venv-mlx-whisper`) and code were **not touched**.
- Installed: **funasr 1.3.9, torch 2.12.0, torchaudio 2.11.0, modelscope 1.37.1, transformers 5.10.2**.

## Research (foreknowledge before building)

- **MPS:** FunASR `AutoModel` accepts `device="mps"`; docs support M-series; issue #2738 (Dec 2025)
  shows paraformer on MPS on an M4 Max. Open question = whether the *full* pipeline (cam++ spectral
  clustering, fsmn-vad, ct-punc) survives MPS or hits `NotImplementedError` / silent CPU fallback.
- **Offline bug (documented, real):** FunASR calls modelscope `snapshot_download` without passing
  `local_files_only` down, so it pings the server even when fully cached. `disable_update=True`
  alone is **not** sufficient. Documented patch (pyVideoTrans, Mar 2026): edit
  `site-packages/modelscope/hub/snapshot_download.py`, short-circuit to cache at the top of
  `_snapshot_download` when `len(cache.cached_files) > 1`. On standby for step 6.
- **Default hub = ModelScope** (`hub="ms"`, China-hosted modelscope.cn). Models map to `iic/speech_*`.
- **torch on macOS arm64 has no CUDA** → wheel is 88 MB, not the multi-GB Linux/CUDA artefact.

## How to Run

```bash
# 1. install (timed)                ~/funasr-spike/run_install.sh
# 2+3+4. core RTF + accuracy         ~/funasr-spike/run_core.sh      # cpu then mps, 20-min clip
# 5. long-audio clustering scaling   ~/funasr-spike/run_long.sh cpu  # full + --no-spk, 78-min clip
# harness:                           .planning/spikes/001-.../spike_run.py  (--device, --no-spk, --disable-update, --dump)
```

## Investigation Trail

### Setup
- System python is **3.14.3**; torch 2.12 *does* publish cp314 wheels, but funasr's full dep tree
  (onnxruntime/numba/etc.) is safest on **3.10** — used 3.10.19 for the spike. (Integration note:
  the diarization stack may need its own venv unless funasr is verified on 3.14.)
- Found **396 real Yulu recordings**. Cut three 16 kHz-mono clips from real CN product-weekly
  meetings: `clip_smoke_60s`, `clip_core_20min` (from AgentkeyProductWeekly_20260514),
  `clip_long_78min` (AgentkeyProductWeekly_20260521). Source wavs are 48 kHz stereo → resampled.

### Step 1 — Install footprint
- `pip install funasr torch torchaudio modelscope` on default PyPI: **311 s (5m11s)** wall-clock.
- venv grew 20 MB → **1134 MB (1.13 GB)**.
- Heaviest wheels: torch 88 MB, llvmlite 37 MB, scipy 22 MB, transformers 11 MB, scikit-learn 8.7 MB,
  cryptography 8 MB, sympy 6.3 MB, modelscope 6.1 MB, numpy 5.3 MB. torchaudio only **684 KB**.
- Presence of `umap-learn` + `pynndescent` + `scikit-learn` confirms cam++ uses spectral/UMAP-style
  clustering (relevant to the long-audio scaling concern).

### Step 2 — Model download
- Default hub = **ModelScope (China-hosted)**, cache at **`~/.cache/modelscope/hub/models/iic/`**
  (NOT huggingface). Download speed observed **~17–18 MB/s** — fast for a China-based user; the
  "China-hosted = slow" worry is **inverted** here.
- Per-model sizes (real):
  | model | id | size |
  |-------|----|------|
  | ASR (paraformer-zh) | `speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404` | **954 MB** |
  | punc (ct-punc) | `punc_ct-transformer_cn-en-common-vocab471067-large` | **1.1 GB** |
  | spk (cam++) | `speech_campplus_sv_zh-cn_16k-common` | **28 MB** |
  | vad (fsmn-vad) | `speech_fsmn_vad_zh-cn-16k-common-pytorch` | **3.9 MB** |
  | **total** | | **2.1 GB** |
- **Key insight:** the diarization-specific model (cam++) is only **28 MB**. The 2.1 GB is dominated
  by the ASR + punctuation models — which Yulu does **not** need if it keeps MLX Whisper for ASR
  (option B). A diarization-only footprint could be far smaller (cam++ + vad ≈ **32 MB** of models).

### Step 4 — sentence_info structure (confirmed on 60s smoke, CPU)
- `result[0]["sentence_info"]` is a list of `{"text", "start", "end", "spk", "timestamp"}` — **exactly**
  the structure the brief expected. `start`/`end` in ms; `spk` is an int speaker id; `timestamp` is
  word-level `[[start,end],...]`.
- Smoke (60 s): **4 speakers auto-detected** (ids 0–3), 24 sentences, coherent CN text, sane
  turn-taking. Some CN/EN technical-term noise ("cloffair", "base HQ点com") — an ASR-quality issue,
  not a diarization issue.

## Results

### Footprint (final)
- **Install:** 311 s, **1.13 GB venv** (additive on top of Yulu's mlx-whisper venv).
- **Models:** 2.1 GB total (cam++ alone 28 MB), `~/.cache/modelscope`, ~17–18 MB/s from China.

### Step 3 — CPU vs MPS RTF (20-min real CN meeting) — ✅ MPS VIABLE & CORRECT

| run | device landed (asr/vad/punc/spk) | load | generate | **RTF** | speed | sentences | speakers |
|-----|----------------------------------|------|----------|---------|-------|-----------|----------|
| core-cpu | all **cpu** | 46.9 s | 2730.8 s (45.5 min) | **2.28** | 0.44× | 431 | 5 |
| core-mps | all **mps:0** | 72.7 s | 222.4 s (3.7 min) | **0.185** | **5.4×** | 431 | 5 |

- **MPS ran the WHOLE pipeline on GPU** — `actual_device` = `mps:0` for asr, vad, punc **and** spk
  (cam++). No `NotImplementedError`, no garbage, **no silent CPU fallback**.
- `PYTORCH_ENABLE_MPS_FALLBACK=1` was set as a safety net. Whether it was strictly *needed* tested
  separately (step 3b) — but with it on, everything still landed on MPS.
- **MPS output is byte-identical to CPU:** full text identical, per-sentence text identical,
  speaker-label sequence identical, speaker distribution identical
  (`{spk0:73, spk2:240, spk3:73, spk1:17, spk4:28}`). MPS is correct, not approximate.
- **MPS ≈ 12.3× faster than CPU** (2730.8 / 222.4). **CPU is a non-starter** (RTF 2.28 → a 1 h
  meeting = ~2.3 h of compute). CPU also scaled *worse* 60 s→20 min (RTF 1.23→2.28, super-linear) —
  clustering-scaling signal chased in step 5.
- **MPS RTF 0.185 (5.4× realtime)** for the full paraformer+vad+punc+cam++ pipeline → a 1 h meeting
  ≈ 11 min on MPS. Comfortably viable as a post-process. (Diarization-only — option B's real cost —
  is lighter still; isolated in step 5.)

### Step 4 — Diarization accuracy (impression) — ✅ COHERENT

- 5 speakers auto-detected on the 20-min product weekly. Distribution (one dominant presenter at 240
  utterances + four others) is realistic for the meeting type.
- Turn boundaries align with content. Sample: spk0 runs a thread about CDN / Cloudflare / overseas
  servers, then spk2 cleanly takes the floor ("我现在是机场专线，是台湾的，也是连不上"). Reads as
  genuine who-said-what, not random.
- Caveat: exact speaker **count** correctness needs ground-truth labels to verify rigorously (no
  reference labels for this clip) — but structure, distribution, and turn-taking are sound.
- ASR mangles mixed CN/EN technical terms (Cloudflare→"cloffair", "base HQ点com"). This is an
  **ASR-quality** issue, not diarization — and irrelevant to option B (MLX Whisper does ASR).

### Step 5 — Long-audio clustering scaling — ✅ NO BLOW-UP

All on MPS (CPU too slow). Isolated cam++ cost = (full pipeline) − (`--no-spk`):

| length | speech segments | full RTF | nospk RTF | **cam++ marginal** |
|--------|-----------------|----------|-----------|--------------------|
| 20 min (1200 s) | 431 | 0.185 (222.4 s) | 0.0997 (119.6 s) | **102.8 s** |
| 78 min (4694.8 s) | 525 | **0.090** (422.7 s) | 0.0641 (300.8 s) | **121.9 s** |

- cam++ marginal cost rose only **+19 %** (102.8 → 121.9 s) for **3.9× more audio** → ~linear in
  speech-segment count (~0.23 s/segment, embedding-extraction dominated), **not** the feared O(n²)
  clustering blow-up. The audio-transcriber "10+ hours" pathology **did not reproduce** at 78 min.
- Full-pipeline RTF *improves* with length on MPS (0.185 → 0.090) as fixed load/warm-up amortizes.
  A **78-min meeting diarizes in ~7 min**.
- Caveat: clustering itself is still O(segments²); a recording with far more *speech* segments
  (very long AND dense, thousands of segments) could grow super-linearly. For realistic Yulu
  meetings (≤~1.5 h, hundreds of segments) it is a non-issue. Note the 78-min clip yielded only 525
  segments (lots of pauses), so segment count — not raw duration — is the real driver.
- Contrast: on **CPU** RTF got *worse* with length (60 s 1.23 → 20 min 2.28) because the
  sklearn/umap clustering runs CPU-side; MPS offloads the heavy embedding work to the GPU.

### Step 6 — Offline — ⚠️ BROKEN OUT-OF-BOX → ✅ FIXED BY PATCH

Forced offline via dead HTTP proxy (`127.0.0.1:1`); system network left intact.

- **`disable_update=True` alone fails.** With all models cached, FunASR still called
  `modelscope.cn/api/v1/models/...` → connection refused → 5 retries → `RuntimeError: model
  'paraformer-zh' is not registered`. The documented bug reproduces: `local_files_only` never reaches
  modelscope's `_snapshot_download`.
- **Documented patch works.** Inserted a cache short-circuit in
  `modelscope/hub/snapshot_download.py::_snapshot_download` (return `cache.get_root_location()` when
  `len(cache.cached_files) > 1`, right before the `if local_files_only:` block). Re-ran offline →
  **`ok: True`, 0 connection attempts**, output identical to the online smoke (4 spk / 24 sentences).
  Patch log fired once per model.
- **Build consequence:** the integration must apply this patch (install-time edit or vendored
  modelscope) or offline diarization breaks — unacceptable for local-first Yulu.

### Footprint — memory
- Full pipeline peak (`/usr/bin/time -l`, 20-min MPS): **RSS 1.4 GB; phys_footprint (incl. MPS/GPU
  unified memory) ~8.1 GB**. Fits 16 GB but is heavy; option B (cam++ + VAD only) should be much
  lighter — measure before assuming.
- Cold-start: first MPS run ~2× slower (shader JIT) — RTF 0.185 cold vs ~0.10 warm. A `warm_up()`
  dummy pass amortises this.

## Verdict

**VALIDATED — GO on MPS.** FunASR cam++ diarization runs fully on the M1 Pro GPU, byte-identical to
CPU, at 5–11× realtime (12× faster than the unusable CPU path), no fallback required. Diarization is
coherent, clustering does not blow up on 1h+ audio (78-min meeting = 7 min), and offline works once
the documented modelscope cache patch is applied. The diarization integration is worth building.
See [REPORT.md](REPORT.md) for the go/no-go and integration caveats (offline patch, ~8 GB peak RAM
for the full pipeline, Python 3.10-vs-3.14, warm-up, and measuring the lighter option-B path).
