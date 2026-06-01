---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
plan: 04
subsystem: infra
tags: [setup-decomposition, bash, dev-release-fork, swiftc, tcc, mlx-whisper, launchd, install-plist]

# Dependency graph
requires:
  - phase: 01-plan-02
    provides: "lib/common.sh — hoisted install_plist, launch_path (§6b), resolve_install_mode/detect_source (D-13), log helpers; the Standalone-or-Sourced skeleton"
  - phase: 01-plan-03
    provides: "signed + hardened-runtime Yulu.app / StatusAgent.app bundles + entitlements (the release binaries setup_audio.sh's release path now trusts unaided)"
provides:
  - "yulu/scripts/setup_audio.sh — dev/release fork (swiftc ONLY on dev) + Darwin-gated TCC reset/re-prompt walkthrough; no xattr quarantine strip on release (D-13, D-07, BUILD-03)"
  - "yulu/scripts/setup_capabilities.sh — host-python3 interpreter target, venv creation removed, dead mlx.python field dropped, mlx-whisper VERIFY-not-install (D-01/D-02/D-03/D-05)"
  - "yulu/scripts/setup_daemons.sh — launchd plist install/load via the HOISTED install_plist + the vocab/prompts/search seed steps (D-14, §8c)"
affects: [phase-01-plan-05-setup-orchestrator, phase-02-platform-impls, phase-03-interpreter-detection, phase-05-mlx-reuse, phase-06-provision-step-registry, phase-07-venv-migration]

# Tech tracking
tech-stack:
  added: []  # no new deps — bash + stdlib python3 inline idiom only; D-05 explicitly adds NO package install
  patterns:
    - "Dev/release fork in a concern script: mode=${1:-release}; dev branch is the ONLY place swiftc runs (build_audio_daemon.sh / build_status_agent.sh), release branch self-heals exec bits on pre-built signed+stapled binaries (D-13)"
    - "Quarantine strip (xattr -dr com.apple.quarantine) lives ONLY behind the --dev/ad-hoc guard — a stapled notarized release bundle passes Gatekeeper unaided (anti-pattern removed from the release path)"
    - "Platform-specific walkthroughs (TCC/tccutil/open/nc socket probe) gated behind [[ \"$(uname -s)\" == \"Darwin\" ]] with an early return off-Darwin"
    - "Verify-not-install for an optional runtime: importlib.util.find_spec('mlx_whisper') warns if absent, never fails the install (D-05 boundary; install/reuse deferred to Phase 5)"
    - "Concern scripts export PYTHON_BIN/NODE_BIN/SCRIPT_DIR/LAUNCH_AGENTS_DIR so the hoisted lib/common.sh install_plist reads them via env (Pitfall 5, no monolith globals)"

key-files:
  created:
    - yulu/scripts/setup_audio.sh
    - yulu/scripts/setup_capabilities.sh
    - yulu/scripts/setup_daemons.sh
  modified: []

key-decisions:
  - "setup_audio.sh exec-bit self-heal runs in BOTH branches (release zips drop +x; dev rebuilds can also land 0644), but swiftc and the xattr quarantine strip run ONLY in the dev branch — the release path has zero swiftc/xattr executable lines (asserted by plan-05 test_release_no_swiftc.py)"
  - "StatusAgent.app build (build_status_agent.sh, a swiftc compile) folded into the DEV branch alongside build_audio_daemon.sh — on release it's a pre-built stapled bundle that only needs the exec-bit self-heal (D-13: no swiftc on release)"
  - "D-03 implemented as mlx.pop('python', None) + mlx['model']=… inside the kept cfg.setdefault ladder: the dead field is dropped AND a stale venv path from an older install is normalized away on re-run; stt_daemon/config.py reads mlx.python only `if mlx.get('python')` so absence is harmless"
  - "D-02 stops CREATING the venv but never deletes an existing user's venv — orphaned-venv cleanup is explicitly a Phase 7 migration concern (Runtime State Inventory)"
  - "setup_daemons.sh interactive calendar prompt moved to the orchestrator; standalone opts in via YULU_INSTALL_CALENDAR=1 or, on --upgrade, inherits the prior decision if the calendar plist was already installed (non-interactive standalone, Pitfall 5)"
  - "Seed steps converted from the monolith's `A && ok || warn` to explicit if/then/else — behavior-identical (ok/warn always succeed) but shellcheck SC2015-clean, matching the clean-shellcheck criterion 01-02 established"

patterns-established:
  - "setup_audio.sh / setup_capabilities.sh / setup_daemons.sh complete the BUILD-01 six-concern set (with 01-02's deps/models/ui); each is the 1:1 seam Phase 6's `yulu provision <step>` registry will bind to"
  - "The dev/release fork pattern in setup_audio.sh is the template for any future concern that must avoid swiftc/Xcode on release installs (SC-1)"

requirements-completed: [BUILD-01, BUILD-03]

# Metrics
duration: 7min
completed: 2026-05-30
---

# Phase 1 Plan 4: Audio / Capabilities / Daemons Concern Extraction Summary

**The three higher-risk `setup.sh` concerns land as independent `set -uo pipefail` scripts: `setup_audio.sh` carries the dev/release fork (swiftc ONLY on `--dev`, pre-built signed+stapled binaries on release, the `xattr` quarantine strip removed from the release path) plus the Darwin-gated TCC re-prompt walkthrough for the Apple-Dev→Developer-ID identity change; `setup_capabilities.sh` stops creating the mlx virtualenv, drops the dead `mlx.python` field, points the daemon at host `python3`, and VERIFIES (does not install) mlx-whisper; `setup_daemons.sh` installs/loads every `com.yulu.*.plist` through the hoisted `lib/common.sh::install_plist` and keeps the vocab/prompts/search seed steps.**

## Performance

- **Duration:** 7 min
- **Started:** 2026-05-30T04:12:14Z
- **Completed:** 2026-05-30T04:19:00Z
- **Tasks:** 2 of 2
- **Files modified:** 3 created

## Accomplishments

- **BUILD-03 / D-13 dev-release fork:** `setup_audio.sh` runs `swiftc` (via `build_audio_daemon.sh` + `build_status_agent.sh`) ONLY in the `dev` branch; the `release` branch trusts the CI-built signed+stapled binaries and just self-heals exec bits. A release install needs no Xcode/swiftc (SC-1).
- **D-07 anti-pattern removed:** the `xattr -dr com.apple.quarantine` strip is gone from the release path (a stapled notarized bundle passes Gatekeeper unaided), kept only behind the explicit `--dev`/ad-hoc guard.
- **D-01/D-02/D-03/D-05 land in `setup_capabilities.sh`:** venv creation removed (system `python3` is the daemon interpreter via the plist `__PYTHON__`), the dead `transcription.mlx.python` field dropped + stale values normalized, and mlx-whisper importability VERIFIED (warn-not-fail) rather than installed.
- **D-14 / §8c in `setup_daemons.sh`:** every plist is installed/loaded through the single hoisted `lib/common.sh::install_plist` (zero local redefinition), with the §6b stable PATH inside that helper; the vocab/prompts/search seed steps are preserved.
- **Existing contract intact:** `pytest` stays green (**528 passed, 1 pre-existing skip**); all three scripts are `bash -n` clean, `shellcheck -x` clean, and proven to run standalone under `set -u` without unbound-variable aborts, idempotently.

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract setup_audio.sh (dev/release fork, no swiftc/xattr on release, TCC walkthrough)** — `c7b0567` (feat)
2. **Task 2: Extract setup_capabilities.sh (no venv, verify mlx) + setup_daemons.sh (hoisted install_plist)** — `456b7d7` (feat)

**Plan metadata:** committed separately with this SUMMARY + STATE/ROADMAP/REQUIREMENTS updates.

## Files Created/Modified

- `yulu/scripts/setup_audio.sh` (166 lines) — dev/release fork + exec-bit self-heal + Darwin-gated `tccutil reset`/`open Yulu.app`/`nc -U` socket readiness probe; extracted from `compile_audio_daemon` (402-494) + `setup_audio` (145-160).
- `yulu/scripts/setup_capabilities.sh` (100 lines) — `verify_mlx_whisper` (find_spec, advisory) + `write_mlx_to_config` with the `mlx.python` field dropped; extracted from `install_mlx_whisper` (607-619) + `write_mlx_to_config` (710-733), venv body deleted.
- `yulu/scripts/setup_daemons.sh` (148 lines) — per-plist install+load loop calling the hoisted `install_plist`, vocab/prompts/search seed steps, calendar conditional with the prompt hoisted to the orchestrator; extracted from `install_launchagents` (835-958), local `install_plist` (841-869) removed.

## Decisions Made

- **Exec-bit self-heal runs in both branches, swiftc/xattr only in dev.** Both dev rebuilds and release extractions can land binaries at 0644, so the `chmod +x` loop is unconditional; only `build_*.sh` (swiftc) and the `xattr` strip are dev-gated. The release branch contains zero executable swiftc/xattr lines (only comments stating their absence) — exactly what `test_release_no_swiftc.py` (plan 05) will assert.
- **StatusAgent build folded into the dev branch.** `build_status_agent.sh` is a swiftc compile, so per D-13 it belongs with `build_audio_daemon.sh` in dev; on release the StatusAgent bundle is pre-built+stapled and only needs the exec-bit self-heal.
- **D-03 via `mlx.pop('python', None)` + normalize.** Dropping the field on fresh writes AND popping any stale venv path on re-run, inside the kept `cfg.setdefault` ladder. Verified against `stt_daemon/config.py` (reads `mlx.python` only `if mlx.get('python')`; `mlx_python` defaults to `""`), so an absent field is harmless.
- **Calendar prompt → orchestrator; standalone is non-interactive (Pitfall 5).** Standalone opts in via `YULU_INSTALL_CALENDAR=1`, or on `--upgrade` inherits the prior decision (refresh only if the calendar plist already exists). No `read` in standalone scope.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded `venv-mlx-whisper` / `open -W` literal strings out of comments to satisfy the verify gates**
- **Found during:** Task 2 (capabilities + daemons verification)
- **Issue:** The plan's automated `verify` block asserts `! grep -q 'venv-mlx-whisper' setup_capabilities.sh` and the acceptance gate counts `open -W` occurrences in `setup_daemons.sh` must be 0. My explanatory comments contained those literal trigger strings (e.g. "Removed … `venv-mlx-whisper`", "leaves the `open -W` form's tokens untouched"), which would trip the grep gates even though the *behavior* was correct.
- **Fix:** Reworded the comments to describe the same intent without the literal tokens ("a dedicated mlx virtualenv under ~/.config/yulu/", "the audiodaemon plist's launch form / §8b"). No code-path change.
- **Files modified:** yulu/scripts/setup_capabilities.sh, yulu/scripts/setup_daemons.sh
- **Verification:** `grep -Ec 'venv-mlx-whisper|python -m venv|m venv' setup_capabilities.sh` == 0; `grep -c 'open -W' setup_daemons.sh` == 0; plan's exact verify block prints PASS.
- **Committed in:** `456b7d7` (Task 2 commit)

**2. [Rule 1 - Bug] Converted the verbatim-lifted seed steps from `A && ok || warn` to explicit `if/then/else` (SC2015)**
- **Found during:** Task 2 (setup_daemons.sh shellcheck)
- **Issue:** The seed block lifted from `install_launchagents` (917-932) uses `cmd && ok … || warn …`; `shellcheck -x` flags SC2015 (info: C may run when A is true). The acceptance criterion requires `shellcheck -x` clean, and CI runs shellcheck — info-severity findings make shellcheck exit non-zero by default.
- **Fix:** Rewrote the three seed steps as `if cmd; then ok …; else warn …; fi`. Behavior-identical here (`ok`/`warn` are `printf` wrappers that always succeed, so the original `|| warn` only ever fired when the command failed), now SC2015-clean.
- **Files modified:** yulu/scripts/setup_daemons.sh
- **Verification:** `shellcheck -x setup_daemons.sh` clean; seed steps still present (`grep -Eq 'vocab|prompts|search'`); standalone run reaches `✓ 服务已安装`.
- **Committed in:** `456b7d7` (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 blocking grep-gate satisfaction, 1 SC2015 bug-class cleanup)
**Impact on plan:** Both are mechanical cleanups required to pass the plan's own verify/acceptance gates and the established clean-shellcheck criterion. No code-path or behavior change, no scope creep. No package installs (D-05 boundary held — `setup_capabilities.sh` adds no install path). No architectural changes.

## Issues Encountered

- During standalone-isolation testing, an early test-harness invocation falsely reported "install_plist missing" and a spurious "unbound" match — both were artifacts of a malformed subshell test command (`... || true; declare` chaining + a `grep` matching my own echo), not the scripts. Re-running with clean `bash -c 'set -uo pipefail; . setup_daemons.sh; declare -f install_plist'` confirmed `install_plist` resolves to the HOISTED `lib/common.sh` copy (it calls `launch_path`), and a real standalone run emitted no `unbound variable` errors. No code change needed.

## Threat Surface

No new security surface beyond the plan's `<threat_model>`. The plan's mitigations were honored:
- **T-01-09 (mitigate):** the `xattr` strip is removed from the release path — the release fork trusts the notarized+stapled (plan 06) + SHA-256-verified binaries; Gatekeeper now does the integrity check.
- **T-01-SC (mitigate):** `setup_capabilities.sh` VERIFIES mlx-whisper importability but adds NO `pip install` (or any package-manager) path this phase. No `[ASSUMED]`/`[SUS]` package introduced.

## User Setup Required

None — no external service configuration required by this plan. (CI signing secrets named in 01-PATTERNS are a plan-06 concern.)

## Next Phase Readiness

- **For plan 01-05 (orchestrator):** all six `setup_*.sh` concerns now exist. The orchestrator resolves `mode="$(resolve_install_mode "$@")"` once and passes `$mode` to each, owning all interactive prompts (the deps confirmation, the calendar `[y/N]`, the audio walkthrough framing). `setup.sh`'s main sequence (1318-1335) is NOT yet rewired — that is plan 01-05's job, as is the `install.sh` Xcode pre-flight `--dev`-gating (Pitfall 6) and the plan-05 tests (`test_setup_decomposition.py`, `test_release_no_swiftc.py`).
- **For plan 01-06:** the release binaries `setup_audio.sh` trusts are notarized+stapled in CI by plan 06; until then a clean-machine release install would still warn (expected — the fork is correct, the staple lands in 06).
- **Carried-forward concern (Phase 7):** orphaned-venv cleanup — `setup_capabilities.sh` stops creating the mlx virtualenv but does not delete an existing user's; a migration should remove the stale `~/.config/yulu/venv-mlx-whisper` on upgrade.
- **Do-not-regress (Phase 2 / §8b):** `setup_daemons.sh` leaves `com.yulu.audiodaemon.plist`'s launch form untouched — `install_plist` substitutes only the tokens present, so the audiodaemon plist (no `__PATH__`/`__PYTHON__`) is not altered.

## Self-Check: PASSED

- All three created scripts verified present on disk: `setup_audio.sh`, `setup_capabilities.sh`, `setup_daemons.sh`.
- SUMMARY verified present.
- Both task commits verified in git log: `c7b0567`, `456b7d7`.

---
*Phase: 01-build-foundation-setup-decomposition-signed-notarized-binari*
*Completed: 2026-05-30*
