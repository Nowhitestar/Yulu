---
phase: 10
plan: 10
subsystem: diarization
tags: [diarize, sherpa-onnx, provisioning, capability-probe, stt-daemon]
requires: [9]
provides: [DiarizeBackend, SherpaDiarizeBackend, probe_diarization, diarization-models-step]
affects: [stt_daemon, provision, capabilities, doctor]
tech-stack:
  added: ["sherpa-onnx (dev/spike venv only — NOT yet in Yulu's 3.14 runtime venv)"]
  patterns: ["resident-model backend lifecycle (warm_up/is_ready/release)", "tri-state yulu-managed probe", "idempotent models-step extension"]
key-files:
  created:
    - yulu/scripts/stt_daemon/backends/diarize.py
    - tests/test_diarize_backend.py
    - tests/test_diarize_provision_probe.py
    - tests/test_diarize_integration.py
  modified:
    - yulu/scripts/stt_daemon/__main__.py
    - yulu/scripts/stt_daemon/config.py
    - yulu/scripts/stt_daemon/backends/__init__.py
    - yulu/scripts/setup_models.sh
    - yulu/scripts/provision/registry.py
    - yulu/scripts/capabilities/probes.py
    - yulu/scripts/doctor.py
decisions:
  - "DiarizeBackend is a config-selected Protocol held OFF the ASR runtime dict; NOT a CapabilityProvider."
  - "Diarization extends the existing `models` provision step (no 7th step); gated on config.enabled."
  - "probe_diarization is always yulu-managed, tri-state (usable/present-but-unverified/absent)."
  - "Coded against the sherpa_onnx import; real 3.14-venv wheel co-location deferred to Phase 15/PORT-01."
metrics:
  duration_min: 30
  tasks: 6
  files: 11
  tests_added: 31
  completed: 2026-06-06
---

# Phase 10 Plan 10: Diarize Backend + Provisioning + Capability Probe Summary

Resident `SherpaDiarizeBackend` (pyannote-3.0 seg + cam++ embedding, torch-free ONNX) that mirrors
the STT lifecycle but is deliberately held out of the ASR fallback chain, fed by offline-by-default
ONNX models provisioned idempotently through the existing `models` step, surfaced as a tri-state
`yulu-managed` `probe_diarization()` in doctor — all 5 ROADMAP criteria met and verified end-to-end
on a real 60s clip with dead proxies.

## Test command + counts

- **Command:** `make pytest` → `python3 -m pytest tests -q` (from repo root)
- **Full suite:** **904 passed, 1 skipped** in 535.78s (baseline before this plan: 873 passed,
  1 skipped → **+31 new tests, zero regressions**; the 1 skip is pre-existing and unrelated).
- **New tests (31):**
  - `tests/test_diarize_backend.py` — 21 (backend lifecycle, config selection, ASR-isolation
    invariant, SpeakerTurn→Phase-9 contract, model resolution; `sherpa_onnx` mocked → CI-safe)
  - `tests/test_diarize_provision_probe.py` — 8 (provision idempotency: `_model_present` combines
    whisper+diarization halves; registry stays 6 steps; `apply()` skip; probe tri-state × yulu-managed)
  - `tests/test_diarize_integration.py` — 2 (opt-in `integration`: real 60s-clip diarization +
    forced-offline; drives the production backend via the spike venv; **passed here**, skips cleanly
    where the spike models/clip are absent, e.g. CI)
- **Real opt-in integration evidence (this machine):** warm_up 0.66s; diarize on the 60s clip → 15
  turns, 3 speakers, all from local ONNX with `HF_HUB_OFFLINE=1` + dead `HTTPS_PROXY`/`HTTP_PROXY`.

## 5 success criteria → evidence mapping

| # | Criterion | Evidence |
|---|-----------|----------|
| 1 | `DiarizeBackend` Protocol, config-selected, mirrors STT lifecycle, NOT in ASR dict / NOT a CapabilityProvider | `backends/diarize.py` (`@runtime_checkable` Protocol + `SherpaDiarizeBackend`); `__main__._build_diarize_backend` (config-selected, separate from `_build_real_backends`); **`test_diarize_backend_is_not_in_asr_runtime_dict`** asserts the ASR dict has no diarize key, `STTRuntime._engine_chain` never yields a diarize engine, and `runtime.transcribe(engine="diarize")` raises `ValueError`; probe is a plain function returning a `Capability`, not a `CapabilityProvider` subclass |
| 2 | Default sherpa-onnx (pyannote-3.0 + cam++), torch-free CPU, turns on a real clip | `SherpaDiarizeBackend` config lifted verbatim from spike `sherpa_diar.py` (onnxruntime-only); **`test_diarize_integration.py::test_real_diarization_returns_sane_turns`** → 15 turns / 3 speakers on the 60s clip; unit `test_diarize_returns_speaker_turns` for the mocked mapping |
| 3 | Models (seg ~5.7 MB + cam++ ~27 MB) via the `models` step, zero-network offline load | `setup_models.sh::setup_diarization_models` (idempotent curl+extract into `models/diarization`, gated on config); `registry._model_present` now requires the diarization half (still **6 steps**); **`test_real_diarization_works_offline`** loads local ONNX with dead proxies + `HF_HUB_OFFLINE=1`; idempotency unit tests + a verified bash skip-when-present run |
| 4 | `doctor.py` tri-state `probe_diarization()`, provenance `yulu-managed` | `capabilities/probes.probe_diarization` (usable / present-but-unverified / absent), folded into `doctor._host_capabilities` as `capabilities["diarization"]` (appears in `--json`); **4 probe tests** cover every state + the always-`yulu-managed` invariant + never-raise; all three states demonstrated live (absent on bare runner, usable with real models + sherpa) |
| 5 | `warm_up()` dummy pass amortizes first-run cold-start | `SherpaDiarizeBackend.warm_up` builds the resident pipeline + runs a 1s silent `process()` (returns 0 turns, primes the ORT graph); **`test_warmup_loads_pipeline_and_runs_dummy_pass`** asserts the dummy pass fired; live: warm_up 0.66s, so the first real diarize isn't JIT-penalized |

## Deviations from Plan

None of Rules 1–4 triggered beyond small, in-scope refinements:

- **[Rule 3 - blocking]** `make pytest` applies **no marker filter**, so the opt-in integration
  tests are *collected* in the default run. Matched the existing repo convention
  (`test_e2e_stt_daemon.py`): `pytestmark = pytest.mark.integration` **plus** `@pytest.mark.skipif`
  guards on resource presence, so they run only where the spike models/clip exist and skip cleanly
  in CI. No new pytest config needed.
- **[Rule 3 - blocking]** The seg model ships as a `.tar.bz2`, not a bare `.onnx`. `setup_models.sh`
  now downloads the tarball, extracts `model.onnx` → `segmentation.onnx`, and prunes the rest —
  keeping the on-disk contract (`segmentation.onnx` + `campplus.onnx`) the backend/probe expect.
- **Refactor (no behavior change):** split the existing `setup_models()` whisper body into
  `setup_whisper_model()` so `setup_models()` cleanly runs both the (unchanged) whisper concern and
  the additive diarization concern despite the whisper logic's multiple early returns.

## Authentication gates

None — no auth/login/credentials involved.

## Known Stubs

None. The backend is fully wired (real sherpa API, real model loading); it is simply not yet
*dispatched* over the daemon socket — that wiring is **out of scope for Phase 10 by design** (the 5
criteria do not require socket dispatch) and is owned by Phase 13. The construction seam
(`app.diarize_backend`) exists so Phase 13 has a resident, warm-able backend to consume.

## Python-3.14 sherpa-wheel status / OPEN QUESTION (carry into Phase 15 / PORT-01)

- **Status:** Coded against the `sherpa_onnx` import per the hard constraint; **NOT** installed into
  Yulu's real runtime venv. Confirmed facts:
  - Yulu's runtime venv (`~/.config/yulu/venv-mlx-whisper`) is **Python 3.14.3**.
  - The working spike venv is **Python 3.10** with **sherpa-onnx 1.13.2** — i.e. all real
    integration evidence here ran on cp310, NOT cp314.
  - Research/STACK claims sherpa-onnx publishes cp37–cp314 wheels, but **cp314 resolution into
    Yulu's actual 3.14 venv remains UNVERIFIED** (the spike never used 3.14).
- **Open question for Phase 15/PORT-01:** does `pip install sherpa-onnx` resolve a cp314 wheel on
  Yulu's 3.14 venv? If yes → co-locate (no torch → ~131 MB footprint, shared venv is the default).
  If it conflicts → give diarization its own small isolated venv (the provision step already isolates
  envs). `setup_models.sh` provisions the *models*; the *wheel* install belongs to the
  `capabilities`/venv provisioning a later phase owns — Phase 10 deliberately did not touch the
  runtime venv.

## Other carry-forward notes

- **Phase 11 (eval):** the backend emits clean `SpeakerTurn`s and the integration harness already
  shows turns/speaker counts — a natural feed for the DER harness. Speaker indices are sparse/raw
  (e.g. `[0,4,7]`), which is expected cam++ cluster numbering; Phase-9 re-anchor + Phase-12 count
  strategy handle this.
- **Phase 12 (count strategy):** `diarize(num_speakers=...)` per-call override exists but currently
  rebuilds + mutates `self._sd` for that call (a subsequent auto call would reuse the override
  pipeline). The primary path Phase 13 uses is auto (`num_speakers=None`). When Phase 12 wires the
  calendar-attendee prior, give the override its own pipeline-cache keyed by count (or reset to the
  configured default after the call) so override and auto modes don't bleed.
- **Phase 13 (pipeline):** consume `app.diarize_backend` via a new `JobKind.DIARIZE` +
  `DiarizeRequest/Response` (background slot); the backend's `diarize()` already returns turns ready
  for `speaker_merge.assign_speakers(turns=...)`.
- **Config surface added:** `transcription.diarization.{enabled,provider,seg_model,emb_model,
  num_speakers,threshold}` (all optional, all defaulted; `enabled:false` by default → today's
  pipeline unchanged).

## Self-Check: PASSED
