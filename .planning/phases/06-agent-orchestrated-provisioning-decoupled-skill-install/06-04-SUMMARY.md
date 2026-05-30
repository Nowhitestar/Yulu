---
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
plan: 04
subsystem: infra
tags: [provisioning, cli, argparse, resume-walk, supply-chain, attestation, skill-install, npx, bash-dispatcher]

# Dependency graph
requires:
  - phase: 06-01
    provides: "provision/registry.py — REGISTRY, Step, ScriptStep, StepResult, step_by_name (the six wrapped setup_*.sh steps)"
  - phase: 06-02
    provides: "provision/state.py — mark / is_done / resume_order / default_ledger_path (the kill-at-step-N .yulu-install.json ledger)"
  - phase: 06-03
    provides: "provision/attest.py — verify_asset / TamperError (the fail-closed asset-integrity gate)"
  - phase: 01
    provides: "setup.sh thin orchestrator + install_agent_skill body; yulu bash dispatcher case pattern"
provides:
  - "yulu provision <step> — dispatch one named registry step (gate-respecting, ledger-marking)"
  - "yulu provision --all [--asset --checksums] — the resume-walk driver (gate FIRST, fail-closed; skips ok steps)"
  - "yulu provision --list — enumerate the six step names"
  - "yulu skill install [--agent] — decoupled, idempotent, non-fatal agent-skill registration"
  - "setup.sh DECOUPLED — core install no longer triggers skill registration (D-05/D-08)"
affects: [phase-07-migration, phase-08-multi-agent-providers]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Compose-don't-reimplement CLI: cli.py imports + drives registry/state/attest, never re-implements the gate or the ledger"
    - "Gate-before-apply: attest.verify_asset runs FIRST (fail-closed, abort on TamperError) before any step.apply() when --asset is supplied; SKIPPED when no asset (RESEARCH Q1/Pitfall 5)"
    - "Running-before-apply / result-after ledger marking — the kill-at-step-N resume contract realized in the walk loop"
    - "Decoupled non-fatal subcommand: skill_install returns 0 on npx-absent AND npx-failure so it can never break core install"

key-files:
  created:
    - yulu/scripts/provision/cli.py
    - yulu/scripts/provision/skill.py
    - tests/test_provision_cli.py
    - tests/test_provision_skill.py
  modified:
    - yulu/scripts/yulu
    - yulu/scripts/setup.sh
    - yulu/scripts/provision/__init__.py

key-decisions:
  - "cli.py COMPOSES the three Wave-1 modules (registry+state+attest) — gate-first then resume-walk — re-implementing neither the gate nor the ledger (D-06 structure)"
  - "yulu dispatcher routes provision)->'provision.cli provision' and skill)->'provision.cli skill' to match the argparse subcommand structure (one cli.py, two top-level subcommands)"
  - "setup.sh install_agent_skill FUNCTION BODY retained for reference; only the main-flow CALL removed — minimal-diff decouple, static guard asserts no bare call survives (D-05/D-08)"
  - "default mode 'release' (the primary install path — D-02); signed-zip + curl|bash untouched (install.sh / release_installer.py never modified — additive phase)"

patterns-established:
  - "Pattern: provision.cli is a thin argparse driver mirroring vocab/cli.py module-main; the only caller-influenced values (step name / agent names / asset paths) are resolved against the fixed registry or passed as argv elements — no shell interpolation"
  - "Pattern: the resume walk breaks on the first errored step (later steps stay non-ok) so the next invocation resumes from exactly the failed step — no daemon duplicated (T-06-18)"

requirements-completed: [PROV-01, PROV-05, PROV-02]

# Metrics
duration: 12min
completed: 2026-05-30
---

# Phase 6 Plan 4: Provision CLI Resume-Walk Driver + Decoupled Skill Install Summary

**`yulu provision <step>|--all|--list` composes registry+state+attest into a gate-first, fail-closed resume walk, and `yulu skill install` is lifted out of setup.sh into a decoupled, idempotent, non-fatal npx wrapper.**

## Performance

- **Duration:** 12 min
- **Started:** 2026-05-30T12:44:02Z
- **Completed:** 2026-05-30T12:56Z
- **Tasks:** 2
- **Files modified:** 7 (4 created, 3 modified)

## Accomplishments
- **`provision/cli.py`** — the spike's end-to-end resume-walk DRIVER (PROV-02): `provision [<step>]`, `provision --all [--asset --checksums] [--mode]`, `provision --list`, `skill install [--agent]`. When `--asset` is supplied the attest gate runs FIRST and FAIL-CLOSED (abort on `TamperError` before any `apply()`); with no asset the gate is skipped (nothing to verify). The `--all` walk skips steps already `ok` and marks `running` before `apply()` / the result after — the kill-at-step-N resume contract.
- **`provision/skill.py`** — `skill_install(agents, repo_dir=None)` lifted from `setup.sh:install_agent_skill` (lines 620-676) minus every interactive prompt: argv-list `npx -y skills add <repo> -g -a <agent> -y`, NON-FATAL on npx-absent (returns 0) AND on npx-failure (returns 0), idempotent on re-invoke (overwrites the symlink).
- **`yulu` dispatcher** — `provision)` and `skill)` cases routing to `provision.cli` via the existing `PYTHONPATH` exec idiom; usage text extended.
- **`setup.sh` DECOUPLED** — the `install_agent_skill` call removed from the orchestrator tail (D-05/D-08); replaced with a breadcrumb pointing to `yulu skill install`. Core install no longer triggers skill registration. (install.sh / release_installer.py untouched — additive phase, signed-zip stays PRIMARY per D-02.)
- **Full suite green:** 760 passed, 1 skipped (pre-existing macOS gate). shellcheck + `bash -n` clean on both edited bash files.

## Task Commits

1. **Task 1 (TDD): provision/cli.py + provision/skill.py**
   - `b98fd35` (test) — failing tests: gate-before-apply, resume walk, skill argv/non-fatal/idempotent, setup.sh decouple guard
   - `22776b8` (feat) — the resume-walk driver + the decoupled idempotent skill wrapper (+ `__init__.py` export)
2. **Task 2: wire yulu dispatcher + decouple setup.sh + Wave-0 guards** — `1c593cc` (feat)

**Plan metadata:** _(this commit)_ (docs: complete plan)

_TDD task 1: test → feat (no refactor needed — the composition is direct)._

## Files Created/Modified
- `yulu/scripts/provision/cli.py` (created) — argparse driver; gate-first `--all` resume walk composing registry+state+attest; `provision [<step>]` / `--list` / `skill install`
- `yulu/scripts/provision/skill.py` (created) — `skill_install` lifted from setup.sh; argv-list npx wrapper, non-fatal, idempotent
- `tests/test_provision_cli.py` (created) — `--list`, unknown-step error, gate-before-apply (tampered asset aborts), clean-walk marks ledger, resume skips ok steps, error breaks walk, single-step dispatch, skill dispatch
- `tests/test_provision_skill.py` (created) — argv shape (T-06-17), npx-absent/failure non-fatal, idempotent re-invoke, default-repo-dir resolution, + static guard `test_setup_no_longer_calls_install_agent_skill`
- `yulu/scripts/yulu` (modified) — `provision)` + `skill)` dispatcher cases + usage entries
- `yulu/scripts/setup.sh` (modified) — removed the `install_agent_skill` main-flow call (D-05/D-08); breadcrumb to `yulu skill install`
- `yulu/scripts/provision/__init__.py` (modified) — export `skill`

## Decisions Made
- **cli routes through one module, two subcommands:** `yulu provision` → `provision.cli provision`, `yulu skill` → `provision.cli skill`. The bash dispatcher passes the subcommand token so the single `cli.py` argparse owns both surfaces — no second module, mirrors how `vocab.cli` is the one entry for `yulu vocab`.
- **Minimal-diff decouple:** the `install_agent_skill` bash function body STAYS in setup.sh (retained for reference); only the call line is removed. The static guard greps for a bare call (not the `() {` definition, not comments) so the body can coexist without re-coupling.
- **Gate skipped without an asset:** `yulu provision deps` on an already-extracted tree has no fresh zip to verify, so the gate only fires on the `--asset` download path (RESEARCH Q1/Pitfall 5) — fail-closed when present, N/A when absent.
- **Default mode `release`** (D-02 primary path); `install.sh` and `release_installer.py` were never touched (additive phase — the signed-zip + `curl|bash` path stays the non-negotiable PRIMARY).

## Deviations from Plan

None - plan executed exactly as written. The `install_agent_skill` call site was at line 925 as the plan predicted (the line-number caveat in the file-read notes did not bite — the Phase-1 thin-orchestrator refactor left it at 925).

## Issues Encountered
None. The three Wave-1 modules exposed exactly the contracts the plan described (`step_by_name` raises `KeyError` with valid names, `mark`/`is_done`/`resume_order` drive the walk, `verify_asset` raises `TamperError`), so the CLI composed cleanly. RED phase failed correctly (modules absent); GREEN reached 14/16 with only the two setup.sh decouple guards red until Task 2 removed the call.

## Threat Surface
All dispositions from the plan's `<threat_model>` are mitigated as specified, no new surface:
- **T-06-15 (gate bypass):** `provision --all` calls `verify_asset` FIRST when `--asset` is given; a `TamperError` aborts before any `apply()`. Test `test_all_with_tampered_asset_aborts_before_any_apply` monkeypatches every `apply` to explode if reached — green.
- **T-06-16 (provision <step> arbitrary exec):** the step arg resolves via `step_by_name` against the fixed REGISTRY; unknown → error listing valid names (no arbitrary path runs).
- **T-06-17 (skill → npx injection):** `skill_install` builds an argv list; repo_dir is the fixed repo root, agent names are separate argv elements (no `shell=True`).
- **T-06-18 (resume duplicates daemons):** the walk uses running-before-apply/ok-after + the steps' own `check()` idempotency — a re-run after a kill loads no duplicate daemons.
- **T-06-19 (skill failure aborts install):** skill install is decoupled and non-fatal (returns 0 on npx-absent/failure) — it can never break core install.

## User Setup Required
None - no external service configuration required. (Agents/users can now run `yulu skill install --agent <name>` independently of core install.)

## Next Phase Readiness
- **Phase 6 COMPLETE** (all 4 plans). The agent-drivable provisioning surface is live: `yulu provision <step>` / `--all` (gate-first, resumable) + `yulu skill install` (decoupled). The spike's two exit criteria are realized and tested: kill-at-step-N resume (06-02 + the cli walk) and tampered-asset rejection (06-03 + the cli gate-before-apply).
- **Phase 7 (migration)** drives these same steps to auto-migrate v0.5.x installs; `StepResult` and the `.yulu-install.json` ledger stay stable for it.
- **Phase 8 (multi-agent providers)** can extend `skill install --agent` with additional agent names with zero cli changes (agent names are pass-through argv).
- **Carry-forward (already logged):** Phase 7 should also remove the stale `~/.config/yulu/venv-mlx-whisper` and normalize lingering `transcription.mlx.python` config (from 01-04).

## Self-Check: PASSED
- All 4 created files exist on disk (cli.py, skill.py, both test files, SUMMARY.md).
- All 3 task commits exist in git (b98fd35 test, 22776b8 feat, 1c593cc feat).
- Full suite: 760 passed, 1 skipped. shellcheck + bash -n clean.

---
*Phase: 06-agent-orchestrated-provisioning-decoupled-skill-install*
*Completed: 2026-05-30*
