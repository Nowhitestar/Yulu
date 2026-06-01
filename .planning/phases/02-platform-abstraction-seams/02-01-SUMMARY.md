---
phase: 02-platform-abstraction-seams
plan: 01
subsystem: infra
tags: [platform-abstraction, launchd, launchctl, plistlib, pathresolver, daemonmanager, python, stdlib, macos]

# Dependency graph
requires:
  - phase: 01-build-foundation
    provides: "Frozen yulu_platform.base ABCs (DaemonManager, PathResolver, PermissionModel, DependencyManager) + ServiceSpec value object; D-15/D-17/D-18 neutrality contract; tests/test_yulu_platform_stubs.py bootstrap idiom"
provides:
  - "MacOSPathResolver — env → config.json → platform-default precedence for config/data/runtime dirs (PLAT-04, D-06)"
  - "MacOSDaemonManager — launchctl wrapper rendering ServiceSpec → launchd plist via plistlib, with platform-neutral status strings (PLAT-03, D-04)"
  - "yulu_platform.macos package exports (MacOSPathResolver, MacOSDaemonManager)"
  - "tests/test_yulu_platform_no_vocab.py — signature-scoped D-09 neutrality gate (the success-criterion-4 proof)"
  - "tests/test_yulu_platform_macos.py — Darwin-gated Wave-0 conformance + path-precedence scaffold the rest of Phase 2 verifies against"
affects: [02-02-PLAN, 02-03-PLAN, 02-04-PLAN, phase-03-doctor-report, phase-05-data-separation, phase-07-migration]

# Tech tracking
tech-stack:
  added: []  # stdlib only — zero package installs (plistlib, subprocess, json, os, platform, pathlib)
  patterns:
    - "Darwin-gated constructor (platform.system() != 'Darwin' → RuntimeError) shared across both macOS seam impls (D-08)"
    - "Platform vocabulary confinement: launchd plist key names + launchctl verbs live ONLY inside MacOSDaemonManager methods; the ABC + ServiceSpec stay neutral (D-09)"
    - "Signature-scoped neutrality test (inspect.signature + dataclasses.fields, never raw module source) — keeps the gate GREEN against a frozen base.py whose docstrings carry prose examples"
    - "Silent config.json fallback: a missing/unparseable/empty value degrades to the default, never raises (ports audio_daemon.swift:loadRecordingDir guard; threat T-02-03)"

key-files:
  created:
    - yulu/scripts/yulu_platform/macos/path_resolver.py
    - yulu/scripts/yulu_platform/macos/daemon_manager.py
    - tests/test_yulu_platform_macos.py
    - tests/test_yulu_platform_no_vocab.py
  modified:
    - yulu/scripts/yulu_platform/macos/__init__.py

key-decisions:
  - "[02-01] Signature-scoped D-09 gate (inspect.signature + dataclasses.fields, never module source): base.py's DependencyManager docstring names Homebrew/apt as prose, so a whole-module scan would false-positive on brew — scoping to signatures honors D-09's 'no leaked vocab in signatures' intent AND stays GREEN by construction against the frozen base"
  - "[02-01] install() renders ServiceSpec → launchd plist via stdlib plistlib.dump (not f-string XML) — stdlib handles escaping/types; the repo already plutil-lints generated plists"
  - "[02-01] RunAtLoad mapped from ServiceSpec.keep_alive (no separate spec field) — a kept-alive Yulu daemon should also start at load; ServiceSpec stays minimal and neutral"
  - "[02-01] runtime_dir() == config_dir() today but kept a distinct method so Phase 5 DATA-02 (runtime/content split) can diverge it without touching callers"
  - "[02-01] macos/__init__ export wired incrementally (resolver in Task 2, daemon manager in Task 3) — the minimal package wiring each impl needs to be importable by its conformance test"

patterns-established:
  - "macOS seam impl pattern: subclass frozen ABC, Darwin-gate the constructor, stdlib + subprocess (list-form, never shell), confine all OS vocabulary to method bodies"
  - "Neutral status vocabulary: launchctl wrappers return only 'running'/'stopped'/'unknown', never a raw exit code or stdout line (D-09 / threat T-02-03)"

requirements-completed: [PLAT-03, PLAT-04]

# Metrics
duration: 6min
completed: 2026-05-30
---

# Phase 2 Plan 01: macOS Platform Seams (PathResolver + DaemonManager) Summary

**Filled the macOS arm of two frozen Phase 1 seams — `MacOSPathResolver` (env→config.json→default precedence) and `MacOSDaemonManager` (plistlib-rendered launchd install + neutral launchctl status) — plus the Wave-0 signature-scoped D-09 neutrality gate the rest of Phase 2 verifies against, all stdlib-only against an untouched frozen `base.py`.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-30T05:56:23Z
- **Completed:** 2026-05-30T06:02:36Z
- **Tasks:** 3
- **Files modified:** 5 (4 created, 1 modified)

## Accomplishments
- **MacOSPathResolver** removes the hardcoded `~/.config/yulu` / `~/Movies/Yulu` for Python callers, resolving config/data/runtime dirs with `env → config.json → platform-default` precedence — a faithful port of `audio_daemon.swift:loadRecordingDir` (honors `~/` prefix, silent fallback on missing/empty config, never raises).
- **MacOSDaemonManager** wraps `launchctl` behind the frozen `DaemonManager` ABC: `install()` renders `ServiceSpec` → a launchd plist via `plistlib.dump`; `load`/`unload` shell out list-form (never `shell=True`); `status()` returns only neutral `running`/`stopped`/`unknown` strings — every launchd key name and launchctl verb confined to this module (D-09).
- **D-09 neutrality gate** (`test_yulu_platform_no_vocab.py`) proves success criterion 4: `base.py`'s abstractmethod signatures + `ServiceSpec` fields carry no macOS-structural vocabulary, so a systemd arm could re-implement the same methods. Signature-scoped (never module source) so the `DependencyManager` docstring's "Homebrew/apt" prose does not trip it.
- **Wave-0 conformance scaffold** (`test_yulu_platform_macos.py`) — Darwin-gated `issubclass` + instantiation + full path-precedence assertions; the test bed the parallel/downstream Phase 2 plans verify against.
- Full suite green: **573 passed** (1 e2e deselected), `base.py` untouched, both new `.py` files + `__init__` grep-clean of leaked vocab where they should be.

## Task Commits

Each task was committed atomically:

1. **Task 1: Wave-0 scaffold — ABC-conformance + D-09 signature-neutrality** - `7c01123` (test) — RED scaffold: no-vocab gate GREEN by construction, macOS conformance RED pending impls
2. **Task 2: MacOSPathResolver — env→config.json→default precedence** - `2395030` (feat)
3. **Task 3: MacOSDaemonManager — launchctl wrapper + neutral status + exports** - `48243a9` (feat)

**Plan metadata:** _(this commit)_ (docs: complete plan)

_Note: This was a `tdd="true"` plan; Tasks 2 and 3 turned the Task-1 RED scaffold GREEN, so the test→feat split spans tasks rather than producing a separate per-task RED commit._

## Files Created/Modified
- `yulu/scripts/yulu_platform/macos/path_resolver.py` - `MacOSPathResolver(PathResolver)`: `config_dir`/`data_dir`/`runtime_dir` with env→config.json→default precedence; Darwin-gated; silent config fallback.
- `yulu/scripts/yulu_platform/macos/daemon_manager.py` - `MacOSDaemonManager(DaemonManager)`: `install` (ServiceSpec→plist via plistlib), `load`/`unload` (list-form launchctl), `status` (neutral strings); Darwin-gated; all launchd vocab confined here.
- `yulu/scripts/yulu_platform/macos/__init__.py` - Exports `MacOSPathResolver` + `MacOSDaemonManager` with `__all__` (was a Phase 1 stub).
- `tests/test_yulu_platform_macos.py` - Darwin-gated conformance (`issubclass` + construct) + path-precedence + install-writes-plist assertions.
- `tests/test_yulu_platform_no_vocab.py` - `test_no_macos_vocabulary_in_signatures`: signature-scoped D-09 proof (inspect.signature + dataclasses.fields).

## Decisions Made
- **Signature-scoped D-09 gate** (not whole-module scan): `base.py`'s `DependencyManager` docstring legitimately names "Homebrew"/"apt" as prose examples; a `getsource`-style scan would false-positive on `brew`. Scoping the assertion to `inspect.signature(...)` + `dataclasses.fields(...)` is exactly what D-09 ("no leaked vocab in signatures") asks for and keeps the test GREEN by construction against the frozen base. `homebrew`/`brew` are deliberately excluded from the forbidden-token list; the macOS-STRUCTURAL tokens (launchctl, plist, launchagent, keepalive, runatload, tccutil, screencapture, scstream, catap, sckit) are asserted absent.
- **`RunAtLoad` derived from `keep_alive`**: `ServiceSpec` has no separate run-at-load field (and shouldn't — it stays minimal/neutral); a kept-alive Yulu daemon should also start at load, so `install` maps `keep_alive → both KeepAlive and RunAtLoad`.
- **`plistlib.dump` over f-string XML** (RESEARCH Open Q #2, "Don't Hand-Roll"): stdlib handles escaping/types and the repo already `plutil -lint`s generated plists.
- **`runtime_dir()` kept distinct from `config_dir()`** even though equal today, so Phase 5 DATA-02 can split runtime (sockets/PIDs/locks) from content without touching callers.

## Deviations from Plan

None - plan executed exactly as written. No bugs, missing functionality, or blocking issues surfaced; all three tasks' acceptance criteria passed as specified.

Two cosmetic docstring rephrasings were made to satisfy literal acceptance-criteria greps (these are not behavioral deviations):
- `test_yulu_platform_no_vocab.py`: the docstring originally explained the design by naming the anti-pattern token `getsource`; rephrased to "never read the raw module text" so `grep -c 'getsource' == 0` per acceptance criterion 3. The test still never invokes `inspect.getsource`.
- `daemon_manager.py`: the security docstring originally spelled the literal token `shell=True` when describing the T-02-01 mitigation; rephrased to "the shell is never invoked" so `grep -nE 'shell=True'` returns nothing per acceptance criterion 3. No real `shell=True` kwarg ever existed.

## Issues Encountered
None. The Task-1 RED/GREEN split landed exactly as designed (no-vocab GREEN on first run; macOS conformance RED via clean ImportError, collecting without error on Darwin). Python 3.14 in this worktree ran the full 573-test suite without incident.

## Threat Mitigations Applied (from plan threat_model)
- **T-02-01 (Tampering/Elevation — launchctl calls):** every subprocess call is list-form `subprocess.run([...], check=False)`; no `shell=True`, no f-string interpolation into a command string. Asserted by acceptance grep (`shell=True` absent).
- **T-02-03 (Information Disclosure — error messages):** `data_dir` fallback returns the default silently (never raises a path-leaking error); `status` returns only the three neutral strings, never raw launchctl stdout/exit codes.
- **T-02-02 / T-02-04 (accept):** path-traversal of `audio.output_dir` and launchd name collision are accepted-risk for this single-user phase (no privilege boundary crossed; spec.name comes from fixed `com.yulu.*` config). Revisited in Phase 5 (DATA-03).
- **T-02-SC (package legitimacy):** N/A — stdlib-only, zero installs.

## User Setup Required
None - no external service configuration required. Pure Python seam code; no new dependencies, no env-var setup beyond the already-half-wired `YULU_CONFIG_DIR`/`YULU_OUTPUT_DIR` this plan formalizes reading.

## Next Phase Readiness
- **Ready for 02-03 (read-side wiring):** PathResolver is the resolution contract Phase 3 (`doctor.py` report), Phase 5, and Phase 7 consume; the launchd-direct-launch plist fix that completes PLAT-03 and the `status_agent.swift` consumer fix that completes PLAT-04 land in **02-03** (this plan adds the seam; it does NOT route callers — `dev_install.py`/`setup.sh` intentionally still own installation).
- **Wave-0 scaffold is in place:** `test_yulu_platform_macos.py` + `test_yulu_platform_no_vocab.py` are the conformance/neutrality bed the remaining Phase 2 plans (02-02 PermissionModel/DependencyManager arm, 02-03/02-04) verify against.
- **No blockers.** `base.py` remains frozen and untouched; the D-09 contract is machine-asserted and GREEN.

## Self-Check: PASSED

All created files verified present (path_resolver.py, daemon_manager.py, test_yulu_platform_macos.py, test_yulu_platform_no_vocab.py, 02-01-SUMMARY.md) and all three task commits (7c01123, 2395030, 48243a9) verified in git history.

---
*Phase: 02-platform-abstraction-seams*
*Completed: 2026-05-30*
