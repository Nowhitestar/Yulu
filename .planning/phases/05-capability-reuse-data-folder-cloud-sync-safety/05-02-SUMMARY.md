---
phase: 05-capability-reuse-data-folder-cloud-sync-safety
plan: 02
subsystem: infra
tags: [capability-reuse, homebrew, mlx-whisper, whisper-cpp, gog, tri-state, doctor, bash, pytest]

# Dependency graph
requires:
  - phase: 03-capability-detection
    provides: HostCapabilityReport tri-state contract (capabilities/report.py, probe_command), doctor.py --json host_capabilities section
  - phase: 01-build-foundation
    provides: decomposed setup_deps.sh / setup_capabilities.sh + lib/common.sh shared helpers (no venv, no pip)
provides:
  - gog capability probe in doctor.py host_capabilities (closes RESEARCH Open-Q1)
  - capability_status() bash helper in lib/common.sh (resolve-not-execute reuse gate)
  - setup_deps.sh gates brew install whisper-cpp + steipete/tap/gogcli on tri-state == usable
  - setup_capabilities.sh reuse-message gate for mlx_whisper (no pip install added)
  - tests/test_reuse_gating.py — parametrized REUSE-01/02 skip/install proof
affects: [phase-07-migration, capability-reuse, setup-scripts]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Reuse gate reads doctor.py --json host_capabilities.capabilities.<cap>.status; gates STRICTLY on == usable (never a boolean)"
    - "capability_status() echoes only the tri-state string; never interpolates resolved_path into a shell (resolve-not-execute)"
    - "Any doctor failure -> absent -> install (safe default; a slow/broken doctor never over-skips)"

key-files:
  created:
    - tests/test_reuse_gating.py
  modified:
    - yulu/scripts/doctor.py
    - yulu/scripts/capabilities/probes.py
    - yulu/scripts/lib/common.sh
    - yulu/scripts/setup_deps.sh
    - yulu/scripts/setup_capabilities.sh

key-decisions:
  - "gog added as a host CLI (host-path provenance) in doctor.py, NOT as a CapabilityProvider entry — D-06 provider neutrality preserved"
  - "Reuse gate is string-equality on == usable; present-but-unverified AND absent both install (Pitfall 4 — the boolean-collapse bug the tri-state exists to prevent)"
  - "setup_capabilities.sh gate changes only the MESSAGE (reuse vs advise) — NO venv, NO pip install on either branch (D-02/D-05 honored; a second Yulu venv is Out-of-Scope)"
  - "capability_status reads host_capabilities.capabilities.<cap>.status — the doctor --json wrapper key, confirmed end-to-end (RESEARCH Open-Q2 resolved)"

patterns-established:
  - "Pattern: tri-state reuse gate (capability_status whisper_cli/gog/mlx_whisper -> install only when not usable)"
  - "Pattern: no-boolean-collapse guard — present-but-unverified MUST install (test_present_but_unverified_never_skips is the regression guard)"

requirements-completed: [REUSE-01, REUSE-02]

# Metrics
duration: 13min
completed: 2026-05-30
---

# Phase 5 Plan 02: Detect-First Reuse Gating Summary

**Reuse-first install: a host whisper-cli / mlx-whisper / gog reported `usable` by the Phase-3 tri-state now skips Yulu's own brew/mlx install (strict `== usable`, never a boolean); gog probe added to `doctor.py` to close the REUSE-01 wording gap.**

## Performance

- **Duration:** 13 min
- **Started:** 2026-05-30T10:16:27Z
- **Completed:** 2026-05-30T10:30:01Z
- **Tasks:** 3
- **Files modified:** 5 (4 modified, 1 created)

## Accomplishments
- Added the missing `gog` capability probe to `doctor.py:_host_capabilities` (`probe_command("gog", ("--version",))`, host-path provenance) — closes RESEARCH Open-Q1; `gog` is now in `host_capabilities.capabilities` so its install can be gated. Provider neutrality (D-06) untouched — gog is a host CLI, not an agent-config reframe.
- Added `capability_status()` to `lib/common.sh`: runs `doctor.py --json` with FIXED argv, parses `host_capabilities.capabilities.<cap>.status` in Python, echoes ONLY the tri-state status, degrades to `absent` on any failure. Never interpolates `resolved_path` into a shell (T-05-04; resolve-not-execute discipline preserved, `llm.command` never run).
- Gated `setup_deps.sh`: `brew install whisper-cpp` (REUSE-02) and `steipete/tap/gogcli` (REUSE-01) are now installed only when their tri-state is NOT `usable`. `sox`/`ffmpeg`/`terminal-notifier`/`cloudflared` stay unconditional. Never silently mutates the host package manager (D-05).
- Gated `setup_capabilities.sh`: when `mlx_whisper` is `usable`, emit the reuse message and skip the advisory verify; else keep `verify_mlx_whisper`. NO venv, NO pip install on either branch (D-02/D-05; the gate changes only the message).
- Added `tests/test_reuse_gating.py` (19 cases): parametrized tri-state -> skip/install across `whisper_cli`/`mlx_whisper`/`gog`, plus missing-key / malformed-report / missing-section cases all -> `absent` -> install. The `present-but-unverified -> install` cases are the explicit regression guard for the Pitfall-4 boolean-collapse bug.

## Task Commits

Each task was committed atomically:

1. **Task 1: Add the gog capability probe to host_capabilities** - `1734de8` (feat)
2. **Task 2: capability_status() + gate setup_deps.sh and setup_capabilities.sh** - `b183677` (feat)
3. **Task 3: Wave-0 parametrized reuse-gate test** - `74f38c2` (test)

**Plan metadata:** _(this SUMMARY + STATE/ROADMAP/REQUIREMENTS — see final docs commit)_

_Note: Task 3 was `tdd="true"`. The unit under test is the decision contract the production gate (Task 2) satisfies; the test was authored as the executable proof of D-04 + Pitfall 4 and verified to FAIL under a boolean-collapse gate before committing GREEN. Because the gate logic is bash (`capability_status` + `[[ ... == usable ]]`) and the test is OS-agnostic Python over the frozen `capabilities.report` contract, RED/GREEN are a single proof commit rather than separate test->feat commits._

## Files Created/Modified
- `yulu/scripts/doctor.py` - `_host_capabilities` adds a `gog` entry via `probe_command("gog", ("--version",))` after `recording_dir`; whole-body try/except-degrade intact; no provider changed.
- `yulu/scripts/capabilities/probes.py` - one-line docstring: `gog` is now among `probe_command`'s callers (no logic change).
- `yulu/scripts/lib/common.sh` - new `capability_status()` helper (section 1b); reads `host_capabilities.capabilities.<cap>.status`; defaults to `absent`.
- `yulu/scripts/setup_deps.sh` - whisper-cpp + gogcli installs gated on `capability_status … == usable`; base tools + cloudflared unconditional; package-list message updated to flag the reuse-gated formulae.
- `yulu/scripts/setup_capabilities.sh` - `mlx_whisper` reuse-message gate around `verify_mlx_whisper`; no venv, no pip install.
- `tests/test_reuse_gating.py` - parametrized REUSE-01/02 skip/install proof (19 cases) at repo-root `tests/`.

## Decisions Made
- **gog placement:** added in `doctor.py` directly (host-path), NOT in any `CapabilityProvider` — REUSE-01 names gog as a host tool, and D-06 keeps providers agent-config-only.
- **Strict `== usable` gate:** all three gates use `[[ "$(capability_status X)" == "usable" ]]`. `present-but-unverified` and `absent` both install. No `-n "$status"`, no `!= "absent"` anywhere (verified by grep in the plan's verification section).
- **setup_capabilities behavior unchanged on install side:** Phase 1 already removed the venv/pip; this plan adds NO pip install (Out-of-Scope second venv). The gate only swaps the advisory verify for a reuse `ok` message when MLX is usable.
- **JSON nesting confirmed end-to-end:** `doctor.py --json` wraps the report at top level under `host_capabilities`, then `.capabilities.<cap>.status` (RESEARCH Open-Q2 resolved by running `doctor.py --json` during pre-flight, not just inferring).

## Deviations from Plan

None - plan executed exactly as written. (RESEARCH Open-Q1 "who adds the gog probe" and Open-Q2 "exact JSON nesting" were both pre-resolved at planning time and confirmed during pre-flight; no architectural or bug-fix deviations were needed.)

## Issues Encountered
None. All three task verifications, the plan's full `<verification>` section, `bash -n`, `shellcheck -P SCRIPTDIR -x`, and the full pytest suite passed on the first complete run.

## Threat Surface
No new security surface beyond the plan's `<threat_model>`. The single new trust-boundary crossing (doctor JSON -> bash) is mitigated exactly as planned: `capability_status` uses FIXED argv + Python JSON parse, emits only `status`, and never interpolates `resolved_path` into a shell (T-05-04). The plan REDUCES installs (gates two brew formulae) and adds NO package (T-05-SC; slopcheck N/A).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- REUSE-01/02 complete: usable host whisper-cli / mlx-whisper / claude / gog are reused; gog is now in the report.
- Wave 1 sibling: ran independently of Plans 01 (path split) and 03 (cloud-detect) — no shared files touched.
- **Carry-forward (already tracked in STATE blockers):** Phase 7 migration should still remove a stale `~/.config/yulu/venv-mlx-whisper` from old installs — this plan only gates the message, it does not delete an existing user's orphaned venv.

## Self-Check: PASSED

- `tests/test_reuse_gating.py` — FOUND
- `1734de8` (Task 1), `b183677` (Task 2), `74f38c2` (Task 3) — all FOUND in git log
- `capability_status` present in `lib/common.sh`, gated in both setup scripts — FOUND
- No boolean-collapse (`-n "$status"` / `!= "absent"`) — NONE (good)
- Full pytest: 691 passed, 3 skipped (exit 0)

---
*Phase: 05-capability-reuse-data-folder-cloud-sync-safety*
*Completed: 2026-05-30*
