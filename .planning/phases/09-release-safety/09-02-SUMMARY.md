---
phase: 09-release-safety
plan: 02
subsystem: distribution
tags: [swift, macos, deployment-target, vtool, github-actions]

requires:
  - phase: 01-build-foundation
    provides: signed/notarized native build and extracted-runtime release verification
provides:
  - explicit macOS 13 arm64 target on every shipped Swift compile
  - fail-closed vtool validation for the five shipped native executables
  - shared CI and final-release-byte deployment-target gate
affects: [09-03, release-publish, macos-compatibility]

tech-stack:
  added: []
  patterns: [quoted Swift target arrays, fixed native release inventory, final-byte vtool gate]

key-files:
  created:
    - packaging/scripts/check_macos_deployment_target.sh
  modified:
    - yulu/scripts/build_audio_daemon.sh
    - yulu/scripts/build_status_agent.sh
    - .github/workflows/ci.yml
    - .github/workflows/release-publish.yml
    - tests/test_package_release.py

key-decisions:
  - "Every shipped Swift compile declares arm64-apple-macosx13.0; host-toolchain defaults are never release inputs."
  - "One hard-coded five-binary vtool gate is reused for early CI feedback and authoritative extracted release bytes."

patterns-established:
  - "Compiler contract: both native build scripts share a quoted SWIFT_TARGET array across every output."
  - "Artifact contract: platform MACOS and exact minos 13.0 are required before attestation or publication."

requirements-completed: [DIST-02]

duration: 6 min
completed: 2026-08-23
---

# Phase 9 Plan 02: macOS 13 Native Artifact Contract Summary

All five shipped Swift executables now compile for `arm64-apple-macosx13.0`, and one fail-closed `vtool` gate checks the exact extracted release bytes before attestation or publication.

## Performance

- **Duration:** 6 min
- **Started:** 2026-08-23T08:48:11Z
- **Completed:** 2026-08-23T08:54:00Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments

- Applied one quoted `SWIFT_TARGET` array to all five shipped binary compiles without changing Swift sources, frameworks, signing, entitlements, or bundle assembly.
- Expanded CI to compile `xai_keychain` with Security and target all six native smoke sources at the same macOS 13 arm64 floor.
- Added one executable validator that rejects missing/unreadable inputs, failed/non-arm64 `vtool` inspection, missing/wrong platform metadata, and any `minos` other than exactly `13.0`.
- Wired the exact five-binary inventory into pull-request CI and the already-extracted, signature/manifest-verified release runtime before attestation/upload/publication.

## Task Commits

Each task was implemented with a separate RED and GREEN commit:

1. **Task 1: Apply the macOS 13 arm64 target to every native compile**
   - `10fdf54` — `test(09-02): add failing macOS target contract tests`
   - `17b44d1` — `feat(09-02): target shipped Swift builds at macOS 13`
2. **Task 2: Add one fail-closed vtool gate and run it on CI plus final release bytes**
   - `d2b0131` — `test(09-02): add failing deployment gate tests`
   - `097b029` — `feat(09-02): gate release binaries on macOS 13 metadata`

## Files Created/Modified

- `packaging/scripts/check_macos_deployment_target.sh` — Quoted-argv, fail-closed arm64 macOS `vtool` metadata validator.
- `yulu/scripts/build_audio_daemon.sh` — Targets `audio_daemon` and `xai_keychain` at macOS 13 arm64.
- `yulu/scripts/build_status_agent.sh` — Targets `status_agent`, `recorder_status`, and `meeting_prompt` at macOS 13 arm64.
- `.github/workflows/ci.yml` — Compiles the complete native smoke inventory and validates the five shipped outputs.
- `.github/workflows/release-publish.yml` — Validates the exact extracted release runtime after signature/manifest checks and before publication.
- `tests/test_package_release.py` — Covers compile inventory, validator failures, quoted metacharacter paths, and workflow ordering.

## Decisions Made

- The deployment floor remains a fixed product contract (`arm64-apple-macosx13.0` / `minos 13.0`), not user configuration.
- `.ci-build` provides early feedback only; the extracted release runtime remains the authoritative publication gate.

## Automated Verification

- `python3 -m pytest -q tests/test_package_release.py` — 28 passed.
- `bash -n` on both native build scripts and the deployment-target checker — passed.
- `shellcheck -x -P SCRIPTDIR` on both native build scripts and the checker — passed.
- Adjacent Plan 09-01 regression (`test_package_release`, `test_release_installer`, `test_migrate_recording_guard`) — 133 passed.
- Local real compile of all five shipped Swift sources followed by the new checker — all reported `platform MACOS`, `minos 13.0`.

The local compile/load-command check is not real macOS 13 runtime acceptance. That evidence remains intentionally deferred to checkpoint 09-03-03 against the signed/notarized candidate.

## Deviations from Plan

None - plan executed exactly as written.

## Known Stubs

None.

## Issues Encountered

- The first local real-compile probe could not write Swift's default module cache under the sandbox. Re-running with `-module-cache-path` inside the temporary build directory passed; no repository change was required.

## User Setup Required

None - no external service configuration is required for this plan.

## Next Phase Readiness

- Plan 09-03 can now remove optional install blockers while retaining the completed release/update gates.
- Real signed-candidate and macOS 13 runtime acceptance remains pending at checkpoint 09-03-03; this plan does not claim that acceptance.

## Self-Check: PASSED

- All six created/modified product, workflow, and test files plus this summary exist.
- All four RED/GREEN task commits are present in Git history.
- Stub scan found no plan-introduced placeholders or unwired data stubs.
