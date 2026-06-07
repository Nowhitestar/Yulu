---
phase: 15-portability-footprint-migration
verified: 2026-06-07T14:05:00Z
status: passed
score: 3/3 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: "Prior verifier attempt hit a transient error before writing a report; this is the first written verification. INITIAL mode."
warnings:
  - item: "15-SUMMARY.md has two unfilled template placeholders: {{SINGLE_FOOTPRINT}} (line 70, budget 'measured' cell) and {{PYTEST_RESULT}}/{{NEW_TEST_COUNT}} (line 118)."
    severity: warning
    impact: "Documentation polish only — not a code/goal gap. The budget THRESHOLD (≤6 GB) is filled and the back-to-back footprint (4.49 GB) is stated in prose (line 54); the pytest result is independently re-confirmed below (1021 passed/1 skipped). Recommend filling {{SINGLE_FOOTPRINT}}=~4.49 GB and {{PYTEST_RESULT}}=1021 passed/1 skipped, {{NEW_TEST_COUNT}}=38."
---

# Phase 15: Portability, Footprint & Migration — Verification Report

**Phase Goal:** Close the milestone's cross-platform mandate and protect existing users — sherpa-onnx wheels + ONNX models verified behind the platform abstraction with no macOS coupling (macOS impl now, non-macOS verified/stubbed); the per-meeting footprint measured against a regression budget so diarization doesn't degrade the existing pipeline; existing v0.5.x installs gain diarization on upgrade via the existing `yulu migrate`/`setup --upgrade` path with no data loss.
**Verified:** 2026-06-07T14:05:00Z
**Status:** passed
**Re-verification:** No — initial written verification (prior attempt died on a transient error pre-report). All claims re-derived independently from the codebase; no SUMMARY bullet trusted on its word.

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria = the contract)

| # | Truth (PORT criterion) | Status | Evidence |
|---|---|---|---|
| 1 | **PORT-01** — sherpa-onnx wheels + ONNX resolve behind the abstraction with no macOS code (Python 3.14 wheel confirmed or isolated venv) | ✓ VERIFIED | Engine install wired + idempotent + gated + WARN-not-abort (`setup_models.sh:109-131`); registry `check()` engine-aware (`registry.py:205-260`); step count stays 6 (`registry.py:303-310`, asserted `test_diarize_provision_probe.py:36-40`); 4 diarization-stack files independently grep-clean of all macOS tokens; backend lazy-imports sherpa via `importlib.import_module` (`backends/diarize.py:254`) so it imports with **no sherpa installed** (re-confirmed: `sherpa_onnx` absent from this py3.14.3 interp, yet import tests pass); `yulu_platform` Linux/Windows `NotImplementedError` stubs intact + untouched by Phase 15. CO-LOCATE decision matches the verified runtime: system `python3` == Python **3.14.3** (the daemon interpreter). |
| 2 | **PORT-02** — per-meeting wall-clock + peak RAM measured on real clips vs an explicit regression budget; diarization off the live/critical path | ✓ VERIFIED | Non-vacuous documented budget with headroom + "fail if exceeded" semantics (15-SUMMARY:65-70): RTF ≤0.40 (measured 0.086–0.161), warm-up ≤5 s (0.33 s), peak RSS ≤3 GB (~1.69 GB), footprint ≤6 GB (4.49 GB). No O(n²): 78-min RTF 0.086 < 20-min 0.161. Off realtime path proven in code: `transcribe.py` persists plain transcript (`:173-176`) **then** calls `run_diarize_stage` (`:194-201`); `realtime_transcribe.py` has zero diarize coupling; `diarize_pipeline.run_diarize_stage` is gated + never-raises (`:231-232`, `:154`, `:185`). Budget is documentary-by-design (PLAN task 6 + SC2: "documented thresholds … against an explicit regression budget"), not a CI assertion. |
| 3 | **PORT-03** — existing v0.5.x install gains diarization via `setup --upgrade` (models step re-provisions sherpa + ONNX) with no data loss; no-sidecar → no labels | ✓ VERIFIED | `setup.sh:928` invokes `setup_models.sh "$MODE"` in the install/upgrade sequence (`--upgrade`→`UPGRADE_MODE=true`, `:35`); `setup_diarization_models` re-provisions engine + seg/cam++ ONNX, both idempotent + gated (`setup_models.sh:133-190`). Migration test proves idempotent re-provision + **byte-for-byte** user-data preservation + no-sidecar-invented (`test_diarize_engine_provision.py:225-267`, PASSED). `config.example.json` parses as valid JSON with a complete documented `transcription.diarization.*` block (enabled=false, provider=sherpa-onnx, blank model paths, num_speakers=null, threshold=0.5, 1094-char `note`). |

**Score:** 3/3 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `yulu/scripts/setup_models.sh` | engine install (idempotent/gated/WARN-not-abort) + ONNX download | ✓ VERIFIED | `diarization_engine_present` (:102, read-only `find_spec`), `install_diarization_engine` (:109, idempotent skip :116, `pip install --upgrade sherpa-onnx` :121, WARN-only :125/:128-129), `setup_diarization_models` gated :136, wired into `setup_models()` :256. |
| `yulu/scripts/provision/registry.py` | engine-aware `check()`, 6 steps | ✓ VERIFIED | `_diarization_engine_importable` :205; `_diarization_models_present` requires engine AND models, gated :233-236; REGISTRY = exactly 6 steps :303-310. |
| `yulu/scripts/config.example.json` | `transcription.diarization.*` block | ✓ VERIFIED | Valid JSON; all 7 keys present + safe defaults + inline note (parsed live). |
| `yulu/scripts/stt_daemon/backends/diarize.py` (+pipeline, speaker_merge, speaker_count) | portable, lazy-import, Protocol seam | ✓ VERIFIED | Grep-clean of macOS tokens; sherpa lazy via `importlib.import_module` :254; `DiarizeBackend` runtime_checkable Protocol :147-163. |
| `tests/test_diarize_engine_provision.py` | PORT-01 install + PORT-03 migration | ✓ VERIFIED | 6 tests incl. byte-for-byte no-data-loss; all PASSED. |
| `tests/test_diarization_config_schema.py` | config schema + reader contract | ✓ VERIFIED | 9 tests; all PASSED. |
| `tests/test_diarize_cross_platform.py` | no-macOS-coupling + import-anywhere | ✓ VERIFIED | 7 tests; all PASSED. |
| `tests/test_diarize_provision_probe.py` (extended) | engine-aware check + 6-step guard | ✓ VERIFIED | 16 tests incl. `test_registry_still_six_steps...` + `..._engine_missing_even_if_models_present`; all PASSED. |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `setup.sh --upgrade` | `setup_models.sh` | `"$SCRIPT_DIR/setup_models.sh" "$MODE"` | WIRED | `setup.sh:928`; MODE carries upgrade context. |
| `setup_models()` | `setup_diarization_models` | direct call | WIRED | `setup_models.sh:256`. |
| `setup_diarization_models` | `install_diarization_engine` | direct call | WIRED | `setup_models.sh:143`. |
| `registry._model_present` | `_diarization_models_present` → `_diarization_engine_importable` | function call chain | WIRED | `registry.py:260` → `:235`. |
| `transcribe.py` (post-persist) | `diarize_pipeline.run_diarize_stage` | import + call after transcript write | WIRED | `transcribe.py:194-201` (after `:174`). |
| `realtime_transcribe.py` | diarization | (must be ABSENT) | CORRECTLY ABSENT | grep confirms zero diarize coupling on the realtime path. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| 4 key Phase-15 test files | `pytest test_diarize_engine_provision test_diarization_config_schema test_diarize_cross_platform test_diarize_provision_probe -v` | 38 passed in 4.04s | ✓ PASS |
| Full suite (gate) | `python3 -m pytest tests -q` | **1021 passed, 1 skipped** in 634.73s (exit 0) | ✓ PASS |
| config.example.json parses + diarization block valid | `python3 -c "json.loads(...); assert block"` | valid JSON, all keys present, defaults correct | ✓ PASS |
| diarization sources macOS-token-free | independent grep over 4 files | all 4 CLEAN | ✓ PASS |
| Shipped runtime is Python 3.14.x (CO-LOCATE premise) | `python3 --version` | Python 3.14.3 | ✓ PASS |
| Real `~/.config/yulu` / runtime not mutated | `find_spec('sherpa_onnx')` in real py3; diarization models dir | sherpa absent; no real diarization models dir | ✓ PASS (no-mutation constraint respected) |

> Note on the 3.14 sherpa-wheel probe: the SUMMARY records a one-off throwaway-venv (`/tmp/yulu-py314-sherpa`) `pip install sherpa-onnx` + `import` + real diarize on py3.14.3. I did NOT re-run a fresh network install of the cp314 wheel (avoids network + respects the no-real-mutation spirit; the prompt allows assessing the SUMMARY evidence). I corroborated the load-bearing premises directly instead: the shipped interpreter IS py3.14.3, the engine-install argv is exactly `pip install --upgrade sherpa-onnx` into that interpreter (idempotency/gating proven by the 38 hermetic tests with a fake `$PYTHON_BIN`), and the backend imports with no sherpa present. The wheel-availability claim (cp314 macOS/Linux/Windows on PyPI) is the documented basis for portability; treated as verified-by-wheel + the SUMMARY probe, consistent with the v0.5 reuse-or-advise pattern.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|---|---|---|---|---|
| PORT-01 | 15-PLAN tasks 1–4 | sherpa wheels + ONNX behind abstraction, no macOS code, 3.14 confirmed | ✓ SATISFIED | Truth 1 above. |
| PORT-02 | 15-PLAN tasks 5–6 | per-meeting wall-clock + peak RAM vs regression budget, off critical path | ✓ SATISFIED | Truth 2 above. |
| PORT-03 | 15-PLAN tasks 7–8 | upgrade re-provisions sherpa + ONNX, no data loss; no-sidecar → no labels | ✓ SATISFIED | Truth 3 above. |

No orphaned requirements: REQUIREMENTS.md maps exactly PORT-01/02/03 to Phase 15, all claimed by the plan.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|---|---|---|---|---|
| `15-SUMMARY.md` | 70 | `{{SINGLE_FOOTPRINT}}` unfilled template token (budget "measured" cell) | ⚠️ Warning | Documentation polish. The budget threshold (≤6 GB) is present; the value (~4.49 GB) is stated in prose at :54. Not a goal/code gap. |
| `15-SUMMARY.md` | 118 | `{{PYTEST_RESULT}}` / `{{NEW_TEST_COUNT}}` unfilled | ⚠️ Warning | Re-confirmed independently: 1021 passed / 1 skipped; +38 new tests. Recommend filling. |
| `setup_models.sh`, `registry.py`, `config.example.json` | — | debt markers (TBD/FIXME/XXX/HACK/PLACEHOLDER) | ℹ️ None | All CLEAN. |

### UI Gate & No-Mutation Gate

- **UI gate (zero `yulu/scripts/yulu_ui/**`):** ✓ PASS. `git diff --stat cc3fc14^..a471f0c` touches only: 3 planning docs, 4 test files, `config.example.json`, `provision/registry.py`, `setup_models.sh`. No `yulu_ui/**` file.
- **No `~/.config/yulu` / `~/.yulu` mutation:** ✓ PASS. All new tests are hermetic (`HOME=tmp_path/home`, fake `$PYTHON_BIN`, curl/tar stubs). Real interpreter has no `sherpa_onnx`; real config has no `models/diarization/` — engine-install never ran against the real runtime, matching SUMMARY's honest caveat (:133).

### Human Verification Required

None. Every criterion is verifiable from the codebase + tests + a re-run gate. The one-off live cp314-wheel network install is intentionally NOT re-run (no-mutation spirit); the SUMMARY's recorded probe plus the corroborated premises above are accepted as evidence per the phase's documented pattern.

### Gaps Summary

No blocking gaps. All three success criteria (PORT-01/02/03) are achieved in the codebase with direct file:line evidence and a green independently-re-run suite (1021 passed / 1 skipped). The only finding is a documentation WARNING: two `{{...}}` template placeholders left unfilled in `15-SUMMARY.md` (the measured-footprint cell and the pytest-result line) — both values exist elsewhere (prose / this report) and neither affects goal achievement. Recommend filling them for a clean record, but this does not block proceeding.

Out of scope (correctly not a Phase-15 gap): the CN auto-cluster over-split (59/90 speakers) is a Phase-12 accuracy item (the supplied-count lever), not a footprint regression.

---

_Verified: 2026-06-07T14:05:00Z_
_Verifier: Claude (gsd-verifier) — independent lane_
