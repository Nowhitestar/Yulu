# Phase 15 — Portability, Footprint & Migration · CONTEXT

**Milestone:** v0.6 Speaker Diarization · **Phase:** 15 (the last non-gated phase) · **Date:** 2026-06-07

## Goal (from ROADMAP)

Close the milestone's cross-platform mandate and protect existing users:

- **PORT-01** — sherpa-onnx wheels + ONNX models resolve behind the platform abstraction with **no macOS-specific code** (macOS impl now; non-macOS verified/stubbed per the v0.5 pattern; **Python 3.14 wheel resolution confirmed or an isolated venv used**).
- **PORT-02** — per-meeting added wall-clock + peak RAM measured on real clips against an explicit **regression budget**; diarization stays **off the realtime critical path**.
- **PORT-03** — an existing v0.5.x install gains diarization through the existing `yulu migrate` / `setup --upgrade` path (the `models` step re-provisions sherpa + ONNX) with **no data loss**; recordings without `.speakers.json` simply show no labels until re-diarized.

## The standing OPEN item this phase resolves

From STATE.md (carried since Phase 10): *"sherpa cp314 wheel resolution into Yulu's 3.14 runtime venv (PORT-01) — built+tested on the 3.10 spike venv only."* Everything diarization-related so far (Phases 10/13 integration smokes) ran on `~/funasr-spike/venv-sherpa` which is **Python 3.10.19**. Yulu's actual runtime interpreter is **Python 3.14.3** (system `python3` == `/opt/homebrew/bin/python3`; the stt_daemon plist runs `__PYTHON__ -m stt_daemon` where `__PYTHON__` resolves to that interpreter). The cp314 wheel's resolution + import + diarize on 3.14 was **never empirically verified** — that is the load-bearing unknown PORT-01 must close before the engine can ship co-located in the runtime interpreter.

## Key facts established by reading the codebase

- **No Yulu-managed venv exists (v0.5 D-02).** The monolith's `~/.config/yulu/venv-mlx-whisper` was *removed*; the daemon now runs as the host **system python3**, and mlx-whisper is "reuse-or-advise" (verify-importable-from-the-daemon-interpreter, never install). `venv-mlx-whisper` survives ONLY as a *legacy marker* that `migrate/detect.py` flags for cleanup. → The natural sherpa install target is the **same system python3 the daemon uses**, mirroring the mlx-importability contract — IF cp314 works on it.
- **Provisioning seam.** `provision/registry.py` wraps the six `setup_*.sh` 1:1; the `models` step (`setup_models.sh`) already owns the **diarization ONNX download** (Phase 10), gated on `transcription.diarization.enabled`, with a read-only `check()` (`_diarization_models_present`). Adding the engine install here keeps the step count at six (diarization extends `models`, no 7th step).
- **Upgrade path.** `yulu update` → `setup.sh --upgrade` → re-runs `setup_models.sh` (line 928). `yulu migrate` handles the *transactional config/data corrections* (drop dead mlx.python, route recording dir, schema stamp) with backup-first no-data-loss; it does NOT re-run provisioning. So PORT-03's "models step re-provisions sherpa + ONNX on upgrade" rides `setup --upgrade`, while the no-data-loss guarantee rides the existing Phase-7 transactional `migrate` path.
- **Platform abstraction (`yulu_platform/`).** ABCs for `DaemonManager` / `PathResolver` / `PermissionModel` / `DependencyManager`; macOS impls present, Linux/Windows arms are instantiable `NotImplementedError` stubs (v2 XPLAT-01). **Diarization is NOT one of these seams** — it is pure Python + onnxruntime with cross-platform wheels, so it needs no OS arm; the portability guarantee is "no macOS coupling in the diarization source," enforced statically.
- **Footprint was never measured.** Spike 002 only timed the 20-min *merge*; the diarize stage's per-meeting wall-clock + peak RAM on real clips is unmeasured. The diarize stage runs **post-recording** in `transcribe.py` (after the plain transcript is persisted), so it is already off the realtime caption path; PORT-02 must measure the added cost and set a budget.
- **`config.example.json` gap.** Authoritative schema reference still lacks the `transcription.diarization.*` block (flagged as Phase-13 carry-forward). PORT-03 adds it with inline `note` docs.

## Constraints (hard)

- ⚠ **UI gate:** no `yulu/scripts/yulu_ui/**` edits (Phase 14 is gated/LAST).
- Do **not** mutate Yulu's REAL runtime venv or `~/.yulu` / `~/.config/yulu` — the 3.14 probe uses a **throwaway venv** (`/tmp/yulu-py314-sherpa`); the engine-install step is *coded* but executed only against hermetic test HOMEs.
- Atomic Conventional Commits (`feat(provision):`, `feat(diarize):`, `test(...)`, `docs(...)`); don't push.
- `make pytest` must stay green vs the **995 passed / 1 skipped** baseline (zero regressions).
- The 3.14-install probe is a **one-off measurement** recorded in 15-SUMMARY — NOT a CI test (CI has no sherpa).

## Inputs read

ROADMAP "Phase 15"; STATE run log + blockers; research SUMMARY + spike 002 REPORT (footprint context, RTF ~0.17, sherpa 131 MB venv / 33 MB models); `setup_models.sh`, `provision/registry.py` (Phase-10 provisioning); `stt_daemon/diarize_pipeline.py` + `backends/diarize.py` (Phase-13 pipeline whose footprint is measured); `migrate/` + `migrate/cli.py` + `migrate/apply.py` (Phase-7 transactional path); `yulu_platform/` (v0.5 ABCs + stubs); `config.example.json`; `setup.sh` / `setup_capabilities.sh` (mlx reuse-or-advise pattern); `capabilities/probes.py::probe_diarization`.
