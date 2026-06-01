---
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
plan: 01
subsystem: infra
tags: [provisioning, registry, subprocess, idempotency, dataclass, abc, stdlib, setup-sh]

# Dependency graph
requires:
  - phase: 01-build-foundation-setup-decomposition-signed-notarized-binaries
    provides: "the six decomposed, idempotent, mode-parameterized setup_*.sh concern scripts + lib/common.sh + test_setup_decomposition.py hermetic harness"
provides:
  - "provision/ package spine: Step ABC, StepResult{ok|skipped|error} frozen dataclass, ScriptStep wrapping one setup_*.sh 1:1 via subprocess"
  - "ordered REGISTRY of the six named steps (deps/audio/models/capabilities/daemons/ui) in setup.sh order"
  - "step_by_name fixed-table dispatch (untrusted name -> KeyError, never arbitrary path execution)"
  - "six read-only check() probes (filesystem / launchctl / config), each degrading to False (never raising)"
  - "the idempotency contract: apply() short-circuits to skipped when check() satisfied (foundation for 06-02 kill-at-step-N resume)"
affects: [06-02-state-ledger, 06-03-attestation-gate, 06-04-cli, 07-migration, 08-multi-agent]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Python check()/apply()/StepResult veneer WRAPPING idempotent bash bodies via argv-list subprocess (never porting logic)"
    - "Read-only probe callables injected into ScriptStep; probes degrade to False rather than raise"
    - "Fixed-table name dispatch (step_by_name) so an untrusted step name cannot reach an arbitrary script path"

key-files:
  created:
    - yulu/scripts/provision/registry.py
    - yulu/scripts/provision/__init__.py
    - tests/test_provision_registry.py
  modified: []

key-decisions:
  - "[06-01] StepResult is a frozen @dataclass {name, status, detail=''} mirroring release_installer.ReleaseAsset; status is exactly the three D-01 values ok|skipped|error (no enum — plain str matches the existing repo dataclass idiom and serializes cleanly into the future ledger)"
  - "[06-01] ScriptStep.check() wraps the injected probe in try/except -> False: a probe must never crash provisioning, and 'unknowable state' means 'run the idempotent script', not abort"
  - "[06-01] models probe treats engine==mlx as satisfied (weights fetched lazily on first transcription, so no on-disk file gates the step) and otherwise checks the configured transcription.local_model_path file"
  - "[06-01] ui probe is file-existence on yulu_ui/dist/server.js (hermetic-test-safe) rather than a /healthz curl — the plan explicitly allows either and file-existence needs no running server"
  - "[06-01] capabilities probe uses importlib.util.find_spec('mlx_whisper') (advisory/lenient, no heavy import) consistent with Phase-1 01-04's warn-not-fail mlx verification"
  - "[06-01] uv/uvx DEFER (D-07) recorded as a dedicated module-docstring section: host python3 is the locked interpreter, registry needs only subprocess+stdlib, adding uv is a new per-machine bootstrap dep + scope creep"

patterns-established:
  - "Wrap-don't-port: the registry drives the SAME six bash bodies both install callers run; zero step logic duplicated in Python (D-01/D-06)"
  - "Probe-then-apply idempotency: apply() calls check() first and returns skipped without spawning bash when already done"
  - "argv-list subprocess only (no shell=True); script path is a fixed REGISTRY entry under SCRIPTS_DIR, only the mode literal is variable (T-06-01)"

requirements-completed: [PROV-01, PROV-02]

# Metrics
duration: 11min
completed: 2026-05-30
---

# Phase 6 Plan 01: Provision Step Registry Summary

**Step ABC + frozen StepResult{ok|skipped|error} + ScriptStep wrapping each of the six Phase-1 `setup_*.sh` 1:1 via argv-list subprocess, assembled into an ordered REGISTRY with read-only `check()` probes that make `apply()` short-circuit to `skipped` when already done.**

## Performance

- **Duration:** ~11 min
- **Started:** 2026-05-30T19:50:57+08:00 (RED commit)
- **Completed:** 2026-05-30T12:01:27Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- `provision/registry.py` (270 lines): `Step` ABC (`check`/`apply`), `StepResult` frozen dataclass with the three D-01 statuses, and `ScriptStep` that wraps one `setup_*.sh` per step — running it via `subprocess.run(["bash", SCRIPTS_DIR/script, mode])` (argv list, no `shell=True`) and mapping returncode 0→`ok` / non-zero→`error` (stderr truncated to 500 chars), but short-circuiting to `skipped` when `check()` is already True.
- The ordered `REGISTRY` of the six named `ScriptStep`s in `setup.sh` order (deps → audio → models → capabilities → daemons → ui), each paired with a read-only probe; `step_by_name` dispatches against the fixed table and raises `KeyError` (listing valid names) on an unknown name.
- Six read-only `check()` probes (`_deps_ready`, `_audio_ready`, `_model_present`, `_mlx_importable`, `_launchagents_loaded`, `_ui_built`) that inspect filesystem / `launchctl` / config state and degrade to `False` (never raise) so a probe failure can never block provisioning.
- `provision/__init__.py` exporting `Step, StepResult, ScriptStep, REGISTRY, step_by_name` (mirrors `vocab/__init__.py`).
- Wave-0 test suite `tests/test_provision_registry.py` (245 lines, 11 tests): StepResult frozen + three-status, skip-without-spawning-bash, returncode→ok/error mapping, argv-list/no-shell assertion, six-step order + 1:1 script map, `step_by_name` known/unknown, plus one hermetic real-bash integration drive (reusing `test_setup_decomposition`'s no-op PATH shim) proving a second `apply()` returns `skipped`.
- uv/uvx evaluated and DEFERRED (D-07), recorded in the module docstring.

## Task Commits

Task 1 followed the TDD cycle (`tdd="true"`):

1. **Task 1 (RED): failing test for the registry contract** — `27c1d96` (test)
2. **Task 1 (GREEN): implement provision/registry.py + __init__.py** — `a1efa75` (feat)

Task 2's deliverable is the comprehensive Wave-0 test file. Its full scope (all six items in the plan's Task-2 `<action>`) was authored as the RED artifact in `27c1d96` and is green against the Task-1 implementation, so it carries no separate commit (committing a no-op change would be incorrect). The single test file `tests/test_provision_registry.py` satisfies both Task 1's RED gate and Task 2's `<done>` criteria.

**Plan metadata:** see final `docs(06-01)` commit.

## Files Created/Modified
- `yulu/scripts/provision/registry.py` — Step ABC, StepResult dataclass, ScriptStep wrapper, six read-only probes, ordered REGISTRY, step_by_name. WRAPS the six setup_*.sh; ports no bash logic.
- `yulu/scripts/provision/__init__.py` — package exports (Step, StepResult, ScriptStep, REGISTRY, step_by_name).
- `tests/test_provision_registry.py` — 11 tests (10 unit + 1 `integration`-marked hermetic real-bash drive).

## Decisions Made
- **StepResult as a plain-str frozen dataclass (no enum):** matches the existing `release_installer.py` `@dataclass(frozen=True)` idiom and serializes directly into the future `.yulu-install.json` ledger (06-02) without enum-coercion. The three statuses are enforced by the plan/tests, not the type.
- **`check()` swallows probe exceptions → False:** a read-only probe that hits an unexpected error means "state unknown" — the safe answer is "not confirmed done", which runs the idempotent script. This keeps provisioning robust without weakening the skip-when-done contract (a probe that *can* confirm done still returns True).
- **`models` probe accepts `engine==mlx` as done:** MLX weights are downloaded lazily by `mlx-whisper` on first transcription (per CLAUDE.md + Phase-1 01-04), so there is no on-disk file to gate the step; only the whisper-cli path checks `transcription.local_model_path`.
- **`ui` probe = `dist/server.js` existence (not a healthz curl):** the plan allows either and explicitly notes file-existence is "sufficient and hermetic-test-friendly"; it needs no running server, so the integration test stays fast and host-clean.
- **D-07 uv-defer recorded as a module-docstring section**, not just a comment, so the rationale travels with the code.

## Deviations from Plan

None — plan executed exactly as written.

The six probe shapes, the `engine==mlx` short-circuit, and the file-existence `ui` probe are all design choices the plan explicitly delegated to executor discretion ("a healthz curl is acceptable but a file-existence probe is sufficient"; "check() may be lenient"). No bugs, missing-critical functionality, blocking issues, or architectural changes were encountered.

## Issues Encountered
None. The hermetic integration test runs the real `setup_deps.sh` body behind no-op stubs (~37–51s) — slow but green and host-clean; this is inherent to driving real bash and is correct behavior, not a problem.

## User Setup Required
None — no external service configuration required. No third-party dependency was added (stdlib-only; uv deferred per D-07). The full repo `pytest` suite passes (exit 0, one pre-existing e2e test skipped).

## Next Phase Readiness
- `Step` / `StepResult` / `REGISTRY` / `step_by_name` are the stable contract that **06-02** (state ledger — `state.mark(step,"running"/"ok")` around `apply()`), **06-03** (attestation gate — runs `verify_asset` before any `apply()`), and **06-04** (CLI — `python3 -m provision.cli`) compose against. They are parallel siblings and can now bind to these names.
- The idempotency contract (`check()` True → `apply()` skipped) is the load-bearing primitive for 06-02's kill-at-step-N resume: a step left non-`ok` after a kill is re-run, and the short-circuit + the scripts' own idempotency make the re-run duplicate no daemons.
- No blockers. Note for 06-02 (already captured in RESEARCH §"Runtime State Inventory" + Pitfall 3): `state.py` must PRESERVE the installer-written `.yulu-install.json` `source`/`version`/`sha256` keys and treat a missing `steps` map as a fresh ledger — this module does not touch the ledger, so the obligation lands on 06-02.

## Self-Check: PASSED

- FOUND: yulu/scripts/provision/registry.py
- FOUND: yulu/scripts/provision/__init__.py
- FOUND: tests/test_provision_registry.py
- FOUND: .planning/phases/06-agent-orchestrated-provisioning-decoupled-skill-install/06-01-SUMMARY.md
- FOUND commit: 27c1d96 (test — RED)
- FOUND commit: a1efa75 (feat — GREEN)

---
*Phase: 06-agent-orchestrated-provisioning-decoupled-skill-install*
*Completed: 2026-05-30*
