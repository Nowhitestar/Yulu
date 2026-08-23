---
phase: 09-release-safety
plan: 01
subsystem: distribution
tags: [installer, github-releases, semver, recording-safety, rollback]

requires:
  - phase: 07-seamless-auto-migration
    provides: canonical recording guard and rollback primitives
provides:
  - release-owned exact-tag stable bootstrap
  - trusted-runtime recording guard for release and dev updates
  - recording-active rollback that avoids service repair
affects: [09-02, 09-03, release-publish, onboarding]

tech-stack:
  added: []
  patterns: [release-owned bootstrap, verified-staged guard fallback, typed active refusal]

key-files:
  created: []
  modified:
    - install.sh
    - packaging/scripts/package.sh
    - yulu/scripts/release_installer.py
    - tests/test_release_installer.py
    - tests/test_release_installer_integration.py

key-decisions:
  - "Raw stable bootstrap executes a GitHub Release-owned install.sh; raw main is dev-only."
  - "Existing updates use the installed guard when present; legacy release updates use only the verified staged guard."
  - "Recording-active rollback restores bytes and configuration but skips service repair."

patterns-established:
  - "Stable bootstrap ownership: default, latest, and exact-version installs enter through GitHub Release assets."
  - "Trusted admission: active-recording checks load the exact installed or verified-staged guard module."

requirements-completed: [DIST-01, DIST-03]

duration: 14 min
completed: 2026-08-23
---

# Phase 9 Plan 01: Stable Bootstrap and Recording-Safe Updates Summary

Stable installs now bootstrap from immutable release-owned assets, while release and dev updates refuse safely during active recordings using the canonical guard from a trusted runtime.

## Performance

- **Duration:** 14 min
- **Started:** 2026-08-23T08:28:46Z
- **Completed:** 2026-08-23T08:41:58Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Routed default, `latest`, and exact-version stable bootstrap through GitHub Release assets, leaving raw `main` access exclusively behind `--dev`.
- Injected both the release installer payload and exact package tag into the packaged helper using the existing atomic temporary-file replacement path.
- Added recording-idle admission before update mutation, including a verified-staged guard fallback for legacy release installs and a fail-closed path when the required guard cannot be loaded.
- Preserved rollback bytes and configuration while suppressing service repair after a recording-active refusal.

## Task Commits

Each task was implemented with a separate RED and GREEN commit:

1. **Task 1: Make stable bootstrap release-owned and SemVer exact**
   - `749507b` — `test(09-01): add failing stable bootstrap contract tests`
   - `2689f2c` — `feat(09-01): pin stable bootstrap to release assets`
2. **Task 2: Make recording_active mandatory for dev and release update paths**
   - `a4c23a9` — `test(09-01): add failing active recording update tests`
   - `5d42617` — `feat(09-01): block updates during active recordings`

**Post-plan regression closure:**

- `2068208` — `test(09-01): align integration fixtures with recording guard contract`

## Files Created/Modified

- `install.sh` — Selects release-owned stable helpers, normalizes exact SemVer tags, and preserves the explicit dev helper path.
- `packaging/scripts/package.sh` — Atomically injects installer code and the package's exact release tag.
- `yulu/scripts/release_installer.py` — Enforces trusted recording-idle admission and recording-safe rollback behavior.
- `tests/test_release_installer.py` — Covers bootstrap routing, packaged tag behavior, trusted guard loading, legacy fallback, and rollback refusal paths.
- `tests/test_release_installer_integration.py` — Gives synthetic release and dev runtimes the canonical idle recording-guard contract.

## Decisions Made

- Raw stable bootstrap executes a GitHub Release-owned `install.sh`; raw `main` is reserved for explicit dev installs.
- Existing updates use the installed canonical guard whenever available; only legacy release installs may use the guard from a fully verified staged payload.
- Recording-active rollback restores the previous runtime and configuration without running repair or setup actions that could disturb the active recorder.

## Automated Verification

- `python3 -m pytest -q tests/test_release_installer.py tests/test_migrate_recording_guard.py` — 105 passed.
- `bash -n install.sh packaging/scripts/package.sh` — passed.
- `shellcheck -x -P SCRIPTDIR install.sh packaging/scripts/package.sh` — passed.
- `python3 -m py_compile yulu/scripts/release_installer.py` — passed.
- `python3 -m pytest -q tests/test_package_release.py tests/test_release_no_swiftc.py` — 29 passed.
- `python3 -m pytest -q tests/test_release_installer_integration.py` — 13 passed after fixture alignment.
- `make test` — 943 passed, 2 skipped; all five Swift build targets compiled successfully.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Aligned synthetic integration runtimes with the recording-guard contract**

- **Found during:** Post-plan full-suite verification after Wave 1.
- **Issue:** Eight transaction integration tests stopped at the new fail-closed admission check because their synthetic release asset and dev checkout omitted `migrate/guard.py`, so they never reached the setup and rollback behavior under test.
- **Fix:** Added one minimal idle guard fixture and installed it into the synthetic release asset plus both old and cloned dev runtimes. Production fail-closed behavior was not changed.
- **Files modified:** `tests/test_release_installer_integration.py`
- **Commit:** `2068208`

## Known Stubs

None.

## Issues Encountered

The first sandboxed `make test` run completed Python tests but Swift compilation could not write the external Clang module cache. Re-running the same gate with permitted cache access passed completely.

## User Setup Required

None - no external service configuration is required for this plan.

## Next Phase Readiness

- The bootstrap and update admission contracts are ready for Plan 09-02 integration.
- Signed draft-candidate packaging and live-recording acceptance remain explicitly deferred to the Plan 09-03 checkpoint; this plan does not claim those manual acceptance gates.

## Self-Check: PASSED

- All five modified product/test files and this summary exist.
- All four RED/GREEN task commits and the integration-fixture regression commit are present in Git history.
- Stub scan found no plan-introduced UI/data stubs; the only matches are an existing capability comment and an intentional empty-branch test fixture.
