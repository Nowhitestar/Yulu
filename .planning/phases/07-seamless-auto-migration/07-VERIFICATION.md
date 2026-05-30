---
phase: 07-seamless-auto-migration
verified: 2026-05-30T23:05:00Z
status: human_needed
score: 14/14 automatable must-haves verified
overrides_applied: 0
human_verification:
  - test: "Real v0.5.x ~/.yulu end-to-end upgrade (MIG-01)"
    expected: "On a machine/VM with a genuine v0.5.x ~/.yulu (schema_version absent / old layout, real recordings + transcripts + vocab.sqlite + prompts.sqlite + summaries): `yulu migrate --dry-run` lists the corrections without changing anything; `yulu migrate` leaves all data intact, daemons start, config.json no longer has transcription.mlx.python, audio.output_dir correct (custom path untouched), .yulu-install.json carries schema_version AND original source, no reconfiguration prompted, and the <name>.backup-* sibling is pruned after the verified success."
    why_human: "Requires a real legacy install + the full launchd daemon stack — the live PathResolver.data_dir resolution and a real launchctl unload/start cycle cannot be exercised in fixtures."
  - test: "Live in-flight-recording guard (MIG-02)"
    expected: "Start a recording (`yulu record start \"guard test\"`), then while it is still recording trigger `yulu migrate` -> it REFUSES to stop the audio daemon (prints the recording-active refusal naming the live recording), leaves the WAV un-truncated, does NOT half-migrate. Stop the recording, re-run `yulu migrate` -> it now proceeds."
    why_human: "Requires a live audio_daemon actively writing a WAV; the recording-active arbiter is the real daemon status socket, which cannot be a fixture for the truncation-prevention behavior end-to-end."
---

# Phase 7: Seamless Auto-Migration Verification Report

**Phase Goal:** An existing v0.5.x `~/.yulu` install upgrades to the new model with no data loss and no reconfiguration — guarding active recordings, transactional with rollback, reclaiming backups only after verified success.
**Verified:** 2026-05-30T23:05:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

All code-automatable truths are VERIFIED in the actual codebase and fixture-proven (819 passed, 1 skipped; 59 migrate-specific tests green). Two live-install confirmations (the `checkpoint:human-verify` Task 4 in 07-03) require a real legacy install + daemon stack and are routed to human verification — code is complete and fixture-tested, NOT gapped.

| #  | Truth | Status | Evidence |
| -- | ----- | ------ | -------- |
| 1  | v0.5.x `~/.yulu` (schema_version absent / old layout) is DETECTED as needing migration | VERIFIED | `detect.py:155-187` compares ledger `schema_version` vs imported `SCHEMA_VERSION`; absent → needs_migration=True, from_schema=None; corroborated by legacy mlx.python + venv markers. Tests: `test_migrate_detect.py` (20 tests). |
| 2  | A current install (schema_version == current) is detected as up-to-date (no migration) | VERIFIED | `detect.py:155-161` returns needs_migration=False, empty reasons when `from_schema >= SCHEMA_VERSION`. |
| 3  | `yulu migrate --dry-run` lists planned steps without mutating anything | VERIFIED | `cli.py:131-135` prints `plan.render()`, returns 0, no apply. Smoke-run on non-existent tree printed 3 corrections, exit 0, zero mutation. `plan.py` does zero filesystem I/O. |
| 4  | Plan names the 3 in-transit corrections (drop mlx.python, route ~/Movies/Yulu via PathResolver, stamp schema_version) | VERIFIED | `plan.py:96-118` emits exactly the 3 PlanSteps with stable names/kinds; empty plan when up-to-date. |
| 5  | Migration REFUSES to stop any daemon while a recording is active | VERIFIED | `guard.py:128-136` checks `recording_active()` FIRST, raises `RecordingActive` before any `manager.unload`. Test `test_stop_refuses_and_never_unloads_while_recording` asserts unload call-count 0. |
| 6  | When not recording, daemons stop via DaemonManager clean-stop (launchctl unload) — never pkill | VERIFIED | `guard.py:138-148` instantiates `MacOSDaemonManager`, calls `unload(label)` per label in order. Test `test_stop_unloads_each_label_in_order_when_idle`. |
| 7  | No `pkill` / `pkill -9` / SIGKILL path exists anywhere in migrate/ | VERIFIED | grep across `migrate/*.py`: ZERO `pkill`, `kill -9`, `SIGKILL` (raw + non-comment count 0). Tests `test_no_pkill_anywhere_in_guard_source`, `test_apply_source_has_no_pkill`. |
| 8  | Recording-active arbiter is the audio_daemon status socket, not a guessed PID | VERIFIED | `guard.py:93-97` mirrors `record_audio._raise_if_daemon_recording` (`status and status.get("recording") is True`); no fcntl/flock import (test `test_guard_does_not_import_fcntl_or_flock`). |
| 9  | Transactional: backup taken BEFORE apply; failed verify keeps backup; `yulu rollback` restores prior state byte-for-byte | VERIFIED | `apply.py:322` backup via `move_existing_runtime_to_backup` BEFORE any mutation; `apply.py:346-358` exception → `restore_backup` + re-raise; `rollback()` wraps `restore_backup`. Tests `test_apply_takes_backup_before_mutation`, `test_rollback_restores_byte_for_byte`, `test_apply_rolls_back_on_midapply_error`. |
| 10 | Backup pruned ONLY after verify passes (failed verify never prunes) | VERIFIED | `verify.py:123-128` `finalize` prunes only when `result.ok` AND `verify_migration` pass; failed verify returns False, backup retained. Tests `test_finalize_prunes_backup_only_on_verify_pass`, `test_finalize_keeps_backup_on_verify_fail`. |
| 11 | apply drops dead `transcription.mlx.python`, routes ~/Movies/Yulu via PathResolver, stamps schema_version, PRESERVES `.yulu-install.json` source | VERIFIED | `apply.py:202-258`: `_apply_drop_mlx_python` pops the field; `_apply_route_recording_dir` rewrites only the hardcoded default (custom untouched); `_apply_schema_stamp` → `state.mark` preserves source via setdefault (`state.py:196-207`). Tests `test_drop_mlx_python_*`, `test_route_recording_dir_*`, `test_schema_stamp_preserves_source` (release + dev). |
| 12 | No data loss: recordings/transcripts/vocab/prompts/summaries survive the migration | VERIFIED | `apply.py:322-329` moves tree to pristine backup then copies a working copy back, corrects in place; data tree intact. Test `test_apply_loses_no_data` asserts recordings/transcripts/vocab.sqlite/prompts.sqlite/summaries present byte-for-byte after apply. |
| 13 | apply calls the recording-guard before stopping daemons (refuses while recording); no pkill | VERIFIED | `apply.py:302-312` calls `stop_daemons_guarded` FIRST; `RecordingActive` → refused result (ok=False, backup=None) with ZERO mutation. Test `test_apply_refuses_while_recording_zero_mutation`. |
| 14 | `yulu migrate` (detect→plan→apply→verify, --dry-run-able) and `yulu rollback` wired into the CLI dispatcher | VERIFIED | `cli.py` composes all 4 stages; `yulu:318-319` dispatches `migrate)`/`rollback)` → `-m migrate.cli`. `bash -n yulu` OK. Tests `test_migrate_cli.py` (7 tests). |
| H1 | Real v0.5.x end-to-end upgrade (no data loss, no reconfig, source preserved, backup pruned) | HUMAN-NEEDED | 07-03 Task 4 `checkpoint:human-verify`; requires a live legacy install + daemon stack (07-VALIDATION.md "Manual-Only Verifications"). Code complete + fixture-tested. |
| H2 | Live in-flight-recording refusal (no truncated WAV; proceeds after recording ends) | HUMAN-NEEDED | 07-03 Task 4; requires a live audio_daemon writing a WAV. Code complete + fixture-tested. |

**Score:** 14/14 automatable truths verified (2 additional truths routed to human verification)

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `yulu/scripts/migrate/detect.py` | v0.5.x detection from schema_version + layout | VERIFIED | 197 lines; `detect_migration` + `MigrationNeed`; imports `SCHEMA_VERSION` from `provision.state`; never raises; zero mutation. Imported by plan.py + apply.py + cli.py. |
| `yulu/scripts/migrate/plan.py` | dry-run-able MigrationPlan | VERIFIED | 119 lines; `build_plan` + `MigrationPlan` + `PlanStep`; 3 stable correction steps; zero I/O. Imported by apply.py + cli.py. |
| `yulu/scripts/migrate/guard.py` | recording-active probe + clean daemon-stop | VERIFIED | 148 lines; `recording_active` + `RecordingActive` + `stop_daemons_guarded`; guard-first, no pkill. Imported by apply.py. |
| `yulu/scripts/migrate/apply.py` | transactional backup→guarded-stop→corrections→mark; rollback | VERIFIED | 403 lines; `apply_migration` + `rollback` + `MigrationResult`; backup-first, source-preserving, reversible. Imported by cli.py. |
| `yulu/scripts/migrate/verify.py` | post-migration doctor gate + prune-on-success-only | VERIFIED | 128 lines; `verify_migration` + `prune_backup` + `finalize`; fail-closed. Imported by cli.py. |
| `yulu/scripts/migrate/cli.py` | `yulu migrate` + `yulu rollback` | VERIFIED | 230 lines; `main` composes 4 stages; argparse subcommands. Wired into `yulu` dispatcher. |
| `yulu/scripts/yulu` | dispatcher cases | VERIFIED | Lines 318-319: `migrate)` / `rollback)` → `-m migrate.cli`. `bash -n` passes. |
| `tests/test_migrate_detect.py` | detect + dry-run coverage | VERIFIED | 20 tests, all pass. |
| `tests/test_migrate_recording_guard.py` | refuse-while-recording + no-pkill coverage | VERIFIED | 11 tests, all pass. |
| `tests/test_migrate_apply_rollback.py` | transactional/rollback/prune/no-data-loss coverage | VERIFIED | 13 tests, all pass. |
| `tests/test_migrate_corrections.py` | drop mlx / route / stamp / preserve source coverage | VERIFIED | 8 tests, all pass. |
| `tests/test_migrate_cli.py` | CLI pipeline coverage | VERIFIED | 7 tests, all pass (not in PLAN frontmatter but adds CLI dispatch coverage). |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| `detect.py` | `release_installer.read_install_metadata` | read `.yulu-install.json` schema_version | WIRED | `detect.py:150` reads ledger via `read_install_metadata`; compares `schema_version`. |
| `plan.py` | `migrate.detect.MigrationNeed` | plan built from detect result | WIRED | `plan.py:36` imports `MigrationNeed`; `build_plan(need)` dispatches on `need.needs_migration`. |
| `guard.py` | audio_daemon status socket | `socket_send({action: status}).recording` | WIRED | `guard.py:94` sends `{"action": "status"}`, reads `.get("recording")`. |
| `guard.py` | `MacOSDaemonManager.unload` | clean launchctl unload, no pkill | WIRED | `guard.py:143-148` instantiates manager, calls `unload(label)`. |
| `apply.py` | `migrate.guard.stop_daemons_guarded` | recording-guarded stop before mutating | WIRED | `apply.py:303` calls guard FIRST; `RecordingActive` → refused result. |
| `apply.py` | `release_installer.move_existing_runtime_to_backup` / `restore_backup` | transactional backup + rollback | WIRED | `apply.py:322` backup; `apply.py:350,382` restore. |
| `apply.py` | `provision.state.mark` | schema_version stamp preserving source | WIRED | `apply.py:257` calls `state.mark`; `state.py:196-207` preserves source via setdefault. |
| `verify.py` | `doctor._host_capabilities` | post-migration capability re-detection gates prune | WIRED | `verify.py:55-60` calls `doctor._host_capabilities` directly (resolve-not-execute). |
| `yulu` | `migrate.cli` | `migrate)` / `rollback)` dispatcher cases | WIRED | `yulu:318-319` both dispatch `-m migrate.cli`. |

### Data-Flow Trace (Level 4)

The migrate module is CLI/pipeline code (not a dynamic-data renderer). The data-flow concern here is whether the in-transit corrections actually transform real config/ledger data — verified via fixtures:

| Artifact | Data Variable | Source | Produces Real Data | Status |
| -------- | ------------- | ------ | ------------------ | ------ |
| `apply._apply_drop_mlx_python` | `config.json` transcription.mlx | real file read/atomic-write | Yes — field popped, siblings preserved (test asserts) | FLOWING |
| `apply._apply_route_recording_dir` | `audio.output_dir` | real file + PathResolver.data_dir | Yes — hardcoded default rewritten to resolver path; custom untouched (test asserts) | FLOWING |
| `apply._apply_schema_stamp` | `.yulu-install.json` | `state.mark` real ledger write | Yes — schema_version stamped, source preserved (test reads post-apply ledger) | FLOWING |
| `verify.verify_migration` | doctor host_capabilities report | `doctor._host_capabilities` | Yes — reads POST-apply state; fail-closed on error/empty | FLOWING |

Note: on a real Darwin machine `_resolver_data_dir()` resolves to a real recording root; fixtures monkeypatch it for determinism. The genuine live resolution is covered by human-verify H1.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| migrate/ test suite passes | `pytest tests/test_migrate_*.py -q` | 59 passed in 0.15s | PASS |
| Full suite (no regressions) | `python3 -m pytest tests/ -q` | 819 passed, 1 skipped | PASS |
| yulu dispatcher syntax | `bash -n yulu/scripts/yulu` | OK | PASS |
| dry-run mutation-free on absent tree | `python3 -m migrate.cli migrate --dry-run --runtime-dir /tmp/nonexistent ...` | 3 corrections listed, exit 0, no crash | PASS |
| all migrate modules import off-daemon | `python3 -c "from migrate import detect,plan,guard,apply,verify,cli"` | all import OK | PASS |
| no-pkill gate | `grep -rv '^#' migrate/*.py \| grep -c pkill` | 0 | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
| ----------- | ----------- | ----------- | ------ | -------- |
| MIG-01 | 07-01, 07-03 | v0.5.x detected + migrated (detect→plan→apply→verify), no data loss, no reconfiguration | SATISFIED (code) / NEEDS HUMAN (live) | detect/plan/apply/verify all VERIFIED + fixture-tested; live end-to-end upgrade = H1. |
| MIG-02 | 07-02, 07-03 | Migration guards active recordings before stopping any daemon (no pkill -9 truncation) | SATISFIED (code) / NEEDS HUMAN (live) | guard-first + zero-pkill VERIFIED; live in-flight refusal = H2. |
| MIG-03 | 07-03 | Transactional with `yulu rollback`; backups pruned only after verified success | SATISFIED | backup-first + rollback byte-for-byte + prune-only-on-verify-pass all VERIFIED + fixture-tested. |

No orphaned requirements: REQUIREMENTS.md maps MIG-01/02/03 to Phase 7, all claimed by phase 7 plans.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| (none) | — | — | — | No TBD/FIXME/XXX, no TODO/HACK/PLACEHOLDER, no stub returns, no pkill in migrate/*.py |

The `return` of empty plans (`build_plan` on up-to-date need) and no-op corrections (resolver unavailable / field absent) are intentional, tested control-flow — NOT stubs (each path is asserted by a dedicated test).

### Human Verification Required

#### 1. Real v0.5.x ~/.yulu end-to-end upgrade (MIG-01)

**Test:** On a machine/VM carrying a genuine v0.5.x `~/.yulu` install (schema_version absent / old layout, with real recordings + transcripts + `vocab.sqlite` + `prompts.sqlite` + summaries):
- Run `yulu migrate --dry-run` → confirm it lists the planned corrections without changing anything.
- Run `yulu migrate` → confirm recordings/transcripts/vocab/prompts/summaries ALL intact afterward; daemons start; `~/.config/yulu/config.json` no longer has `transcription.mlx.python`; `audio.output_dir` correct (a custom path left untouched); `.yulu-install.json` carries `schema_version` AND its original `source`; NO reconfiguration prompted.
- Inspect that a `<name>.backup-*` sibling was pruned after the verified success.

**Expected:** No data loss, no reconfiguration, source preserved, backup pruned on success.
**Why human:** Requires a real legacy install + the full launchd daemon stack; the live PathResolver resolution and a real launchctl unload/start cycle cannot be exercised in fixtures.

#### 2. Live in-flight-recording guard (MIG-02)

**Test:** Start a recording (`yulu record start "guard test"`), then while it is still recording trigger `yulu migrate` → confirm it REFUSES to stop the audio daemon (prints the recording-active refusal naming the live recording), leaves the WAV un-truncated, and does NOT half-migrate. Stop the recording, re-run `yulu migrate` → confirm it now proceeds.

**Expected:** Refusal while recording (no truncated WAV); proceeds once recording ends.
**Why human:** Requires a live audio_daemon actively writing a WAV; the recording-active arbiter is the real daemon status socket.

### Gaps Summary

**No code gaps.** All 14 automatable must-haves are VERIFIED in the actual codebase, fixture-proven, and the full suite is green (819 passed, 1 skipped — exactly the expected baseline). The recording-guard checks active recording BEFORE any daemon stop with zero `pkill`/`kill -9`/`SIGKILL` anywhere; the transactional apply backs up before mutating, prunes only on verified success, and rolls back byte-for-byte; the `.yulu-install.json` `source` is preserved through the schema_version stamp (Pitfall 3, via `state.mark`'s setdefault); the dead `transcription.mlx.python` is dropped and `~/Movies/Yulu` is routed through PathResolver (custom paths untouched).

The phase is routed `human_needed` solely because the 07-03 Task 4 `checkpoint:human-verify` carries two live-install confirmations (real legacy upgrade + live in-flight-recording refusal) that, per 07-VALIDATION.md "Manual-Only Verifications" and the SUMMARY's own routing, cannot be faked and require a real v0.5.x install + daemon stack. These are NOT gaps — the code is complete and fixture-tested; they are the live-environment confirmations the planner deliberately deferred.

---

_Verified: 2026-05-30T23:05:00Z_
_Verifier: Claude (gsd-verifier)_
