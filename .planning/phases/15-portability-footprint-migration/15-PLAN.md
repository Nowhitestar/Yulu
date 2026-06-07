# Phase 15 — Portability, Footprint & Migration · PLAN

**Approach:** measure first (the load-bearing 3.14 verdict + the footprint numbers are *evidence* the wiring depends on), then wire the engine install behind the existing provisioning seam per the verdict, then document + test. Single-session, no sub-agents (scope is tight and verification-heavy).

## Task breakdown

### PORT-01 — resolve Python 3.14 + co-locate sherpa, no macOS coupling

1. **Empirical probe (one-off, recorded in SUMMARY, not CI).** Create a throwaway py3.14 venv (`/tmp/yulu-py314-sherpa` — NOT `~/.config/yulu`), `pip install sherpa-onnx`, import it, run a real diarization on `~/funasr-spike/clip_smoke_60s.wav` with `~/funasr-spike/sherpa-models/`. Record: does the cp314 wheel install + import + diarize on Python 3.14?
2. **Decide + wire.** If cp314 works → **co-locate**: add an idempotent `pip install sherpa-onnx` into the daemon interpreter (`$PYTHON_BIN`) inside `setup_models.sh`'s diarization step (gated on `diarization.enabled`); mirror the mlx-importability honesty contract. (Else → isolated venv mirroring the removed mlx pattern.) Code the install; do NOT run it against the real `~/.config/yulu`.
3. **Make `check()` engine-aware.** Extend `provision/registry.py::_diarization_models_present` to require the engine importable AND models present, so a re-run with models-on-disk-but-engine-missing still installs sherpa (idempotency at the step gate).
4. **Cross-platform guarantee.** Static guard test: the diarization source files carry no macOS-only tokens; the backend + pipeline import with no sherpa/macOS deps; the `DiarizeBackend` Protocol is the swappable seam (a portable non-sherpa impl satisfies it). Confirm the `yulu_platform` Linux/Windows stubs are unchanged (diarization is not one of those OS seams).

### PORT-02 — footprint/latency budget

5. **Measure on real clips** via the spike sherpa venv + `/usr/bin/time -l`: warm-up once, then diarize `clip_core_20min.wav` and `clip_long_78min.wav`; capture per-clip wall-clock + RTF + peak RSS. (Run the measurement on the 3.14 throwaway venv too, so the *shipped* runtime's footprint is what's recorded.)
6. **Record a regression BUDGET** (documented thresholds with headroom over the measured numbers) in 15-SUMMARY, so diarization can't silently degrade the pipeline. Confirm (by reading `transcribe.py`) the diarize stage runs post-recording, off the realtime critical path.

### PORT-03 — migration + config

7. **Upgrade provisions diarization.** Confirm `setup.sh --upgrade` re-runs `setup_models.sh` (→ now installs engine + downloads ONNX, both idempotent). No new migrate step needed — the transactional `yulu migrate` already guarantees no-data-loss; the `models` re-provision rides `setup --upgrade`.
8. **Config block.** Add `transcription.diarization.*` to `config.example.json` (enabled=false default, provider=sherpa-onnx, seg_model/emb_model overrides, num_speakers/threshold knobs) with an inline `note` per the repo convention.

### Tests + artifacts

9. **Tests:** provisioning engine-install idempotency (bash, real-function-driven with a fake `$PYTHON_BIN`); registry `check()` engine-aware; migration re-provision idempotent + no-data-loss; config schema; cross-platform no-coupling + import-anywhere.
10. **`make pytest`** — confirm zero regressions vs 995/1.
11. **Artifacts:** 15-CONTEXT / 15-PLAN / 15-SUMMARY; update STATE.md + ROADMAP.md.

## Acceptance mapping

| Criterion | Met by |
|---|---|
| PORT-01 wheels+models behind abstraction, no macOS code, 3.14 confirmed-or-isolated | tasks 1–4 |
| PORT-02 per-meeting wall-clock + peak RAM vs budget, off critical path | tasks 5–6 |
| PORT-03 upgrade re-provisions sherpa+ONNX, no data loss; no-sidecar → no labels | tasks 7–8 + migration test |

## Risks / decisions

- **If cp314 fails** (didn't): fall back to an isolated `~/.config/yulu/venv-diarization` mirroring the old mlx venv, point the daemon's diarize import at it. Documented as the contingency.
- **O(n²) clustering tail on the 78-min clip** (spike-001 caveat): the budget accounts for a super-linear tail; the measurement on the real long clip is what sets the threshold.
- **Test interpreter has no sherpa:** the registry `check()` engine gate flips existing model-file tests; updated to pin the gate so the model-file logic stays isolated, with dedicated engine-gate tests added.
