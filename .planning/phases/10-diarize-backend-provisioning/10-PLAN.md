---
phase: 10
plan: 10
type: standard
autonomous: true
subsystem: diarization
requirements: [DIAR-01, DIAR-02, DIAR-03, DIAR-04, DIAR-05]
depends_on: [9]
---

# Phase 10 Plan — Diarize Backend + Provisioning + Capability Probe

**Objective:** Stand up the resident `SherpaDiarizeBackend` (warm_up/diarize/is_ready/release) that
mirrors the STT backend lifecycle but is held OUT of the ASR fallback chain, provision its two ONNX
models idempotently through the existing `models` step, and expose a tri-state `yulu-managed`
`probe_diarization()` in doctor.py — satisfying the 5 ROADMAP criteria for Phase 10.

**Context:** see `10-CONTEXT.md` (locked decisions D1–D10). Mirrors `stt_daemon/backends/mlx.py`
lifecycle, the spike `sherpa_diar.py` sherpa API, the `provision/registry.py` `models` step, and
`capabilities/probes.probe_recording_dir` tri-state pattern. Phase-9 `speaker_merge.SpeakerTurn`
is the output contract.

## Tasks

### Task 1 — `DiarizeBackend` Protocol + `SherpaDiarizeBackend` + model resolution `[type=auto]`
**Files:** `yulu/scripts/stt_daemon/backends/diarize.py` (NEW),
`yulu/scripts/stt_daemon/backends/__init__.py` (MOD, docstring only)
- Define `SpeakerTurn` (start/end seconds + speaker_idx) matching Phase-9 `from_dict` contract.
- Define `DiarizeBackend` Protocol: `async warm_up()`, `async diarize(*, audio_path, num_speakers,
  cancel_token) -> list[SpeakerTurn]`, `is_ready() -> bool`, `release()`.
- Implement `SherpaDiarizeBackend`: lazy `import sherpa_onnx` under asyncio.Lock + `_ready` flag
  (mirror `MlxWhisperBackend.warm_up`); build `OfflineSpeakerDiarizationConfig` from the spike;
  `diarize()` reads audio (soundfile), resamples to `sd.sample_rate`, runs `process().sort_by_start_time()`,
  maps to `list[SpeakerTurn]`; `warm_up()` runs a short dummy pass (1s silence) to pay the cold-start.
- Add `resolve_model_paths()` / canonical URLs / `models_present()` helpers (importable by the probe
  and the registry) so the model-file contract has ONE source of truth.
- **Done when:** module imports without sherpa installed (lazy import); `py_compile` clean.
- **Verify:** `python3 -m py_compile yulu/scripts/stt_daemon/backends/diarize.py`
- **Commit:** `feat(diarize): SherpaDiarizeBackend + DiarizeBackend protocol + model resolution`

### Task 2 — Construction seam: build the backend OFF the ASR runtime dict `[type=auto]`
**Files:** `yulu/scripts/stt_daemon/__main__.py` (MOD), `yulu/scripts/stt_daemon/config.py` (MOD)
- Add config fields: `diarize_enabled: bool`, `diarize_provider: str = "sherpa-onnx"`,
  `diarize_seg_model`/`diarize_emb_model` paths, `diarize_num_speakers: int | None`,
  `diarize_threshold: float`. Read from `transcription.diarization.*` in `from_user_config`.
- Add `_build_diarize_backend(config)` returning the backend instance (or None when disabled/unknown
  provider) — explicitly NOT inserted into the `_build_real_backends()` dict.
- **Done when:** `_build_real_backends()` still returns ASR-only keys; `_build_diarize_backend`
  exists and is config-selected.
- **Verify:** `python3 -m py_compile yulu/scripts/stt_daemon/__main__.py yulu/scripts/stt_daemon/config.py`
- **Commit:** `feat(diarize): config-selected diarize backend construction held off the ASR dict`

### Task 3 — Provision the ONNX models idempotently via the existing `models` step `[type=auto]`
**Files:** `yulu/scripts/setup_models.sh` (MOD), `yulu/scripts/provision/registry.py` (MOD)
- Extend `setup_models.sh`: after the whisper model block, download seg + cam++ ONNX to
  `$MODEL_DIR/diarization/` with `curl -L --fail` to a `.partial` then `mv` (idempotent: skip when
  the file already exists). Print canonical URLs on failure (manual fallback). Mode-agnostic.
- Extend `provision/registry.py` `_model_present()` so the `models` step `check()` is satisfied only
  when the whisper requirement AND (diarization disabled OR both ONNX files present) hold — keeping
  the step count at six (no new registry entry).
- **Done when:** `bash -n setup_models.sh` clean; registry still has exactly six steps.
- **Verify:** `bash -n yulu/scripts/setup_models.sh && python3 -c "import sys; sys.path.insert(0,'yulu/scripts'); from provision import REGISTRY; assert len(REGISTRY)==6"`
- **Commit:** `feat(provision): idempotent diarization ONNX model provisioning in the models step`

### Task 4 — Tri-state `probe_diarization()` + doctor fold `[type=auto]`
**Files:** `yulu/scripts/capabilities/probes.py` (MOD), `yulu/scripts/doctor.py` (MOD)
- Add `probe_diarization()` → `Capability(YULU_MANAGED, {USABLE|PRESENT_BUT_UNVERIFIED|ABSENT}, ...)`.
  USABLE = both ONNX present AND `sherpa_onnx` importable by `daemon_python()`; PRESENT_BUT_UNVERIFIED
  = models present, sherpa not importable; ABSENT = models missing. Never raises. Path-bounded scan
  of the fixed `models/diarization` root only.
- Fold into `doctor.py::_host_capabilities` as `report.capabilities["diarization"]`.
- **Done when:** probe returns a `Capability` for all three states; doctor JSON includes the entry.
- **Verify:** `python3 -m py_compile yulu/scripts/capabilities/probes.py yulu/scripts/doctor.py`
- **Commit:** `feat(diarize): tri-state yulu-managed probe_diarization() folded into doctor`

### Task 5 — Unit tests (CI-safe, sherpa mocked) `[type=auto]`
**Files:** `tests/test_diarize_backend.py` (NEW), `tests/test_diarize_provision_probe.py` (NEW)
- Backend: lifecycle (`warm_up`/`is_ready`/`release`) with `sherpa_onnx` injected as a fake module;
  config selection (provider→backend, disabled→None); the NOT-in-ASR-dict invariant
  (`_build_real_backends` keys ⊉ diarize; runtime can't route to it); SpeakerTurn→Phase-9 contract
  (`assign_speakers(turns=backend_output)` labels segments).
- Provision/probe: `_model_present` idempotency (disabled→whisper-only; enabled→needs both files);
  `probe_diarization` tri-state across the four (models × sherpa) combinations with mocks.
- **Done when:** new tests pass; full suite still green.
- **Verify:** `python3 -m pytest tests/test_diarize_backend.py tests/test_diarize_provision_probe.py -q`
- **Commit:** `test(diarize): backend lifecycle, ASR-isolation invariant, probe + provision idempotency`

### Task 6 — Opt-in integration smoke (real clip, forced-offline) `[type=auto]`
**Files:** `tests/test_diarize_integration.py` (NEW)
- `@pytest.mark.integration`. Skip unless the two model files exist. Run real diarization on
  `~/funasr-spike/clip_smoke_60s.wav` (re-exec the spike venv via subprocess when the runner's
  interpreter lacks sherpa); assert ≥1 turn and a sane speaker count (1..8). Assert a forced-offline
  run (`HF_HUB_OFFLINE=1`, dead `HTTPS_PROXY`) still produces turns from local files.
- **Done when:** test runs the real smoke when resources exist, skips cleanly otherwise.
- **Verify:** `python3 -m pytest tests/test_diarize_integration.py -q -m integration`
- **Commit:** `test(diarize): opt-in real-clip + forced-offline integration smoke`

## Success criteria → task mapping

| Criterion | Tasks | Evidence |
|-----------|-------|----------|
| 1 Protocol, config-selected, off ASR dict, not CapabilityProvider | 1,2,5 | NOT-in-dict unit test |
| 2 sherpa-onnx default, torch-free CPU, turns on real clip | 1,6 | integration smoke |
| 3 models via `models` step, zero-network offline load | 3,5,6 | idempotency + forced-offline tests |
| 4 tri-state `probe_diarization()` `yulu-managed` | 4,5 | probe tri-state unit test |
| 5 `warm_up()` amortizes cold-start | 1,5 | warm_up dummy-pass test |

## Final
- Run full suite (`python3 -m pytest tests -q`), report counts.
- Write `10-SUMMARY.md`; update STATE.md / ROADMAP.md.
