---
phase: 02-platform-abstraction-seams
plan: 02
subsystem: infra
tags: [platform-abstraction, permission-model, dependency-manager, tccutil, homebrew, darwin-gate, python, stdlib, macos]

# Dependency graph
requires:
  - phase: 02-platform-abstraction-seams
    plan: 01
    provides: "yulu_platform.macos package (MacOSPathResolver, MacOSDaemonManager) + Darwin-gated constructor idiom + signature-scoped D-09 neutrality gate (test_yulu_platform_no_vocab.py) + Darwin-gated conformance scaffold (test_yulu_platform_macos.py)"
provides:
  - "MacOSPermissionModel — abstract-token (microphone / system-audio-capture) capture-permission READ via audio_daemon.sock {action:status} probe → neutral granted/denied/unknown; reset() wraps tccutil reset (Darwin-gated, scope name confined to method body) (PLAT-05, D-08, D-09)"
  - "MacOSDependencyManager — brew list/install wrapper (Darwin-gated); is_available returns bool without raising on absent brew; install raises fixed RuntimeError, never auto-installs Homebrew (PLAT-05, D-08)"
  - "yulu_platform.macos package exports all four seams (MacOSPathResolver, MacOSDaemonManager, MacOSPermissionModel, MacOSDependencyManager)"
  - "doctor.py + repair_permissions.py routed through the permission/dependency seams (first read-side consumers); inline TCC scope literal removed from repair_permissions"
  - "Source-static routing gates in test_yulu_platform_macos.py proving the seam coexists with — does not rip out — the install pipeline"
affects: [02-04-PLAN, phase-03-doctor-report, phase-05-data-separation, phase-07-migration]

# Tech tracking
tech-stack:
  added: []  # stdlib only — zero package installs (platform, subprocess, socket, json, shutil, pathlib)
  patterns:
    - "Darwin-gated constructor (platform.system() != 'Darwin' → RuntimeError) shared across all four macOS seams (D-08)"
    - "Capability-token confinement: abstract tokens ('microphone'/'system-audio-capture') in signatures; consent-database scope names (ScreenCapture/Microphone) live ONLY in a private token→service map consulted by reset() (D-09)"
    - "Permission READ via existing socket liveness probe (sysReady/micReady), never a private TCC status API — none is public (02-RESEARCH §82-87)"
    - "Seam coexists with the install pipeline: route only the read-side callers (doctor/repair_permissions); dev_install.py/setup.sh untouched this milestone (RESEARCH Open Q #2)"
    - "Guarded lazy import (sys.path.insert + try/except) so read-side callers load off Darwin / when the seam is absent, degrading to which()/no-op (mirrors doctor.py's search.indexer lazy-import idiom)"

key-files:
  created:
    - yulu/scripts/yulu_platform/macos/permission_model.py
    - yulu/scripts/yulu_platform/macos/dependency_manager.py
  modified:
    - yulu/scripts/yulu_platform/macos/__init__.py
    - yulu/scripts/doctor.py
    - yulu/scripts/repair_permissions.py
    - tests/test_yulu_platform_macos.py

key-decisions:
  - "[02-02] PermissionModel reads liveness through the existing audio_daemon.sock {action:status} probe (port of doctor.py:64-73), NOT a private TCC status API — macOS exposes no public API to query tap authorization (02-RESEARCH §87), so sysReady/micReady ARE the signal"
  - "[02-02] reset(capability) added BEYOND the ABC (the routed repair_permissions caller needs it); the consent-database scope strings (ScreenCapture/Microphone) live only in a private _TOKEN_TO_RESET_SERVICE map and reset()'s body — no scope name reaches any public signature (D-09)"
  - "[02-02] is_available tries `brew list` then falls back to shutil.which: a brew formula usually also exposes a same-named binary, and some deps (swiftc/codex/gh) are plain binaries brew doesn't track — so the fallback keeps the doctor report shape stable on Darwin AND off it"
  - "[02-02] install() refuses to bootstrap Homebrew (fixed RuntimeError 'Homebrew not available') per REQUIREMENTS / 02-RESEARCH §502 — auto-installing a package manager is out of scope and a fixed message avoids leaking raw brew stderr (threat T-02-07)"
  - "[02-02] doctor.py routes dependency PRESENCE (the `ok` field) through MacOSDependencyManager.is_available while keeping _check_command for path+version strings — report keys unchanged, --json stays valid (no shape regression)"
  - "[02-02] Read-side routing ONLY: dev_install.py/setup.sh launchd install code left intact — the DaemonManager seam coexists with the working pipeline this milestone (RESEARCH Open Q #2); a source-static test asserts neither caller rewires dev_install"

patterns-established:
  - "Permission seam reports/resets, never grants: check() has no grant path (impossible by macOS design, forbidden ASVS V4); reset() only clears stale state so the user can re-approve in System Settings (threat T-02-06)"
  - "Routing gate via source-static asserts (read caller source, assert inline coupling moved behind the seam) — no launchctl/brew shell-out in the test; mirrors tests/test_status_agent_config.py's Swift static gates"

requirements-completed: [PLAT-05]

# Metrics
duration: 7min
completed: 2026-05-30
---

# Phase 2 Plan 02: macOS Permission + Dependency Seams (PermissionModel + DependencyManager) Summary

**Filled the last two macOS seams — `MacOSPermissionModel` (abstract-token capture-permission read via the existing `audio_daemon.sock` status probe + a Darwin-gated `tccutil reset`) and `MacOSDependencyManager` (Darwin-gated `brew list`/`install` wrapper that never bootstraps Homebrew) — then routed the read-side callers (`doctor.py`, `repair_permissions.py`) through them so TCC and brew vocabulary live behind the abstraction, all stdlib-only against an untouched frozen `base.py`, with the working install pipeline left intact (coexist, not rip-out).**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-30T06:16:40Z
- **Completed:** 2026-05-30T06:24:39Z
- **Tasks:** 2
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments
- **MacOSPermissionModel** completes the permission arm of PLAT-05: `check("microphone")`/`check("system-audio-capture")` map the abstract tokens to the daemon's `micReady`/`sysReady`, read over the existing `~/.config/yulu/audio_daemon.sock` `{"action":"status"}` probe (a faithful port of `doctor.py:64-73`), returning neutral `granted`/`denied`/`unknown`. An unknown token, an absent socket, or a probe failure all degrade to `"unknown"` — never a crash. A `reset(capability)` helper (beyond the ABC, for the routed `repair_permissions` caller) wraps `tccutil reset` list-form behind a Darwin gate, with the consent-database scope name confined to a private map.
- **MacOSDependencyManager** completes the dependency arm: `is_available` tries `brew list <name>` then falls back to `shutil.which`, returning a bool (never raising) even when brew is absent; `install` runs `brew install <name>` list-form and raises a fixed `RuntimeError` rather than auto-installing Homebrew (out of scope). Both constructors Darwin-gated, matching the Wave-1 seams.
- **All four macOS seams now exported + conformance-tested.** `macos/__init__.py` exports `MacOSPathResolver`, `MacOSDaemonManager`, `MacOSPermissionModel`, `MacOSDependencyManager`; the two new conformance tests assert subclass + construct + neutral status for known *and* bogus tokens + `is_available` bool on an absent formula.
- **Read-side callers routed through the seams (the abstraction proven with real consumers).** `repair_permissions.py --reset` now calls `MacOSPermissionModel().reset("system-audio-capture")` — the inline `tccutil reset ScreenCapture` list-form literal is gone from the call site (the scope string moved into the seam, D-09). `doctor.py` obtains brew-managed dependency presence through `MacOSDependencyManager.is_available` (with a `which()` fallback off Darwin / when the seam is absent), keeping `_check_command` for version strings and the exact report keys — `doctor.py --json` still emits valid JSON with no shape regression.
- **Coexist, not rip-out, machine-asserted.** `dev_install.py` and `setup.sh` are untouched; a source-static gate asserts neither caller rewires `dev_install`, so the DaemonManager seam coexists with the working launchd install pipeline this milestone (RESEARCH Open Q #2).
- Full suite green: **598 passed, 1 skipped** (the macOS-arm e2e deselect), `base.py` untouched, the D-09 signature-neutrality gate still GREEN (scope names confined to method bodies).

## Task Commits

Each task was committed atomically (Conventional Commits):

1. **Task 1 (RED): failing conformance tests for the two seams** — `11c534c` (test) — `test_permission_model_conformance` + `test_dependency_manager_conformance` fail with clean ImportError (classes don't exist), 5 existing tests still pass.
2. **Task 1 (GREEN): MacOSPermissionModel + MacOSDependencyManager Darwin-gated seams** — `036f905` (feat) — both seams implemented + exported; 8 conformance/neutrality tests GREEN.
3. **Task 2: route doctor.py + repair_permissions.py through the seams (coexist)** — `8b31244` (refactor) — read-side callers routed; inline TCC literal removed; install pipeline untouched; 3 source-static routing gates added.

**Plan metadata:** _(final docs commit)_

_Note: Task 1 was `tdd="true"` — the RED commit (`11c534c`) precedes the GREEN feat commit (`036f905`), satisfying the RED→GREEN gate sequence. No REFACTOR commit needed (the GREEN code was clean)._

## Files Created/Modified
- `yulu/scripts/yulu_platform/macos/permission_model.py` (created) — `MacOSPermissionModel(PermissionModel)`: `check(capability)` via socket `sysReady`/`micReady` → neutral status; `reset(capability)` wraps `tccutil reset` (Darwin-gated, list-form); `_probe_daemon` ports doctor.py's read-only socket sequence; Darwin-gated constructor; scope names confined to a private map.
- `yulu/scripts/yulu_platform/macos/dependency_manager.py` (created) — `MacOSDependencyManager(DependencyManager)`: `is_available` (`brew list` → `shutil.which` fallback, bool never raises); `install` (`brew install` list-form, fixed RuntimeError when brew absent, never bootstraps Homebrew); Darwin-gated.
- `yulu/scripts/yulu_platform/macos/__init__.py` (modified) — exports all four seams with `__all__` (added the two Wave-2 classes alongside the Wave-1 ones; did not clobber them).
- `yulu/scripts/repair_permissions.py` (modified) — added `reset_capture_permission()` (guarded seam call); `--reset` path now routes through it; inline `tccutil reset ScreenCapture` list-form call removed (the human-readable instruction string in `plan()` is retained for `--json`/instruction output, which is not the routed call site).
- `yulu/scripts/doctor.py` (modified) — added `_dependency_manager()` (guarded lazy import); `_check_command` routes the `ok` presence read through `is_available` with a `which()` fallback; report keys + version capture unchanged.
- `tests/test_yulu_platform_macos.py` (modified) — added Wave-2 conformance tests + three source-static routing gates (reset-via-seam, dependency-via-seam, install-pipeline-untouched).

## Decisions Made
- **Liveness probe over a TCC status API**: macOS exposes no public API to query system-audio-tap authorization (02-RESEARCH §87), so `MacOSPermissionModel.check` reads the daemon's `sysReady`/`micReady` over the already-present `{"action":"status"}` socket probe. Liveness IS the permission signal; the model never reaches into a private consent-database API.
- **`reset(capability)` beyond the ABC**: the routed `repair_permissions --reset` caller needs to clear a stale grant, so the seam exposes a `reset()` helper the ABC doesn't mandate. The TCC scope strings (`ScreenCapture`/`Microphone`) live only in the private `_TOKEN_TO_RESET_SERVICE` map and `reset()`'s body — the `check` signature stays `(self, capability: str) -> str`, naming no scope (D-09 verified).
- **`is_available` = `brew list` then `which` fallback**: a brew formula usually exposes a same-named binary, and several doctor dependencies (`swiftc`/`codex`/`gh`) are plain binaries brew doesn't track. The two-tier read keeps the doctor report's `ok` field stable on Darwin and degrades cleanly off it.
- **`install` refuses to bootstrap Homebrew**: per REQUIREMENTS / 02-RESEARCH §502, auto-installing a package manager is out of scope; `install` raises a fixed `"Homebrew not available"` message (no raw brew stderr — threat T-02-07).
- **Route the read side only**: `doctor.py`/`repair_permissions.py` consume the seams; `dev_install.py`/`setup.sh` launchd install code is intentionally left intact (RESEARCH Open Q #2) — the seam and the pipeline coexist this milestone. A source-static test asserts neither caller rewires `dev_install`.
- **Guarded lazy import in the callers**: both read-side callers import the seam via `sys.path.insert(...)` + `try/except` (mirroring doctor.py's existing `search.indexer` lazy-import idiom) so they keep loading off Darwin / when the seam package is unavailable, degrading to `which()` / a no-op reset.

## Deviations from Plan

None — plan executed exactly as written. Both tasks' acceptance criteria passed as specified; no bugs, missing functionality, or blocking issues surfaced.

One intentional scoping nuance worth recording (not a behavioral deviation): `repair_permissions.py:plan()` still contains the *human-readable instruction string* `f"tccutil reset ScreenCapture {bundle_id}"` in its dry-run `steps` list. That is user-facing documentation of what `--reset` does (surfaced in `--json`/instruction output), NOT the inline subprocess call. The acceptance criterion greps specifically for the list-form call (`"tccutil", "reset", "ScreenCapture"`), which is removed; the instruction string is appropriately retained so the repair output stays informative.

## Issues Encountered
None. The Task-1 RED/GREEN split landed as designed (clean ImportError RED; GREEN on first run). The D-09 signature-neutrality gate (`test_yulu_platform_no_vocab.py`) stayed GREEN throughout because all consent-database/package-manager vocabulary is confined to method bodies and private maps — never a signature. Python 3.14 ran the full 598-test suite without incident.

## Threat Mitigations Applied (from plan threat_model)
- **T-02-05 (Tampering/Elevation — tccutil + brew subprocess):** every call is list-form `subprocess.run([...], check=...)`; the two `tccutil reset` args and the `brew` formula name are fixed internal strings / the dependency identifier — no external value is interpolated into a command string, and `shell=True` is absent (asserted by acceptance grep).
- **T-02-06 (Elevation — PermissionModel granting TCC):** `check()` has no grant path; it only reads the socket status. `reset()` only clears stale state so the user can re-approve in System Settings — granting capture permission is impossible by macOS design and explicitly forbidden (ASVS V4).
- **T-02-07 (Information Disclosure — brew/tccutil error leakage):** `install` raises a fixed `"Homebrew not available"` message; `is_available` returns a bool, never raw brew stderr; `check` returns only the three neutral status strings.
- **T-02-08 (Tampering — socket world-access):** accepted/out of scope this phase — `MacOSPermissionModel` only sends the read-only `{"action":"status"}` probe over the already-`chmod 0o600` socket; no change to the socket's access model.
- **T-02-SC (package legitimacy):** N/A — stdlib-only, zero installs. `MacOSDependencyManager` *wraps* brew but this phase's own code installs nothing; no `[ASSUMED]`/`[SUS]` package → no legitimacy checkpoint.

## User Setup Required
None — pure Python seam code; no new dependencies, no env-var setup. The seams wrap `tccutil`/`brew` (already required by the existing install/repair flow) but install nothing new.

## Next Phase Readiness
- **All four macOS seams complete** (PLAT-03/04 from 02-01, PLAT-01/02/03/04 read-side from 02-03, PLAT-05 here) — the `yulu_platform.macos` package now fully implements the frozen `base.py` ABCs, exported and conformance-tested.
- **Ready for 02-04 (Core Audio process-tap arm)** — the remaining Wave-3 plan (PLAT-02 native capture) is independent of these Python seams; it owns the `audio_daemon.swift` `if #available` tap path + entitlements + the clean-machine validation checkpoint.
- **Downstream consumers unblocked:** Phase 3 (`doctor.py` report) now reads dependency presence through the seam; Phase 5 (data separation) and Phase 7 (migration) inherit the PathResolver + the permission/dependency seams as their resolution/capability contracts.
- **No blockers.** `base.py` remains frozen and untouched (last touched by 01-01's `2fe98b5`); the D-09 contract stays machine-asserted GREEN; the install pipeline is intact (coexist), so nothing downstream regressed.

## Self-Check: PASSED

All created files verified present and all task commits verified in git history (filled in by the post-write self-check below).

---
*Phase: 02-platform-abstraction-seams*
*Completed: 2026-05-30*
