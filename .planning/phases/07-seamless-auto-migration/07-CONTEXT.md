# Phase 7: Seamless Auto-Migration - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Mode:** Autonomous (Claude decided; research skipped per ROADMAP "detect→plan→apply→verify is fully specified; its hard deps land in Phase 2")

<domain>
## Phase Boundary

An existing v0.5.x `~/.yulu` install upgrades to the new model with NO data loss and NO reconfiguration — guarding active recordings, staying transactional with rollback, and reclaiming backups only after verified success. Covers **MIG-01/02/03**.

**Hard dependency satisfied:** Phase 2's `open -W` → direct-launch fix removed the `pkill -9` truncation vector at its root; migration uses `DaemonManager` clean-stop + a recording-guard.

**Out of scope:** backup-cleanup beyond migration's own lifecycle (v2 HARD-03); the cloud-folder migration of existing recordings is detect-and-warn only (Phase 5 already shipped the safety; this phase doesn't auto-move content into a cloud root).

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous)

### detect → plan → apply → verify (MIG-01)
- **D-01:** `yulu migrate` runs the 4-stage pipeline. **detect:** existing v0.5.x `~/.yulu` (`.yulu-install.json` `schema_version` absent or < current; old layout). **plan:** the migration steps (path corrections, config corrections, the Phase 5 runtime/content target layout) — dry-run-able. **apply:** transactional (backup → apply → mark). **verify:** post-migration `doctor` host_capabilities + a `schema_version` stamp. NO data loss (recordings/transcripts/vocab/prompts/summaries preserved), NO reconfiguration required from the user.

### Recording-Guard (MIG-02)
- **D-02:** Before stopping ANY daemon, check whether a recording is active (`recording_lock` / `audio_daemon` status). REFUSE to stop while recording is active — no `pkill -9` truncation of an in-flight capture. Use the Phase 2 `DaemonManager` clean-stop (the `open -W` orphan is already gone, so `launchctl unload` kills cleanly without `pkill`).

### Transactional + Bounded Backup (MIG-03)
- **D-03:** Backup the prior state BEFORE apply (extend `release_installer.replace_runtime_with_backup`). `yulu rollback` restores the prior state from the backup. The backup is pruned ONLY after verification passes (bounded lifecycle — fixes CONCERNS §2e "backups never cleaned"). A failed verify → keep the backup + offer rollback; never a half-migrated state left silently.

### In-Transit Corrections (MIG-01)
- **D-04:** Correct known fragilities during migration: remove the dead `mlx_python` config field (Phase 1 removed the venv; migration cleans the stale field from existing installs); route the hardcoded `~/Movies/Yulu` through `PathResolver` (Phase 2) + the runtime/content split (Phase 5); stamp the new install with `schema_version` (the Phase 6 `.yulu-install.json` schema).

### Structure
- **D-05:** New `migrate/` module: `detect.py` (v0.5.x detection), `plan.py` (the migration plan, dry-run-able), `apply.py` (transactional backup→apply→mark), `verify.py` (post-migration doctor + schema_version), and rollback. `yulu migrate` + `yulu rollback` CLI subcommands. COMPOSES: Phase 2 (`DaemonManager` clean-stop, `PathResolver`), Phase 3 (re-detect via the report), Phase 5 (runtime/content split target), Phase 6 (`.yulu-install.json` `schema_version` + the ledger atomic-write primitive).
- **D-06 [hard dep]:** Phase 2's `open -W`→direct-launch fix is DONE — migration relies on it (no `pkill -9`). The recording-guard is the second safety.
- **D-07 [scope]:** v0.5.x `~/.yulu` migration only. Reuse the Phase 6 `.yulu-install.json` ledger for migration state. Backup-cleanup beyond this lifecycle = v2 HARD-03.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** (Research skipped — these + the codebase ARE the spec.)

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 7" — goal + 4 success criteria + the hard-dependency note
- `.planning/REQUIREMENTS.md` — MIG-01/02/03

### The contracts this composes
- `yulu/scripts/release_installer.py` — `replace_runtime_with_backup` (line 359), `.yulu-install.json` `schema` (line 248), `install_metadata_path` — extend for transactional rollback + pruning
- `yulu/scripts/recording_lock.py` — the recording-active check for the guard
- `yulu/scripts/yulu_platform/macos/daemon_manager.py` (Phase 2 clean-stop), `path_resolver.py` (Phase 2 + Phase 5 split)
- `yulu/scripts/doctor.py` + `capabilities/` (Phase 3 — post-migration verify)
- `yulu/scripts/provision/state.py` (Phase 6 — `.yulu-install.json` atomic-write + schema_version to mirror)

### Fragilities corrected in transit
- `.planning/codebase/CONCERNS.md` — §2d (`pkill -9` data-loss — removed via recording-guard + Phase 2), §2e (backups never cleaned — bounded lifecycle here), §1e (hardcoded `~/Movies/Yulu`), §6e (dead `mlx_python`)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `release_installer.replace_runtime_with_backup` already creates `backup-*` dirs (currently never pruned — §2e) — extend it with rollback + post-verify pruning, don't rewrite.
- `recording_lock.py` is the recording-active probe for the MIG-02 guard.
- Phase 6 `provision/state.py` atomic-write + `schema_version` is the exact primitive for the migration ledger.
- Phase 2 `DaemonManager.stop()` is the clean-stop (no `pkill -9`).

### Established Patterns
- `.yulu-install.json` carries `schema`/`source`/`version` — migration bumps `schema_version` and corrects fields in transit; PRESERVE `source` (Phase 6 Pitfall 3).
- stdlib-first; subprocess for launchctl via DaemonManager.

### Integration Points
- detect→plan→apply→verify reuses the Phase 6 step-ledger shape; verify calls the Phase 3 doctor report.
- The recording-guard + clean-stop is THE data-loss prevention — never stop a daemon mid-recording.

</code_context>

<specifics>
## Specific Ideas
- `yulu migrate` (detect→plan→apply→verify) + `yulu rollback`.
- Recording-guard: refuse daemon stop while recording active; no `pkill -9`.
- Transactional: backup → apply → verify → prune-backup-only-on-success.
- In-transit: drop dead `mlx_python`, route `~/Movies/Yulu` via PathResolver, stamp `schema_version`.
- No data loss, no reconfiguration; reuse Phase 6 ledger + Phase 2 clean-stop.

</specifics>

<deferred>
## Deferred Ideas
- Backup-cleanup beyond migration's lifecycle (`yulu cleanup-backups`) → v2 HARD-03.
- Auto-moving existing recordings into a cloud root → out of scope (Phase 5 ships detect-and-warn; migration doesn't force content into cloud).

</deferred>

---

*Phase: 7-Seamless Auto-Migration*
*Context gathered: 2026-05-30 (autonomous, research skipped per ROADMAP)*
