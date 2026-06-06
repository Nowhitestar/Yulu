# Spike Manifest

## Idea

De-risk adding **speaker diarization** to Yulu via **FunASR + cam++** on Apple Silicon, as a
post-process step (option B from the research report) that keeps MLX Whisper for ASR. The
research report concluded the real prize is *diarization* (who-said-what), not speed — MLX
Whisper already wins on throughput on M-series. Before committing to an integration we must
prove the FunASR cam++ path works locally and capture real numbers: install/footprint,
model download behaviour, CPU vs **MPS** real-time factor, diarization accuracy, long-meeting
clustering scaling, and offline operation.

## Requirements

(Emerging design constraints for the real build — updated as the spike progresses.)

- Diarization must run **on the user's machine** (privacy: audio never leaves the laptop).
- Must work **offline** after first model download (Yulu is local-first; cloud strictly opt-in).
- Must integrate behind Yulu's existing async STT backend Protocol (`warm_up`/`transcribe`/
  `is_ready`/`release`) in `yulu/scripts/stt_daemon/backends/` — diarization as a post-process,
  ASR stays MLX Whisper.
- Must not duplicate/replace the MLX Whisper venv — diarization stack is additive.

## Spikes

| # | Name | Type | Validates | Verdict | Tags |
|---|------|------|-----------|---------|------|
| 001 | funasr-camplus-diarization | standard | Given a real CN meeting wav, when run through FunASR paraformer+fsmn-vad+ct-punc+cam++ on CPU and MPS, then diarization produces correct who-said-what with a viable RTF, scales on long audio, and loads offline | **VALIDATED ✓ — GO on MPS** | diarization, funasr, mps, apple-silicon, feasibility |
| 002 | option-b-diarization-merge | comparison | Given an independent whisper.cpp transcript + standalone diarization, when speakers are merged by time-overlap, then who-said-what is recoverable; and FunASR vs sherpa-onnx compared as provider | **VALIDATED ✓ — use sherpa-onnx** | diarization, sherpa-onnx, funasr, option-b, merge, cross-platform |

**Key findings (001):** MPS runs the whole pipeline on GPU, byte-identical to CPU, RTF 0.09–0.19
(5–11× realtime) vs CPU 2.28 (unusable); no `PYTORCH_ENABLE_MPS_FALLBACK` needed. cam++ clustering
does **not** blow up (78-min meeting = 7 min). Offline needs the documented modelscope
`snapshot_download` cache patch (`disable_update=True` alone fails). Footprint: venv 1.13 GB +
models 2.1 GB (cam++ only 28 MB); full-pipeline peak ~8 GB unified RAM. ModelScope (China-hosted) is
the default and **fast** (~17 MB/s). Recommend option B (MLX Whisper ASR + cam++ diarization only).
See `001-funasr-camplus-diarization/REPORT.md`.

### Spike 001 sub-questions (single sequential pipeline, shared venv+models+audio)

1. Install footprint — total venv size + download wall-clock (PyTorch the suspected heavy dep).
2. Model download — total size, cache location, China-hosted ModelScope default + speed.
3. **CPU vs MPS RTF** (the critical unknown) — wall-clock + RTF each; watch MPS for
   `NotImplementedError`, garbage/empty output, or silent CPU fallback.
4. Diarization accuracy — `sentence_info` `{spk,text,start,end,timestamp}` structure; sane
   speaker count; who-said-what correct on a known clip.
5. Long-audio clustering scaling — 1h+ recording; does cam++ clustering blow up?
6. Offline — kill network, `disable_update=True`/`local_files_only`; does it load from cache
   or hit the known ModelScope `snapshot_download` bug (documented patch on standby)?

## Test material (real Yulu recordings, resampled to 16 kHz mono)

- `clip_smoke_60s.wav` — 60 s, pipeline smoke + first-download trigger.
- `clip_core_20min.wav` — 1200 s, from `AgentkeyProductWeekly_20260514` (CN multi-speaker product weekly) — core RTF + accuracy clip.
- `clip_long_78min.wav` — 4694.8 s, from `AgentkeyProductWeekly_20260521` (single CN meeting >1h) — clustering scaling clip.

## Environment

- Apple **M1 Pro**, 16 GB RAM, 8 CPU, macOS 26.5 (arm64).
- Throwaway venv on **Python 3.10.19** at `~/funasr-spike/venv` (system python is 3.14.3 — used
  by Yulu's real venv; 3.10 chosen for widest FunASR dep coverage). Yulu's
  `~/.config/yulu/venv-mlx-whisper` is **not touched**.
- torch wheel for macOS arm64 = **88 MB** (no CUDA) — the "PyTorch is heavy" worry is largely a
  Linux/CUDA artefact; to be confirmed by total unpacked footprint.
