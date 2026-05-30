---
phase: 07-seamless-auto-migration
plan: 03
subsystem: migration
tags: [migration, transactional, rollback, backup, schema_version, in-transit-corrections, cli]

# Dependency graph
requires:
  - phase: 07-seamless-auto-migration (plan 01)
    provides: migrate/detect.py (detect_migration -> MigrationNeed) + migrate/plan.py (build_plan -> MigrationPlan, dry-run-able, three PlanStep kinds)
  - phase: 07-seamless-auto-migration (plan 02)
    provides: migrate/guard.py (stop_daemons_guarded + RecordingActive) — apply composes the recording-guard before any daemon stop
  - phase: 01-build-foundation
    provides: release_installer.move_existing_runtime_to_backup / restore_backup (reused for the transactional backup + byte-for-byte rollback) + .yulu-install.json ledger
  - phase: 06-resumable-provisioning
    provides: provision.state.mark (schema_version stamp + Pitfall-3 source preserve) + _atomic_write idiom (mirrored for the config rewrite)
  - phase: 03-host-capability-detection
    provides: doctor._host_capabilities (post-migration verify gate)
  - phase: 02-cross-platform-abstraction
    provides: MacOSPathResolver.data_dir / config_dir (route the hardcoded ~/Movies/Yulu; resolve config root)
provides:
  - "migrate/apply.py — transactional apply_migration (guard-stop -> backup-first -> in-transit corrections -> schema stamp), rollback (byte-for-byte restore), MigrationResult"
  - "migrate/verify.py — verify_migration (post-migration doctor host_capabilities gate, hardened predicate), prune_backup, finalize (prune-ONLY-on-verified-success)"
  - "migrate/cli.py — yulu migrate (detect->plan->apply->verify, --dry-run) + yulu rollback, composing the four stages"
  - "yulu dispatcher migrate) / rollback) cases + usage entries"
affects: [migration-complete, no-data-loss, bounded-backup-lifecycle, v0.5.x-upgrade]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Transactional in-place correction: move tree to a pristine <name>.backup-* (rollback snapshot), restore a WORKING COPY back, correct it in place — the backup stays pristine for rollback while the live tree keeps its data AND its .yulu-install.json source"
    - "Prune-on-verified-success-only: finalize prunes the backup ONLY when result.ok AND verify passes; a failed/refused/unverified run KEEPS the backup so yulu rollback is always possible (the CONCERNS §2e bounded-lifecycle fix done safely)"
    - "Resolve-not-execute doctor verify: verify_migration calls doctor._host_capabilities directly with Path args (no shell, no path interpolation — T-07-12); behind a _host_report seam tests inject a report"
    - "Hardened health predicate: healthy iff report.get('error') is None AND non-empty capabilities (robust to a future error:None success dict)"
    - "Forced-kill token scrubbed from apply.py prose too (docstrings included) so the migrate/ grep gate stays at zero — same discipline as guard.py"
    - "Atomic config rewrite mirroring provision.state._atomic_write (mkstemp + os.replace same-dir) — a kill mid-write leaves the OLD config intact, never a torn file"

key-files:
  created:
    - yulu/scripts/migrate/apply.py
    - yulu/scripts/migrate/verify.py
    - yulu/scripts/migrate/cli.py
    - tests/test_migrate_apply_rollback.py
    - tests/test_migrate_corrections.py
    - tests/test_migrate_cli.py
  modified:
    - yulu/scripts/yulu

key-decisions:
  - "[07-03] apply takes the backup via release_installer.move_existing_runtime_to_backup, then copytree's a WORKING COPY back into install_dir and corrects in place — the move-only primitive would leave install_dir empty and lose the user's data + ledger source on prune; the copy-back keeps the backup pristine for rollback AND the live tree intact (no data loss, source preserved)"
  - "[07-03] config corrections target config_dir/config.json (~/.config/yulu), DISTINCT from the install tree (~/.yulu); the config.json snapshot is taken as a sibling <name>.backup-*.config.json.bak so a single prune reclaims both and rollback restores config too"
  - "[07-03] schema stamp goes through provision.state.mark (never hand-written) so source/version/installer keys survive — Pitfall 3 / T-07-10; a dedicated test asserts both release and dev source survive the stamp"
  - "[07-03] route_recording_dir rewrites ONLY an audio.output_dir EQUAL to the hardcoded ~/Movies/Yulu literal; a custom output_dir (or an absent one) is LEFT UNTOUCHED — correct-in-transit, never reconfigure the user's chosen folder; off-Darwin the resolver returns None and the correction no-ops"
  - "[07-03] verify is fail-closed: a doctor/capabilities import failure or a malformed report degrades to unhealthy (False), so a verify we cannot run does NOT prune the backup"
  - "[07-03] any exception mid-apply restores from the pristine backup then re-raises (mirrors install_release_from_urls) — never a half-migration; a test forces _apply_schema_stamp to raise and asserts the tree is restored byte-for-byte"

patterns-established:
  - "Pattern: transactional backup-first apply — pristine move-aside backup + working-copy-in-place correction + restore-on-error; the backup is the recovery boundary (T-07-08)"
  - "Pattern: prune-on-verified-success-only — the bounded backup lifecycle (§2e) gated strictly on the verify pass; both branches (prune / keep) asserted in tests"
  - "Pattern: CLI composes, never re-implements — migrate/cli.py drives detect->plan->apply->verify exactly like provision/cli.py drives the resume walk; the plan is built in-process (fixed enum), never externally supplied"

requirements-completed: [MIG-01, MIG-02, MIG-03]

# Metrics
duration: 38min
completed: 2026-05-30
---

# Phase 7 Plan 03: Transactional Migration Apply + Verify + CLI Summary

**Transactional `yulu migrate` (detect→plan→apply→verify) + `yulu rollback`: pristine move-aside backup, recording-guarded daemon stop, in-transit corrections (drop dead mlx_python / route ~/Movies/Yulu / stamp schema_version preserving source), prune-backup-only-on-verified-success — no data loss, no reconfiguration, never a half-migration.**

## Performance

- **Duration:** ~38 min
- **Started:** 2026-05-30T22:18:00Z (approx)
- **Completed:** 2026-05-30T22:56:00Z (approx)
- **Tasks:** 3 code tasks executed + committed (Task 4 is a human-verify checkpoint — see Pending Human Verification)
- **Files created:** 6 (3 modules + 3 test files)
- **Files modified:** 1 (yulu dispatcher)

## Accomplishments

- **`migrate/apply.py`** — `apply_migration` runs the destructive half TRANSACTIONALLY: recording-guard FIRST (a live recording → refused result, ZERO mutation, no daemon stopped, no WAV truncated), backup BEFORE any mutation (`move_existing_runtime_to_backup` + config snapshot), in-transit corrections applied to a working copy in place, and any mid-apply exception restores from the pristine backup then re-raises (never a half-migration). `rollback` restores the prior tree byte-for-byte.
- **In-transit corrections (D-04):** drop the dead `transcription.mlx.python` field (rest of config preserved); route a hardcoded `~/Movies/Yulu` `audio.output_dir` through `PathResolver.data_dir` while leaving a user's custom folder UNTOUCHED; stamp `schema_version` via `provision.state.mark` which PRESERVES the installer `source` (Pitfall 3 / T-07-10).
- **`migrate/verify.py`** — `verify_migration` gates on the Phase-3 `doctor._host_capabilities` report (healthy iff no `error` AND non-empty `capabilities`, hardened predicate, resolve-not-execute); `finalize` prunes the `<name>.backup-*` ONLY on a verified success and KEEPS it on a failed verify (the CONCERNS §2e bounded-lifecycle fix — a failed verify points at `yulu rollback`).
- **`migrate/cli.py` + `yulu` dispatcher** — `yulu migrate [--dry-run]` runs detect→plan→apply→verify (up-to-date is a no-op; `--dry-run` prints `plan.render()` and mutates nothing; a refused apply or failed verify exits non-zero without pruning) and `yulu rollback` restores from the most-recent backup.
- **No data loss (MIG-01):** recordings/transcripts/vocab/prompts/summaries survive byte-for-byte (asserted); no `pkill`/forced-kill anywhere in `migrate/` (grep gate = 0).

## Task Commits

Each task was committed atomically:

1. **Task 1: migrate/apply.py — transactional backup→guarded-stop→corrections→mark; rollback restore** — `b32f09f` (feat)
2. **Task 2: migrate/verify.py — post-migration doctor gate + prune-backup-ONLY-on-success** — `e73df9c` (feat)
3. **Task 3: migrate/cli.py + yulu dispatcher — `yulu migrate` (+ `--dry-run`) + `yulu rollback`** — `111de30` (feat)

**Plan metadata:** committed separately with this SUMMARY + STATE/ROADMAP/REQUIREMENTS.

_Note: Task 1/2 are `tdd="true"`; tests and implementation landed together per task (the shared test file `test_migrate_apply_rollback.py` covers both apply/rollback and verify/finalize, committed with Task 2 to stay green; the apply-only corrections test committed with Task 1)._

## Files Created/Modified

- `yulu/scripts/migrate/apply.py` — transactional `apply_migration` + `rollback` + `MigrationResult`; the three in-transit correction helpers; atomic config rewrite.
- `yulu/scripts/migrate/verify.py` — `verify_migration` (doctor gate), `prune_backup`, `finalize` (prune-on-success-only).
- `yulu/scripts/migrate/cli.py` — `yulu migrate` / `yulu rollback` driver composing the four stages.
- `yulu/scripts/yulu` — added `migrate)` / `rollback)` dispatcher cases + `usage()` entries.
- `tests/test_migrate_apply_rollback.py` — transactional backup-first, rollback byte-for-byte, prune-only-on-verify-pass (both branches), no-data-loss, recording-guard refusal (zero mutation), mid-apply-error rollback, no-pkill source gate.
- `tests/test_migrate_corrections.py` — drop mlx_python (rest preserved), route ~/Movies/Yulu (custom untouched, resolver-unavailable no-op), schema_version stamp + source preserved (release + dev), end-to-end compose.
- `tests/test_migrate_cli.py` — up-to-date no-op, dry-run zero-mutation, success prunes, failed-verify retains, recording-refusal non-zero, rollback-no-backup, rollback-restores-byte-for-byte.

## Decisions Made

See `key-decisions` in the frontmatter. Headline calls:
- **Working-copy-in-place over move-only** (the one real correction to the plan's literal wording — see Deviations): the plan said "reuse `move_existing_runtime_to_backup` for the tree", which alone would leave `install_dir` empty and, on prune, destroy the user's data and drop the ledger `source`. The transactional intent ("no data loss", "source preserved", "rollback restores byte-for-byte") is satisfied by moving the tree to a pristine backup, copying a working copy back, and correcting in place.
- **Fail-closed verify:** a verify we cannot run (doctor import failure / malformed report) is unhealthy → the backup is retained.
- **Config snapshot as a backup sibling** so a single prune reclaims both tree and config, and rollback restores config too.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `move_existing_runtime_to_backup` alone loses data + drops `source`**
- **Found during:** Task 1 (the `test_all_corrections_compose_end_to_end` test failed with `KeyError: 'source'`).
- **Issue:** The plan's literal instruction — "reuse `release_installer.move_existing_runtime_to_backup(install_dir)` for the tree" — *moves* the install tree (including the user's recordings/transcripts/DBs and the `.yulu-install.json` carrying `source`) to the backup and leaves `install_dir` EMPTY. The schema stamp then wrote a FRESH ledger with no `source` (Pitfall-3 regression), and pruning the backup on success would have destroyed the user's data — directly contradicting the plan's own "no data loss / source preserved / rollback byte-for-byte" must-haves.
- **Fix:** After `move_existing_runtime_to_backup` (which yields the pristine rollback snapshot), `copytree` a WORKING COPY back into `install_dir` and apply the corrections in place. The backup stays pristine (rollback restores it byte-for-byte); the live tree keeps the user's data and its original ledger `source` (the stamp preserves it). On prune, the corrected live tree (data intact) remains.
- **Files modified:** `yulu/scripts/migrate/apply.py`
- **Verification:** `test_all_corrections_compose_end_to_end` (source == "release" after apply), `test_apply_loses_no_data`, `test_rollback_restores_byte_for_byte`, `test_schema_stamp_preserves_source`/`_dev_source` all green.
- **Committed in:** `b32f09f` (Task 1 commit)

**2. [Rule 3 - Blocking] Forced-kill token in apply.py prose tripped the migrate/ grep gate**
- **Found during:** Task 1 (`test_apply_source_has_no_pkill` failed).
- **Issue:** The plan's verification is `grep -rv '^[[:space:]]*#' yulu/scripts/migrate/ | grep -c pkill` == 0 — it scans the WHOLE file including docstrings. My `apply.py` module docstring mentioned the literal forced-kill token twice ("no `pkill -9`"), which the gate counts.
- **Fix:** Scrubbed the literal token from the docstring (rephrased to "no forced-kill path"), exactly as `guard.py` did in Plan 02 (guard.py contains zero occurrences of the token).
- **Files modified:** `yulu/scripts/migrate/apply.py`
- **Verification:** `grep -rv '^[[:space:]]*#' yulu/scripts/migrate/ | grep -c pkill` == 0; `test_apply_source_has_no_pkill` green.
- **Committed in:** `b32f09f` (Task 1 commit)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking)
**Impact on plan:** Both were necessary to satisfy the plan's OWN must-haves (no data loss, source preserved, byte-for-byte rollback, zero-pkill gate). No scope creep — the transactional intent is unchanged; only the backup mechanics were corrected from the literal primitive call to one that actually preserves data.

## Issues Encountered

None beyond the two deviations above. The full suite is green: **819 passed, 1 skipped** (baseline before this plan: 791 passed, 1 skipped — +28 new tests, zero regressions).

## Pending Human Verification

Task 4 of the plan is a `checkpoint:human-verify` (`gate="blocking-human"`) covering the two live-install confirmations that **cannot be faked** (07-VALIDATION.md "Manual-Only Verifications"). Per the milestone's autonomous mandate, all code is written and fixture-tested green; these live steps are documented here for a human to run on a real machine. **The verifier should route these as `human_needed`.**

### 1. Real end-to-end v0.5.x upgrade — no data loss, no reconfiguration (MIG-01)

On a machine (or VM) carrying a genuine v0.5.x `~/.yulu` install (`schema_version` absent / old layout, with real recordings + transcripts + `vocab.sqlite` + `prompts.sqlite` + summaries):

1. `yulu migrate --dry-run` → confirm it lists the planned corrections (drop_mlx_python / route_recording_dir / stamp_schema_version) and changes NOTHING (no backup created, config + tree byte-identical).
2. `yulu migrate` → confirm ALL of:
   - recordings / transcripts / `vocab.sqlite` / `prompts.sqlite` / summaries are intact afterward (byte-for-byte);
   - the daemons start;
   - `~/.config/yulu/config.json` no longer has `transcription.mlx.python`;
   - `audio.output_dir` is correct — a custom path was LEFT UNTOUCHED; a hardcoded `~/Movies/Yulu` was routed via PathResolver;
   - `~/.yulu/.yulu-install.json` carries `schema_version` AND its original `source` ("release" or "dev");
   - NO reconfiguration was prompted.
3. Confirm the `<name>.backup-*` sibling (next to `~/.yulu`) was PRUNED after the run reported a verified success.

**Expected:** a seamless upgrade — the user's data survives, the install is stamped current, the backup is reclaimed only after verify passed.

### 2. Live-recording guard — refuses to truncate an in-flight WAV (MIG-02)

1. Start a recording: `yulu record start "guard test"`.
2. While it is STILL recording, trigger `yulu migrate`.
3. Confirm it REFUSES: prints the recording-active refusal (names the live recording via `.recording.lock` metadata), leaves the WAV un-truncated, and does NOT half-migrate (no backup consumed, config + tree unchanged, exit non-zero).
4. Stop the recording (`yulu record stop`), re-run `yulu migrate` → confirm it now proceeds normally.

**Expected:** migration never stops the audio daemon mid-capture; it waits for the user, then upgrades cleanly.

**Resume signal:** Type "approved" once both the real upgrade (no data loss, no reconfig, source preserved, backup pruned on success) and the live-recording refusal are confirmed; otherwise describe what failed.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 7 is feature-complete in code: the full `yulu migrate` / `yulu rollback` pipeline (detect → plan → apply → verify, transactional, recording-guarded, prune-on-verified-success) is implemented and fixture-tested green across Plans 01–03.
- The only outstanding item is the two live-install human confirmations above (Task 4) — they gate the phase's "live-confirmed" criterion but do not block code completion.
- MIG-01 / MIG-02 / MIG-03 all delivered (MIG-02's guard composed from Plan 02; the apply-side wired here).

## Self-Check: PASSED

All 6 created files present on disk; all 3 task commits (`b32f09f`, `e73df9c`, `111de30`) found in git history. Full suite green (819 passed, 1 skipped).

---
*Phase: 07-seamless-auto-migration*
*Completed: 2026-05-30*
