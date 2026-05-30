---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
plan: 03
subsystem: infra
tags: [codesign, hardened-runtime, entitlements, notarization, macos, gatekeeper, tcc, build]

# Dependency graph
requires:
  - phase: 01-build-foundation (plans 01-02)
    provides: build_audio_daemon.sh / build_status_agent.sh env-driven identity cascade; package.sh clean-worktree guard + ALLOWED_BUILD_OUTPUTS
provides:
  - Yulu.app.entitlements (least-privilege: com.apple.security.device.audio-input only)
  - StatusAgent.app.entitlements (least-privilege: com.apple.security.automation.apple-events only)
  - Bottom-up hardened-runtime signing (inner Mach-O then bundle) with secure timestamp + per-bundle entitlements in both build_*.sh
  - package.sh ALLOWED_BUILD_OUTPUTS extended for re-signed _CodeSignature/CodeResources
  - tests/test_entitlements_present.py (entitlement-presence + least-privilege gate)
affects: [01-06 (CI notarize+staple+attest), 02 (audio path / TCC re-prompt after identity change), 06 (clean-machine spctl proof)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Bottom-up codesign: sign $APP_BIN (inner Mach-O) then $APP (bundle) with --options runtime --timestamp --entitlements; never --deep, never --timestamp=none"
    - "Least-privilege entitlements: exactly one key per bundle; comment-free entitlements XML (rationale lives in build scripts + tests, not in fragile XML comments)"

key-files:
  created:
    - yulu/scripts/Yulu.app.entitlements
    - yulu/scripts/StatusAgent.app.entitlements
    - tests/test_entitlements_present.py
  modified:
    - yulu/scripts/build_audio_daemon.sh
    - yulu/scripts/build_status_agent.sh
    - packaging/scripts/package.sh

key-decisions:
  - "Entitlements XML carries no comments — the '--' double-hyphen in flag names (e.g. --options) is illegal inside XML comments and breaks strict (expat/plistlib) parsers even though plutil tolerates it"
  - "_CodeSignature/CodeResources is tracked in git AND rewritten by re-signing, so both bundles' CodeResources were added to ALLOWED_BUILD_OUTPUTS; *.entitlements are committed source and were NOT added to the allowlist"

patterns-established:
  - "Bottom-up hardened-runtime signing replaces the --deep/--timestamp=none anti-pattern in both build scripts"
  - "plistlib-based static test asserts exact entitlement key set (presence + least-privilege absence) rather than substring grep"

requirements-completed: [BUILD-02]

# Metrics
duration: 8min
completed: 2026-05-30
---

# Phase 1 Plan 03: Hardened-Runtime Bottom-Up Signing + Least-Privilege Entitlements Summary

**Both macOS bundles now sign bottom-up (inner Mach-O then bundle) with the hardened runtime, a secure timestamp, and one least-privilege entitlement each (mic for Yulu.app, Apple Events for StatusAgent.app), replacing the `--deep`/`--timestamp=none` anti-pattern that blocked notarization.**

## Performance

- **Duration:** ~8 min
- **Started:** 2026-05-30T04:00:32Z
- **Completed:** 2026-05-30T04:08:11Z
- **Tasks:** 2 (plus 1 auto-fix commit)
- **Files modified:** 6

## Accomplishments
- Wrote two genuinely-new least-privilege entitlements files: `Yulu.app.entitlements` (`com.apple.security.device.audio-input` only) and `StatusAgent.app.entitlements` (`com.apple.security.automation.apple-events` only). No screen/system-audio capture entitlement on Yulu.app — ScreenCaptureKit is purely TCC-gated.
- Refactored the codesign block in both `build_audio_daemon.sh` and `build_status_agent.sh` to sign the inner Mach-O (`$APP_BIN`) first, then the bundle (`$APP`), each with `--options runtime --timestamp --entitlements`, plus a strict `--verify` and an `--display --entitlements` check. `build_status_agent.sh` gained a `--verify` line it never had.
- Kept the env-driven `YULU_CODESIGN_IDENTITY` identity cascade verbatim (D-08): zero certificate/Team-ID/.p12/.p8 values in any committed script.
- Extended `package.sh` `ALLOWED_BUILD_OUTPUTS` with both bundles' tracked `_CodeSignature/CodeResources` (regenerated on every re-sign), leaving `check_clean_worktree` and the reproducible-timestamp/exec-bit-restore logic untouched.
- Added `tests/test_entitlements_present.py` (6 plistlib-based assertions) guarding presence + least-privilege; `test_package_release.py` still passes.

## Task Commits

Each task was committed atomically:

1. **Task 1: Entitlements files + bottom-up hardened-runtime signing refactor** - `0e3d914` (feat)
2. **Task 1 auto-fix: make entitlements XML strict-parser-safe** - `6ff903f` (fix)
3. **Task 2: package.sh CodeResources allowlist + entitlement-presence test** - `9d50541` (test)

**Plan metadata:** (final docs commit — this SUMMARY + STATE/ROADMAP)

## Files Created/Modified
- `yulu/scripts/Yulu.app.entitlements` - Audio daemon least-privilege entitlement (mic only)
- `yulu/scripts/StatusAgent.app.entitlements` - Status agent least-privilege entitlement (Apple Events only)
- `yulu/scripts/build_audio_daemon.sh` - Codesign block now bottom-up + hardened runtime + secure timestamp + entitlements
- `yulu/scripts/build_status_agent.sh` - Same signing refactor; added the missing `codesign --verify`
- `packaging/scripts/package.sh` - `ALLOWED_BUILD_OUTPUTS` now tolerates re-signed `_CodeSignature/CodeResources` for both bundles
- `tests/test_entitlements_present.py` - Static plistlib assertions: required key present, least-privilege (no extra keys, no screen-capture)

## Decisions Made
- **Comment-free entitlements XML.** The first draft embedded explanatory XML comments describing the codesign flags. The `--` (double-hyphen) inside flag names like `--options runtime` is illegal inside an XML comment; `plutil -lint` accepted it but the stricter expat parser behind `plistlib` (and notarization-adjacent tooling) rejected it. Removed all comments from the plists and kept the rationale in the build-script comments and the test docstrings.
- **CodeResources allowlisted, entitlements not.** `git ls-files` confirmed `_CodeSignature/CodeResources` is tracked for both bundles; re-signing with the new flags regenerates those bytes, so they were added to `ALLOWED_BUILD_OUTPUTS`. The `*.entitlements` files are committed source (never written by the build) and were deliberately left out of the allowlist (Pitfall 2).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Entitlements XML rejected by strict parsers due to illegal `--` in comments**
- **Found during:** Task 2 (running `tests/test_entitlements_present.py`)
- **Issue:** The Task 1 entitlements files included descriptive XML comments containing `--` double-hyphen sequences (e.g. `--options runtime`, em-dash text). XML forbids `--` inside `<!-- ... -->`. `plutil -lint` (Task 1's gate) tolerated it, but `plistlib.load` (strict expat) raised `ExpatError: not well-formed (invalid token)`, failing all 5 plistlib assertions.
- **Fix:** Removed the comments from both `*.entitlements` files, leaving minimal declarative plists (one key each). Rationale preserved in build-script comments and test docstrings.
- **Files modified:** `yulu/scripts/Yulu.app.entitlements`, `yulu/scripts/StatusAgent.app.entitlements`
- **Verification:** `plutil -lint` OK, `plistlib.load` parses to exactly one key each, all 13 tests pass.
- **Committed in:** `6ff903f`

**2. [Rule 3 - Blocking] Reworded build-script/entitlement comments to clear the plan's own grep gates**
- **Found during:** Task 1 (verification step)
- **Issue:** The plan's acceptance criteria assert `grep -- '--deep'` / `grep '--timestamp=none'` / `grep 'screen-capture'` return NO matches. My first-draft explanatory comments contained those exact literal strings, producing false-positive grep matches that failed the verification gate even though no real flag/key was present.
- **Fix:** Reworded comments to describe the behavior without the literal forbidden tokens (e.g. "no deep recursive signing", "real secure timestamp", "display/system-audio capture").
- **Files modified:** `yulu/scripts/build_audio_daemon.sh`, `yulu/scripts/build_status_agent.sh`, `yulu/scripts/Yulu.app.entitlements`
- **Verification:** `grep -L` confirms neither forbidden flag string appears; `grep -i screen-capture` returns nothing.
- **Committed in:** folded into `0e3d914` (Task 1) and `6ff903f`

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking). Both essential for correctness — the XML-comment bug would have shipped entitlements that strict signing/notarization tooling rejects. No scope creep.

## Issues Encountered
- None beyond the two auto-fixed deviations above.

## User Setup Required
None - no external service configuration required. (CI signing secrets `YULU_CODESIGN_IDENTITY` etc. are wired in plan 01-06, not here.)

## Next Phase Readiness
- The build scripts now produce hardened-runtime, secure-timestamped, entitled bundles — the prerequisite Apple notarization requires. Plan 01-06 (CI) plumbs notarytool credentials, stapling, and attestation; the clean-machine `spctl -a -vvv` proof is plan 06's human checkpoint (cannot be verified here without a real Developer ID signing run).
- Phase 2 note: switching the signing identity (Apple Development → Developer ID) and newly enabling the hardened runtime can invalidate existing TCC grants; `setup_audio.sh`'s reset/re-prompt path already covers the one-time re-prompt (documented in RESEARCH Runtime State Inventory).
- No blockers.

## Self-Check: PASSED

- Files verified on disk: `Yulu.app.entitlements`, `StatusAgent.app.entitlements`, `tests/test_entitlements_present.py`, `01-03-SUMMARY.md` — all FOUND.
- Commits verified in git log: `0e3d914`, `6ff903f`, `9d50541` — all FOUND.

---
*Phase: 01-build-foundation-setup-decomposition-signed-notarized-binari*
*Completed: 2026-05-30*
