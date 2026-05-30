---
phase: 04-settings-onboarding-surface
plan: 01
subsystem: api
tags: [trpc, capabilities, doctor, host-capabilities, model-selector, zod, vitest, pytest, subprocess, shell-out]

# Dependency graph
requires:
  - phase: 03-host-capability-detection-spine
    provides: "doctor.py --json host_capabilities section (HostCapabilityReport: schema_version + tri-state + provenance); capabilities/probes.py scan_models() + _model_roots() allowlist this plan extends additively"
  - phase: 01-build-foundation
    provides: "Canonical daemon-interpreter resolution discipline (PYTHON_BIN/which python3); doctor's llm.command stays resolved-not-executed (T-03-01)"
provides:
  - "capabilities tRPC router (registered in _app.ts): host_capabilities query (shells doctor.py --json) + detected_models query (per-model name/path/size)"
  - "host_capabilities degrades to a TYPED { error, schema_version, capabilities:{} } shape — never throws, so a doctor failure can't blank the settings page (SET-01)"
  - "list_models() in capabilities/probes.py — additive sibling to scan_models returning per-model {name, path, size} for the UI pick-list (SET-04 data source)"
affects: [04-02-capabilities-section, 04-03-transcription-model-selector, 04-04-onboarding, phase-05-reuse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "tRPC router that shells ONLY Yulu's own python (doctor.py / list_models), never a user-configured command — T-04-EX trust boundary"
    - "Subprocess spawn with 10s timeout + SIGKILL so a hung/slow doctor never blocks or blanks the UI — T-04-DOS"
    - "Degrade-to-typed-shape (never throw) mirroring doctor's Python never-raise contract, so the UI always gets a renderable object"
    - "Additive-only extension of a frozen contract: list_models() is a sibling to scan_models — scan_models / _model_roots / report shape byte-for-byte unchanged"
    - "Detection stays in Python (one-way layer dependency capabilities/ -> UI): the router runs list_models() over a -c one-liner, never re-globs model roots in TypeScript"

key-files:
  created:
    - "yulu/scripts/yulu_ui/src/routers/capabilities.ts — capabilities router (host_capabilities + detected_models)"
    - "yulu/scripts/yulu_ui/tests/routers/capabilities.test.ts — 6 Vitest tests (happy/typed-error/models/trust-boundary)"
    - "tests/test_list_models.py — 5 pytest tests (name/path/size, dedupe, never-raise, path-bounding)"
  modified:
    - "yulu/scripts/capabilities/probes.py — added list_models() sibling after scan_models (additive only)"
    - "yulu/scripts/yulu_ui/src/routers/_app.ts — registered capabilities: capabilitiesRouter"

key-decisions:
  - "Placed test_list_models.py at repo-root tests/ (project convention; make pytest = `pytest tests`), NOT the plan's yulu/scripts/tests/ path which CI would never run (deviation Rule 3)"
  - "Resolved python3 as bare interpreter + PYTHONPATH=scriptDir (matching search.ts/integrations.ts), no venv hardcode — doctor.py is stdlib-only so the bare interpreter is correct"
  - "host_capabilities schema uses Zod .passthrough() on capability entries so new Phase 3 capability names flow through untouched (forward-compatible with the frozen report)"
  - "detected_models reads list_models() via a python -c one-liner (PYTHONPATH=scriptDir) rather than parsing doctor's aggregate models capability — keeps detection in Python and gives the selector real per-model entries"

patterns-established:
  - "Capabilities-as-data-spine: a single tRPC router is the only UI entry to the Phase 3 report; Wave 2 plans (04-02/03/04) consume it, none re-shell doctor"
  - "Comment documents the forbidden pattern (config.llm.command) for auditability while the code never references it — grep gate verified comment-only"

requirements-completed: [SET-01, SET-04]

# Metrics
duration: 13min
completed: 2026-05-30
---

# Phase 4 Plan 01: Capabilities tRPC Router + list_models() Helper Summary

**New `capabilities` tRPC router that shells `doctor.py --json` for the Phase 3 `host_capabilities` report (typed-error degrade, 10s timeout, never throws) plus an additive `list_models()` Python helper giving the model selector real per-model name/path/size — the data spine all Wave-2 Phase 4 plans consume.**

## Performance

- **Duration:** ~13 min (implementation commit span; ~25 min incl. context reads + full test suites)
- **Started:** 2026-05-30T16:19:13+08:00
- **Completed:** 2026-05-30T16:32:09+08:00
- **Tasks:** 2 (both TDD)
- **Files modified:** 5 (3 created, 2 modified)

## Accomplishments
- `capabilities.host_capabilities` tRPC query shells `python3 doctor.py --json` and returns the Phase 3 `host_capabilities` section; on non-zero exit / non-JSON / missing key it resolves a typed `{ error, schema_version: 1, capabilities: {} }` — the settings page can never blank on a doctor failure (SET-01).
- `capabilities.detected_models` query exposes per-model `{name, path, size}` sourced from Python `list_models()`, so the Wave-2 model selector (04-03) has real, selectable options (SET-04 data half).
- `list_models()` added to `capabilities/probes.py` as a strict additive sibling to `scan_models` — same fixed `_model_roots()` allowlist, same six-glob set, same resolve-dedupe, never-raise → `[]`. `scan_models` / `_model_roots` / the frozen `HostCapabilityReport` shape are byte-for-byte unchanged (Phase 3 contract preserved).
- Trust boundary enforced and proven: the router spawns ONLY Yulu's own `doctor.py` / `list_models` — never a value from `config.llm.command` or `config.transcription.cloud_command` (T-04-EX); doctor's own `llm.command` stays resolved-not-executed (Phase 3 T-03-01 untouched).

## Task Commits

Each task was TDD (RED test → GREEN feat), committed atomically:

1. **Task 1: list_models() Python helper** — `f88e87c` (test, RED) → `20593d4` (feat, GREEN)
2. **Task 2: capabilities tRPC router** — `623b7d2` (test, RED) → `e6b175a` (feat, GREEN)

_No REFACTOR commits needed — both implementations mirror existing analogs (scan_models / integrations.ts) and were clean on first GREEN._

## Files Created/Modified
- `yulu/scripts/yulu_ui/src/routers/capabilities.ts` (new) — `capabilitiesRouter` with `host_capabilities` + `detected_models` queries; Zod-typed; 10s spawn timeout + SIGKILL; degrades to typed shapes, never throws.
- `yulu/scripts/yulu_ui/src/routers/_app.ts` (modified) — registered `capabilities: capabilitiesRouter` (import + appRouter entry).
- `yulu/scripts/capabilities/probes.py` (modified) — added `list_models()` immediately after `scan_models` (additive; reuses `_model_roots()` + identical glob/dedupe discipline).
- `yulu/scripts/yulu_ui/tests/routers/capabilities.test.ts` (new) — 6 Vitest tests: happy path, typed-error (non-zero / non-JSON / missing key), detected_models success + `[]` degrade, and the trust-boundary assertion (only python doctor.py / list_models spawned).
- `tests/test_list_models.py` (new) — 5 pytest tests: per-model name/path/size, overlapping-glob dedupe, never-raise → `[]` (no roots / OSError), and path-bounding (file outside `_model_roots()` never listed).

## Decisions Made
- **Test location corrected to repo-root `tests/`** (see Deviations) — the project's `make pytest` target is `pytest tests`, and all 660+ existing Python tests (including `tests/test_host_capability_probes.py`, which tests these exact probes) live there.
- **python3 resolution = bare interpreter + `PYTHONPATH=scriptDir`** (matching `search.ts` / `integrations.ts`), not a venv path — doctor.py is stdlib-only, so the bare `python3` is the honest, correct interpreter (the plan explicitly directed: do NOT hardcode a venv).
- **Zod `.passthrough()` on capability entries** so the router stays forward-compatible with the frozen Phase 3 report: new capability names (e.g. a future provider's keys) flow through without a schema bump.
- **`detected_models` runs `list_models()` directly** (read-only `python -c` one-liner) rather than re-deriving models from doctor's aggregate `models` capability — keeps detection in Python (one-way layer dependency) and yields real per-file entries the selector needs.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Corrected the Python test path from `yulu/scripts/tests/` to repo-root `tests/`**
- **Found during:** Task 1 (list_models() helper)
- **Issue:** The plan's `files_modified` and Task 1 `<files>` specified `yulu/scripts/tests/test_list_models.py`. That directory does not exist; the project's entire Python test suite (660+ tests) lives in repo-root `tests/`, and the `Makefile` `pytest` target is `pytest tests -q`. A test placed at `yulu/scripts/tests/` would never be collected by `make pytest` or CI — silently defeating the test and the SET-04 acceptance gate.
- **Fix:** Created the test at `tests/test_list_models.py`, mirroring the exact import + monkeypatch style of the sibling `tests/test_host_capability_probes.py` (`sys.path.insert(0, ROOT/"yulu"/"scripts")`; `monkeypatch.setattr(probes, "_model_roots", ...)`).
- **Files modified:** `tests/test_list_models.py`
- **Verification:** `python3 -m pytest tests/test_list_models.py -x` → 5 passed; full `pytest tests` → 662 passed, 1 skipped (collected by the standard runner).
- **Committed in:** `f88e87c` (RED) / `20593d4` (GREEN)

---

**Total deviations:** 1 auto-fixed (1 blocking).
**Impact on plan:** Necessary for the test to actually run under CI/`make pytest`; no scope change. All plan acceptance criteria otherwise met verbatim (the criteria reference `yulu/scripts/capabilities/probes.py` and `_app.ts` paths, which were unchanged).

## Issues Encountered
- The acceptance-criteria grep `grep -nE "config\.(transcription\.cloud_command|llm\.command)"` matched the router file — but the match was the **documentation comment** that names the forbidden pattern for auditability, not executable code. Verified clean by re-running with comment lines stripped (`grep -vE "^\s*//"`): zero code references, and the router never reads `ctx.config` at all. T-04-EX satisfied.

## User Setup Required
None — no new packages (stdlib Python + existing tRPC/Zod/Vitest only, T-04-SC), no external service configuration.

## Next Phase Readiness
- **Wave 2 unblocked.** The `capabilities` router is the data spine for 04-02 (CapabilitiesSection rendering provenance/tri-state), 04-03 (TranscriptionSection model selector consuming `detected_models`), and 04-04 (onboarding reading live permission status from `host_capabilities`). All three can now call `trpc.capabilities.host_capabilities` / `trpc.capabilities.detected_models`.
- **Verification green:** `npm run typecheck` (strict, 0 errors), full Vitest (317 passed incl. 6 new), full pytest (662 passed, 1 skipped incl. 5 new).
- No blockers.

## Self-Check: PASSED

---
*Phase: 04-settings-onboarding-surface*
*Completed: 2026-05-30*
