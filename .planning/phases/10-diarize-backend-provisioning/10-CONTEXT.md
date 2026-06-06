# Phase 10 — Diarize Backend + Provisioning + Capability Probe — CONTEXT (locked decisions)

**Milestone:** v0.6 Speaker Diarization · **Requirements:** DIAR-01..05
**Status:** locked at execution start (2026-06-06)
**Parallel-safe with:** Phase 9 (merge core — already complete)

## Goal (verbatim from ROADMAP)

The engine plumbing exists and stays warm — a resident `SherpaDiarizeBackend` in `stt_daemon`
that mirrors the STT backend lifecycle, dispatched on its own job kind (deliberately held OUT of
the ASR fallback chain), fed by offline-by-default ONNX models provisioned through the existing
idempotent `models` step, with a tri-state capability probe so the UI can show readiness.

## The 5 success criteria = the acceptance bar

1. A `DiarizeBackend` Protocol (audio → speaker turns with timestamps) is **config-selected**,
   mirrors the STT lifecycle (`warm_up`/`is_ready`/`release`), and is **NOT** registered into the
   ASR runtime dict **nor** a `CapabilityProvider` subclass (the ASR fallback chain can never route
   to it).
2. The default backend is **sherpa-onnx** (pyannote-3.0 segmentation + 3D-Speaker cam++ embedding)
   running **torch-free on CPU**, returning speaker turns for a short real clip.
3. Diarization models (seg ~5.7 MB + cam++ ~27 MB ONNX) **provision via the existing `models` step**
   and load from local file paths with **zero network calls** under a forced-offline test.
4. `doctor.py` reports a tri-state `probe_diarization()` entry with provenance **`yulu-managed`**
   (usable / present-but-unverified / absent).
5. A `warm_up()` dummy pass **amortizes the first-run cold-start** so the first real meeting isn't
   JIT-penalized.

## Locked decisions (from STATE Accumulated Context + research ARCHITECTURE.md + spike 002)

- **D1 — Backend Protocol, NOT CapabilityProvider.** Diarization is Yulu-managed and config-selected.
  It is surfaced as a tri-state *probe entry* (`yulu-managed` provenance), and the swappable
  sherpa-vs-FunASR seam is the `DiarizeBackend` Protocol selected by config. Forcing it into the
  agent-reuse `CapabilityProvider` ABC is an explicit anti-pattern (ARCHITECTURE Anti-Pattern 4).
- **D2 — NOT in `STTRuntime.backends`.** The ASR dict drives `_engine_chain()` (`mlx→whisper→cloud`).
  The diarize backend is constructed separately and held off that dict so ASR fallback can never
  route to it (ARCHITECTURE Anti-Pattern 1). Mirror the lifecycle trio verbatim; do NOT return
  `STTResult` (return speaker turns).
- **D3 — Lifecycle mirror.** `async warm_up()` (lazy import + asyncio.Lock + `_ready`),
  `is_ready() -> bool`, `release()`, and an async `diarize(...) -> list[SpeakerTurn]`. Same shape
  as `MlxWhisperBackend` (the literal template).
- **D4 — SpeakerTurn shape MUST feed Phase 9.** Phase 9 `speaker_merge.SpeakerTurn.from_dict`
  accepts `start`/`end` in **seconds** and a cluster index under key `speaker` / `speaker_idx` /
  `spk`. The backend emits exactly that contract (seconds + speaker_idx) so its output drops
  straight into `assign_speakers(turns=...)`.
- **D5 — sherpa API lifted from the working spike.** `OfflineSpeakerDiarizationConfig` with
  `OfflineSpeakerSegmentationPyannoteModelConfig(model=SEG)` + `SpeakerEmbeddingExtractorConfig(model=EMB)`
  + `FastClusteringConfig(num_clusters, threshold)`, `min_duration_on=0.3`, `min_duration_off=0.5`;
  `process(audio).sort_by_start_time()` → turns with `.start/.end/.speaker`. Resample to
  `sd.sample_rate` if needed. (spike `sherpa_diar.py`.)
- **D6 — Provisioning extends the existing `models` step in place.** Do NOT add a 7th registry step
  (`test_provision_registry` asserts exactly six). Extend `setup_models.sh` to fetch the two ONNX
  files idempotently AND extend the registry `models` probe (`_model_present`) so the step's
  read-only `check()` also verifies the two diarization ONNX files. Offline-by-default holds
  trivially: ONNX files are plain local bytes.
- **D7 — Canonical model URLs + local cache path.** Cache under `runtime_dir()/models/` like the
  GGML whisper models. URLs from the sherpa-onnx GitHub release assets (k2-fsa):
    - seg: `sherpa-onnx-pyannote-segmentation-3-0` (`model.onnx`, ~5.7 MB)
    - emb: `3dspeaker_speech_campplus_sv_zh-cn_16k-common.onnx` → cached as `campplus.onnx` (~27 MB)
- **D8 — Probe is tri-state + `yulu-managed`.** `probe_diarization()` mirrors `probe_recording_dir`:
  `usable` (models present AND `sherpa_onnx` importable by the daemon interp),
  `present-but-unverified` (models present, sherpa not importable),
  `absent` (no models). NEVER raises. Folded into `_host_capabilities()` in doctor.py as
  `report.capabilities["diarization"]`.
- **D9 — UI GATE (hard).** Touch ZERO `yulu/scripts/yulu_ui/**` files. Backend/Python (+ shell
  provisioning) only.
- **D10 — Do NOT mutate Yulu's real runtime.** No edits to `~/.config/yulu/venv-mlx-whisper` or
  anything under `~/.yulu` / `~/.config/yulu`. Code against the `sherpa_onnx` import; the real
  Python-3.14 wheel co-location is a Phase-15/PORT-01 concern (open question recorded in SUMMARY).

## Resources reused from the spike (DO NOT re-download / re-install)

- sherpa venv (Python **3.10**, sherpa-onnx 1.13.2 + soundfile + numpy):
  `~/funasr-spike/venv-sherpa/bin/python`
- seg model: `~/funasr-spike/sherpa-models/sherpa-onnx-pyannote-segmentation-3-0/model.onnx`
- emb model: `~/funasr-spike/sherpa-models/campplus.onnx`
- 16kHz mono test clip: `~/funasr-spike/clip_smoke_60s.wav`

Used for the real integration smoke (criteria 2 & 3). The spike venv is Python 3.10 — Yulu's
runtime venv is 3.14, which confirms the open 3.14-wheel-resolution question.

## Test strategy

- **Unit (CI-safe, no network/models):** backend lifecycle (`warm_up`/`is_ready`/`release` with
  `sherpa_onnx` mocked), config selection, the "NOT in ASR fallback dict" invariant, probe
  tri-state logic (models present/absent × sherpa importable/not), provisioning idempotency
  (check() short-circuit), and the SpeakerTurn→Phase-9 contract.
- **Opt-in integration (`@pytest.mark.integration`):** skip unless `sherpa_onnx` importable AND the
  two model files exist. Runs real diarization on the 60s clip, asserts ≥1 turn with a sane speaker
  count, and asserts a forced-offline run (dead `HTTPS_PROXY`/`HF_HUB_OFFLINE=1`) still loads from
  local files. Because the runner's default interpreter likely lacks sherpa, the integration test
  re-execs the spike venv via subprocess when needed, and skips cleanly otherwise.

## Out of scope (explicitly deferred — do not build here)

- JobKind.DIARIZE dispatch / DiarizeRequest/Response protocol messages + scheduler routing →
  Phase 13 (pipeline integration). Phase 10 ships the backend + a thin `DiarizeRuntime` holder so
  the construction seam exists, but no socket wiring is required by the 5 criteria.
- DER/WDER accuracy measurement → Phase 11.
- Speaker-count calibration → Phase 12.
- Cross-platform wheel verification + footprint budget + migrate → Phase 15.
- Any UI → Phase 14 (gated).
