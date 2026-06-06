---
phase: 10-diarize-backend-provisioning
verified: 2026-06-06T00:00:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
---

# Phase 10: Diarize Backend + Provisioning + Capability Probe — Verification Report

**Phase Goal:** The engine plumbing exists and stays warm — a resident `SherpaDiarizeBackend` in
`stt_daemon` that mirrors the STT backend lifecycle, dispatched on its own job kind (deliberately
held OUT of the ASR fallback chain), fed by offline-by-default ONNX models provisioned through the
existing idempotent `models` step, with a tri-state capability probe so the UI can show readiness.
**Verified:** 2026-06-06 (independent lane — code/tests verified directly, builder self-report not trusted)
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (the 5 ROADMAP Success Criteria = DIAR-01..05)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `DiarizeBackend` Protocol (audio→turns), config-selected, mirrors STT lifecycle (`warm_up`/`is_ready`/`release`), NOT in ASR runtime dict, NOT a `CapabilityProvider` subclass | ✓ VERIFIED | `diarize.py:147` `@runtime_checkable DiarizeBackend(Protocol)` w/ the trio + `diarize()`; `__main__.py:50 _build_diarize_backend` is a SEPARATE constructor (config-selected; unknown provider→None); `__main__.py:43-47` comment + `_build_real_backends` returns ASR-only keys; **runtime check: `SherpaDiarizeBackend.__mro__ == [SherpaDiarizeBackend, object]`, `issubclass(...,CapabilityProvider)==False`, `probe_diarization` is a function**; test `test_diarize_backend_is_not_in_asr_runtime_dict` (test_diarize_backend.py:254) asserts no diarize key, `_engine_chain` never yields diarize, and `runtime.transcribe(engine="diarize")` raises `ValueError` (corroborated by runtime.py:425-426) |
| 2 | Default backend is sherpa-onnx (pyannote-3.0 seg + cam++ embedding), torch-free on CPU, returns turns on a real clip | ✓ VERIFIED | `SherpaDiarizeBackend._build_config` (diarize.py:207) uses `OfflineSpeakerSegmentationPyannoteModelConfig` + `SpeakerEmbeddingExtractorConfig` (cam++) + `FastClusteringConfig` — onnxruntime only; **static: zero `import torch`/`pyannote.audio` in the diarize path**; **spike venv `pip freeze` = only numpy/soundfile/sherpa-onnx-core/sherpa_onnx — NO torch**; **I RAN the production backend forced-offline: warm_up 0.58s → diarize on 60s clip = 15 turns / 3 speakers (speaker_idx {0,4,7})**; test `test_real_diarization_returns_sane_turns` PASSED |
| 3 | Models (seg ~5.7 MB + cam++ ~27 MB ONNX) provision via the existing `models` step; load offline w/ ZERO network under forced-offline test | ✓ VERIFIED | `setup_models.sh:91 setup_diarization_models` (idempotent skip-when-present L101/L115, gated on `diarization_enabled` L93, `.partial`→`mv` atomic, seg `.tar.bz2`→`segmentation.onnx` extract, manual-URL fallback); `registry.py:205 _diarization_models_present` folded into `_model_present` (L231) — **registry stays exactly 6 steps** (verified live); **I RAN `test_real_diarization_works_offline` w/ `HF_HUB_OFFLINE=1`+dead `HTTPS_PROXY`(:9)→ PASSED, 15 turns produced from local ONNX**; `bash -n` clean |
| 4 | `doctor.py` tri-state `probe_diarization()` entry, provenance `yulu-managed` (usable/present-but-unverified/absent) | ✓ VERIFIED | `probes.py:294 probe_diarization` returns `Capability(YULU_MANAGED, {USABLE|PRESENT_BUT_UNVERIFIED|ABSENT})`, never raises; importability via `daemon_python()` (honest daemon-interp check, probes.py:95); folded into `doctor.py:263 report.capabilities["diarization"]`; **I exercised all 3 states live: ABSENT (no models), PRESENT_BUT_UNVERIFIED (models present, sherpa not in daemon interp), USABLE ("sherpa-onnx 1.13.2; seg+emb ONNX present") — provenance `yulu-managed` in every case**; `doctor.py --json` confirmed to emit the diarization entry |
| 5 | `warm_up()` dummy pass amortizes first-run cold-start | ✓ VERIFIED | `SherpaDiarizeBackend.warm_up` (diarize.py:224) lazy-imports sherpa under `asyncio.Lock`+`_ready` flag (mirrors `MlxWhisperBackend`), builds the resident `OfflineSpeakerDiarization`, runs `sd.process(np.zeros(sample_rate))` to prime the ORT graph (L242-255); test `test_warmup_loads_pipeline_and_runs_dummy_pass` asserts the 1s dummy `process()` fired; **live: warm_up = 0.58s, so the first real diarize is not JIT-penalized** |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu/scripts/stt_daemon/backends/diarize.py` | Protocol + SherpaDiarizeBackend + model resolution | ✓ VERIFIED | 322 lines; real sherpa API, lazy import, full lifecycle trio, `SpeakerTurn` feeds Phase-9; imports on 3.14 WITHOUT sherpa |
| `yulu/scripts/stt_daemon/__main__.py` | `_build_diarize_backend` off the ASR dict; `app.diarize_backend` | ✓ VERIFIED | Separate constructor (L50); ASR dict ASR-only (L21-47); attached at L85 |
| `yulu/scripts/stt_daemon/config.py` | `transcription.diarization.*` fields | ✓ VERIFIED | 6 fields (L55-62), parsed in `from_user_config` (L105-122), `enabled=False` default |
| `yulu/scripts/stt_daemon/backends/__init__.py` | docstring note (diarize is a sibling, off ASR dict) | ✓ VERIFIED | Docstring updated (L3-5) |
| `yulu/scripts/setup_models.sh` | idempotent gated diarization download, 6-step preserved | ✓ VERIFIED | `setup_diarization_models` + `setup_whisper_model` split; both run in `setup_models` |
| `yulu/scripts/provision/registry.py` | `_model_present` combines whisper+diarization; still 6 steps | ✓ VERIFIED | `_diarization_models_present` (L205) + `_model_present` (L231); REGISTRY=6 (live-checked) |
| `yulu/scripts/capabilities/probes.py` | tri-state `probe_diarization`, daemon-interp import check | ✓ VERIFIED | L294; always `yulu-managed`; never raises |
| `yulu/scripts/doctor.py` | fold `probe_diarization` into `_host_capabilities` | ✓ VERIFIED | L263; appears in `--json` |
| `tests/test_diarize_backend.py` | lifecycle, config-select, ASR-isolation, Phase-9 contract | ✓ VERIFIED | 21 tests; substantive (fake sherpa module records construction + canned turns) |
| `tests/test_diarize_provision_probe.py` | provision idempotency + probe tri-state | ✓ VERIFIED | 8 tests; covers all (models×sherpa) combos + 6-step + apply-skip |
| `tests/test_diarize_integration.py` | opt-in real-clip + forced-offline smoke | ✓ VERIFIED | 2 tests; drives PRODUCTION backend in subprocess; both PASSED here |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| `__main__._build_diarize_backend` | `SherpaDiarizeBackend` | config-selected import | ✓ WIRED | Provider→backend; disabled/unknown→None (3 tests) |
| `app` | `diarize_backend` | `app.diarize_backend = _build_diarize_backend(cfg)` | ✓ WIRED | __main__.py:85; held OFF `STTRuntime.backends` |
| `_model_present` (models step) | `diarize.models_present` | shared single-source file check | ✓ WIRED | registry.py:221 imports the same `models_present` the probe uses |
| `doctor._host_capabilities` | `probe_diarization` | `report.capabilities["diarization"]` | ✓ WIRED | doctor.py:263; confirmed in `--json` |
| `SherpaDiarizeBackend.diarize` output | Phase-9 `speaker_merge.assign_speakers` | `SpeakerTurn.to_dict()` keys | ✓ WIRED | test_speaker_turn_dict_feeds_phase9_merge asserts `assign_speakers(turns=backend_output)` labels segments |
| ASR chain (`STTRuntime._engine_chain`) | diarize backend | **(must NOT connect)** | ✓ CORRECTLY ISOLATED | diarize key absent from dict; `transcribe(engine="diarize")`→`ValueError` (live + test) |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|--------------------|--------|
| `SherpaDiarizeBackend.diarize` | `turns` | real sherpa `sd.process(audio)` on local ONNX | Yes — 15 real turns / 3 speakers on the 60s clip (offline) | ✓ FLOWING |
| `probe_diarization` | `Capability` | `models_present()` + `probe_importable(daemon_python)` | Yes — real tri-state observed live (absent/unverified/usable) | ✓ FLOWING |
| `doctor --json` diarization | `capabilities["diarization"]` | `probe_diarization()` | Yes — real entry emitted | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Production backend diarizes a real clip offline | spike-venv run, `HF_HUB_OFFLINE=1`+dead proxy | warm_up 0.58s; 15 turns / 3 speakers; EXIT 0 | ✓ PASS |
| Opt-in integration suite | `pytest tests/test_diarize_integration.py -m integration` | 2 passed in 24.62s | ✓ PASS |
| CI-safe unit suite | `pytest tests/test_diarize_backend.py tests/test_diarize_provision_probe.py -q` | 29 passed in 0.19s | ✓ PASS |
| Probe ABSENT | `python3 probe_diarization()` (no models) | `yulu-managed / absent` | ✓ PASS |
| Probe USABLE | spike venv, models present, daemon_python→spike | `yulu-managed / usable; sherpa-onnx 1.13.2` | ✓ PASS |
| doctor JSON folds diarization | `doctor.py --json` → `host_capabilities.capabilities.diarization` | present, `yulu-managed` | ✓ PASS |
| registry is 6 steps | `len(REGISTRY)==6` | `['deps','audio','models','capabilities','daemons','ui']` | ✓ PASS |
| diarize.py imports without sherpa | `python3 -c import stt_daemon.backends.diarize` (3.14, no sherpa) | imported OK (lazy) | ✓ PASS |
| bash syntax | `bash -n setup_models.sh` | clean | ✓ PASS |
| py_compile | all 7 modified modules | clean | ✓ PASS |
| torch-free | `pip freeze` spike venv + static grep | no torch / no pyannote.audio | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| DIAR-01 | 10-PLAN | DiarizeBackend Protocol, config-selected, lifecycle, NOT in ASR dict, NOT CapabilityProvider | ✓ SATISFIED | Truth 1 |
| DIAR-02 | 10-PLAN | Default sherpa-onnx (pyannote-3.0 + cam++), no torch | ✓ SATISFIED | Truth 2 |
| DIAR-03 | 10-PLAN | seg+cam++ ONNX via `models` step, offline-by-default | ✓ SATISFIED | Truth 3 |
| DIAR-04 | 10-PLAN | tri-state `probe_diarization()`, provenance yulu-managed | ✓ SATISFIED | Truth 4 |
| DIAR-05 | 10-PLAN | `warm_up()` dummy pass amortizes cold-start | ✓ SATISFIED | Truth 5 |

### Gate Checks (task-mandated)

| Gate | Result | Evidence |
|------|--------|----------|
| ZERO `yulu/scripts/yulu_ui/**` files changed (D9) | ✓ PASS | `git diff --name-only ec9b7d5 HEAD \| grep yulu_ui` → no matches |
| NO `~/.config/yulu` / `~/.yulu` mutation (D10) | ✓ PASS | No such paths in git tree; `~/.config/yulu/models/diarization` does NOT exist after my test runs; no write-ops to runtime dirs in Phase-10 source; working tree clean |
| Full suite collects clean | ✓ PASS | 905 tests collected, 0 collection errors (SUMMARY: 904 pass + 1 skip = 905) |
| New tests = +31 | ✓ PASS | The 3 diarize files collect exactly 31 tests |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `provision/registry.py` | 112, 117 | `raise NotImplementedError` | ℹ️ Info | Legitimate `@abstractmethod` bodies on the pre-existing `Step` ABC — NOT a stub, NOT introduced by Phase 10 |

No blocker or warning anti-patterns. No debt markers (TBD/FIXME/XXX/HACK/PLACEHOLDER) in any Phase-10 file. No socket dispatch is intentionally out of scope (owned by Phase 13) and is documented in the SUMMARY's "Known Stubs: None" — the construction seam exists.

### Human Verification Required

None. All 5 criteria are programmatically verifiable and were verified directly in this lane
(including the real-clip forced-offline run executed by the verifier).

### Known Carry-Forward (NOT a Phase-10 gap)

- **Python-3.14 sherpa-onnx wheel resolution** — All real integration evidence ran on the spike venv
  (Python **3.10**, sherpa-onnx 1.13.2). Yulu's runtime venv is Python **3.14**, and `pip install
  sherpa-onnx` resolving a cp314 wheel into that venv is **UNVERIFIED**. This is **explicitly owned by
  Phase 15 / PORT-01** (REQUIREMENTS.md L50; ROADMAP Phase 15 criterion 1: "Python 3.14 wheel
  resolution confirmed or an isolated venv used"). None of the 5 Phase-10 criteria require the wheel
  to resolve into the 3.14 runtime venv — criteria 2/3 require only torch-free CPU operation +
  offline load, both verified. Correctly deferred, not a Phase-10 failure.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria (DIAR-01..05) are met and independently verified against the
actual codebase — including a real forced-offline diarization run on the production backend producing
15 turns / 3 speakers from local ONNX files with dead proxies (the local-first contract), all three
probe states observed live with `yulu-managed` provenance, the ASR-isolation invariant proven both by
test and by direct runtime inspection (`__mro__`, `issubclass`, `ValueError` on `engine="diarize"`),
and both mandated gates (zero `yulu_ui` changes, zero runtime mutation) confirmed clean.

---

_Verified: 2026-06-06_
_Verifier: Claude (gsd-verifier) — independent lane_
