---
phase: 07-seamless-auto-migration
plan: 02
subsystem: migration
tags: [migration, recording-guard, daemon-stop, data-loss, launchctl, audio-daemon]

# Dependency graph
requires:
  - phase: 02-cross-platform-abstraction
    provides: MacOSDaemonManager.unload (clean launchctl unload, no pkill) + the open-W→direct-launch fix (D-06) that removed the orphan forcing forced-kill
  - phase: 07-seamless-auto-migration (plan 01)
    provides: migrate/ package scaffold (detect.py, plan.py) — guard.py is the third sibling module
provides:
  - "migrate/guard.py — recording-active probe (defers to audio_daemon status socket) + stop_daemons_guarded refusing daemon-stop while a recording is in flight"
  - "RecordingActive(RuntimeError) carrying live recording .info (title/path) — consumed by Plan 03 apply.py"
affects: [07-03 apply-verify-rollback-cli, migration-data-loss-prevention]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Recording-active arbiter = audio_daemon status socket (never a guessed PID, never the start-handshake advisory lock) — mirrors record_audio._raise_if_daemon_recording byte-for-byte"
    - "Refuse-don't-force: a guard that raises rather than truncating an in-flight capture; the refusal carries .info naming what is recording"
    - "Static source-grep acceptance gate baked into the test suite (zero forced-kill occurrences) — the MIG-02 control is machine-asserted, not just prose"
    - "Lazy + guarded cross-module imports (record_audio, recording_lock, MacOSDaemonManager) so a Darwin-gated module imports cleanly off-Darwin and degrades rather than crashing migration"

key-files:
  created:
    - yulu/scripts/migrate/guard.py
    - tests/test_migrate_recording_guard.py
  modified: []

key-decisions:
  - "[07-02] recording_active reuses record_audio.socket_send (lazy/guarded import) rather than hand-rolling a second socket client — the audio_daemon status socket is the SOLE recording arbiter; a None/absent/keyless status degrades to False (a down daemon is not recording, T-07-06)"
  - "[07-02] guard.py contains ZERO forced-kill (pkill) and ZERO fcntl/flock — asserted by two static source-grep tests; the literal 'pkill'/'flock' tokens were scrubbed from docstrings too so the gates pass against the file's own prose (the gate scans the whole file, docstrings included)"
  - "[07-02] stop_daemons_guarded checks recording_active FIRST and raises RecordingActive BEFORE touching manager.unload (assert unload count 0 while recording) — the headline MIG-02 / T-07-04 data-loss control; .recording.lock metadata only ENRICHES the refusal (stale lock can't itself trigger a refusal, T-07-07)"
  - "[07-02] MacOSDaemonManager() instantiated directly (the proven idiom) — NOT routed through a non-existent get_platform() accessor (referenced only inside a degrading try/except in state.py, never defined in yulu_platform/__init__.py)"

patterns-established:
  - "Pattern: recording-guard — query the daemon's own recording flag and refuse (raise) rather than force-stop; defer to the canonical arbiter, never PID-guess or misuse the start-handshake lock"
  - "Pattern: MIG-02 no-forced-kill gate — a non-comment source grep asserting zero pkill occurrences lives in the test, making the safety property a CI-enforced invariant"

requirements-completed: [MIG-02]

# Metrics
duration: 10min
completed: 2026-05-30
---

# Phase 7 Plan 02: Migration Recording-Guard Summary

**`migrate/guard.py` refuses to stop ANY daemon while the audio_daemon reports a live recording (raises `RecordingActive`, zero unloads) and otherwise clean-stops the eight `com.yulu.*` jobs via `MacOSDaemonManager.unload` — with no forced-kill path anywhere, asserted by a static source grep.**

## Performance

- **Duration:** 10 min
- **Started:** 2026-05-30T14:12:38Z
- **Completed:** 2026-05-30T14:21:49Z
- **Tasks:** 2
- **Files modified:** 2 (both created)

## Accomplishments
- `recording_active(socket_send=None)` — defers to the audio_daemon status socket as the canonical "is recording" arbiter, mirroring `record_audio._raise_if_daemon_recording` (`status and status.get("recording") is True`); degrades to `False` on a down/absent/keyless socket so it never blocks migration (T-07-06).
- `stop_daemons_guarded(...)` — checks `recording_active` FIRST; raises `RecordingActive` (carrying live recording metadata from `.recording.lock`) with **zero** `manager.unload` calls while recording (T-07-04, the headline MIG-02 control); otherwise clean-stops each of the eight `com.yulu.*` labels via `MacOSDaemonManager.unload` (`launchctl unload`) in order.
- **No forced-kill path anywhere** in the module — a non-comment source grep returns 0 (T-07-05); the Phase 2 direct-launch fix (D-06) made `launchctl unload` clean, so no signal escalation is needed.
- Module imports cleanly off-Darwin (all cross-module imports lazy + guarded); full repo suite stays green (791 passed, 1 pre-existing skip).

## Task Commits

Each task was committed atomically (plan-level TDD: one RED test commit covering both tasks, then one GREEN implementation commit):

1. **TDD RED (Tasks 1+2): failing recording-guard tests** — `bb1de98` (test)
2. **TDD GREEN (Tasks 1+2): guard.py implementation** — `f407338` (feat)

_Tasks 1 and 2 share one module (`migrate/guard.py`) and one test file; implemented in a single GREEN pass after the shared RED gate. No REFACTOR commit — the module was clean and minimal as written._

## Files Created/Modified
- `yulu/scripts/migrate/guard.py` (148 lines) — `recording_active` probe, `RecordingActive(RuntimeError)` with `.info`, `stop_daemons_guarded` refuse-or-clean-stop; `DEFAULT_LABELS` (eight `com.yulu.*`, audiodaemon first). stdlib only, lazy+guarded imports.
- `tests/test_migrate_recording_guard.py` (11 tests) — recording_active True/False/None/missing-key/import-degrade + no-fcntl source gate; stop_daemons_guarded refuse-while-recording (unload count 0), `.info` enrichment from fixture lock, clean-stop per label in order, eight default labels audiodaemon-first, static no-pkill grep gate.

## Decisions Made
- Reused `record_audio.socket_send` as the recording arbiter (lazy/guarded import) instead of a second socket client — single source of truth, inherits its 5s timeout + None-on-error semantics.
- Scrubbed the literal `pkill` and `flock` tokens out of the module's own docstrings: the two static MIG-02 acceptance gates (`no pkill`, `no fcntl/flock`) scan the *entire* file including comments/docstrings, so explanatory prose using those words would (correctly) trip the gate. Concepts are described as "forced-kill" / "advisory lock" instead.
- `stop_daemons_guarded` reads `.recording.lock` metadata **only to enrich** the refusal message; the live socket is the sole authority, so a stale lock cannot by itself trigger a refusal (T-07-07).

## Deviations from Plan

None - plan executed exactly as written. (The docstring token-scrub is not a deviation: the plan's own acceptance criteria mandate a zero-`pkill` / no-`fcntl` source grep over the whole file, and the test asserts exactly that. Keeping the literals out of prose is how the file satisfies its specified gates.)

## Issues Encountered
- First GREEN run had 2 failures (`test_no_pkill_anywhere_in_guard_source`, `test_guard_does_not_import_fcntl_or_flock`) — the static gates caught the literal `pkill -9` / `flock` strings in my own explanatory docstrings. Resolved by rewriting the prose to "forced-kill" / "advisory lock" without changing any logic; both gates and all 11 tests then passed. This is the gate working as designed (it can't tell prose from code, and that's the point — the safety property must hold over the literal source).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- `RecordingActive` + `stop_daemons_guarded` are the contract Plan 03 (`apply.py`) consumes: apply must call the guard before stopping daemons and surface `RecordingActive` as a "stop your recording, then retry" refusal (never a half-migration).
- The clean-stop path composes Phase 2 D-06; no `pkill` debt carried forward.
- Plan 01 (detect/plan) and Plan 02 (guard) are the read-only + safety front of the pipeline; the transactional half (apply/verify/rollback) + the `yulu migrate`/`yulu rollback` CLI remain for Plan 03.

## Self-Check: PASSED

- FOUND: `yulu/scripts/migrate/guard.py`
- FOUND: `tests/test_migrate_recording_guard.py`
- FOUND: `.planning/phases/07-seamless-auto-migration/07-02-SUMMARY.md`
- FOUND commit: `bb1de98` (test RED)
- FOUND commit: `f407338` (feat GREEN)
- TDD gates in order: `test(07-02)` → `feat(07-02)`
- Full pytest: 791 passed, 1 pre-existing skip
- No-pkill gate: 0; no-fcntl gate: pass; stub scan: clean

---
*Phase: 07-seamless-auto-migration*
*Completed: 2026-05-30*
