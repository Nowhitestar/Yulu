---
phase: 07-seamless-auto-migration
plan: 01
subsystem: infra
tags: [migration, schema_version, detect, dry-run, stdlib, dataclass, ledger]

# Dependency graph
requires:
  - phase: 06-agent-orchestrated-provisioning
    provides: "provision/state.py SCHEMA_VERSION (==2) + .yulu-install.json ledger shape; _INSTALLER_KEYS preserve note"
  - phase: 01-build-foundation
    provides: "release_installer.read_install_metadata / install_metadata_path (corrupt JSON → {} degrade); dropped mlx venv (D-02)"
  - phase: 02-platform-abstraction
    provides: "MacOSPathResolver.data_dir() (env → config.json audio.output_dir → ~/Movies/Yulu) — the path_route target"
  - phase: 05-runtime-content-split
    provides: "runtime_dir/data_dir divergence the path_route step routes recordings into"
provides:
  - "migrate/ package skeleton: the detect→plan→apply→verify pipeline docstring (D-05)"
  - "migrate.detect.detect_migration + MigrationNeed — read-only v0.5.x recognition from schema_version + legacy layout"
  - "migrate.plan.build_plan + MigrationPlan + PlanStep — dry-run-able ordered correction list (zero mutation)"
  - "stable PlanStep names (drop_mlx_python / route_recording_dir / stamp_schema_version) for Plan 03 apply.py dispatch"
affects: [07-03-apply-verify-rollback-cli, 07-02-recording-guard, seamless-migration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Read-only detector degrades to safe default (needs_migration=True), never raises — mirrors release_installer.read_install_metadata / provision.state.load"
    - "Schema target single-sourced: SCHEMA_VERSION imported from provision.state, never a duplicated literal"
    - "Dry-run plan = pure description (frozen PlanStep, no side effect); render() is the --dry-run output; build/render touch no filesystem"

key-files:
  created:
    - yulu/scripts/migrate/__init__.py
    - yulu/scripts/migrate/detect.py
    - yulu/scripts/migrate/plan.py
    - tests/test_migrate_detect.py
  modified: []

key-decisions:
  - "detect_migration(runtime_dir, config_dir): runtime_dir == ~/.yulu install tree (ledger lives here), config_dir == ~/.config/yulu (config.json + venv-mlx-whisper) — the two roots are distinct (release_installer's runtime_dir sense ≠ PathResolver.runtime_dir())"
  - "Legacy markers (transcription.mlx.python in config, venv-mlx-whisper dir) are CORROBORATING reasons under an absent schema_version, not independent triggers — the ledger schema is the primary signal"
  - "PlanStep is a description only; the 3 corrections (drop mlx_python / route ~/Movies/Yulu / stamp schema_version) are NAMED here, EXECUTED in Plan 03 (the documented D-08 scope boundary state.py references)"
  - "from_schema is None == v0.5.x (schema_version absent / pre-Phase-6); reasons are fixed strings, never an interpolated raw path (threat T-07-03)"

patterns-established:
  - "Migration detection: schema_version vs state.SCHEMA_VERSION (== up-to-date / < intermediate / absent → v0.5.x), wrapped so any read error degrades to needs_migration=True"
  - "Stable, grep-able step name constants so Plan 03 apply.py dispatches on names without re-deriving them"

requirements-completed: [MIG-01]

# Metrics
duration: 14min
completed: 2026-05-30
---

# Phase 7 Plan 01: Migration detect + dry-run plan Summary

**Read-only `migrate.detect` recognizes a v0.5.x `~/.yulu` install (schema_version absent/older or the legacy mlx venv layout) vs an up-to-date one, and `migrate.plan` produces a dry-run-able, zero-mutation `MigrationPlan` naming the three in-transit corrections in a stable order Plan 03 dispatches on.**

## Performance

- **Duration:** 14 min
- **Started:** 2026-05-30T13:51:52Z
- **Completed:** 2026-05-30T14:06:20Z
- **Tasks:** 2 (both TDD: RED → GREEN)
- **Files modified:** 4 created

## Accomplishments
- `migrate/detect.py` — `detect_migration` distinguishes v0.5.x (schema_version absent → `from_schema=None`; or `< current` → intermediate; or no-ledger-but-legacy-layout) from a current install (`schema_version == state.SCHEMA_VERSION` → up-to-date, no-op). Never raises on a corrupt/missing/hand-edited ledger — degrades to `needs_migration=True` (a fresh safe walk). Zero mutation.
- `migrate/plan.py` — `build_plan(need)` returns an EMPTY `MigrationPlan` when up-to-date, else the three ordered corrections (`config_correction` drop `transcription.mlx.python` → `path_route` route `~/Movies/Yulu` via PathResolver → `schema_stamp` stamp `schema_version`). `PlanStep` is a frozen pure description; `render()` is the `--dry-run` output and building/rendering touches no filesystem.
- `migrate/__init__.py` documents the package as the `detect → plan → apply → verify` pipeline (D-05); this plan ships the read-only front so the destructive `apply` (Plan 03) is always driven by an already-proven, dry-run-rendered plan.
- 20 new tests (`tests/test_migrate_detect.py`); full suite green: **780 passed, 1 skipped**.

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: migrate/detect.py — v0.5.x detection (RED)** — `46b7b39` (test)
2. **Task 1: migrate/detect.py — v0.5.x detection (GREEN)** — `4f1da3d` (feat)
3. **Task 2: migrate/plan.py — dry-run MigrationPlan (RED)** — `a8cac9e` (test)
4. **Task 2: migrate/plan.py — dry-run MigrationPlan (GREEN)** — `20d9fa3` (feat)

_TDD gate sequence satisfied: a `test(...)` commit precedes each `feat(...)`._

## Files Created/Modified
- `yulu/scripts/migrate/__init__.py` — package docstring: the detect→plan→apply→verify pipeline; this plan = the read-only front.
- `yulu/scripts/migrate/detect.py` — `MigrationNeed` frozen dataclass + `detect_migration(runtime_dir, config_dir=None)`: ledger schema_version vs `provision.state.SCHEMA_VERSION`, corroborated by legacy markers; degrades to needs_migration on any error; stdlib-only.
- `yulu/scripts/migrate/plan.py` — `PlanStep` / `MigrationPlan` (+ `render()`) frozen dataclasses + `build_plan(need)`: empty when up-to-date, else 3 ordered corrections with stable dispatch names; zero mutation; stdlib-only.
- `tests/test_migrate_detect.py` — fixture-tree detect coverage (absent/old/current schema, legacy config field, legacy venv dir, corrupt-ledger degrade, read-only invariant, stdlib guard) + dry-run plan coverage (3 corrections named, ordering, up-to-date→empty, allowed kinds, render lines, build/render byte-identical config, frozen PlanStep).

## Decisions Made
- **Two-root signature kept explicit.** `detect_migration(runtime_dir, config_dir)` — `runtime_dir` is the `~/.yulu` install tree where `.yulu-install.json` lives (release_installer's sense), `config_dir` is `~/.config/yulu` where `config.json` + the legacy `venv-mlx-whisper` live. Honoring the prompt's critical-constraint distinction, the ledger and the config are read from different roots; tests pass both explicitly, production defaults `config_dir` via a lazy+guarded `MacOSPathResolver.config_dir()` (mirrors `state.default_ledger_path`).
- **Schema is the primary signal; legacy markers corroborate.** An absent `schema_version` triggers v0.5.x; the `transcription.mlx.python` field and the `venv-mlx-whisper` directory are added as extra `reasons` only when present (they don't independently flip the verdict). This keeps a Phase-6-stamped current install authoritative even if a stray legacy file lingers.
- **Plan names, apply executes (D-08 boundary).** The three corrections are descriptions here; `provision/state.py`'s note ("cleaning up the legacy venv-mlx-whisper / stale config is Phase 7") is realized as: detect/plan NAME them, Plan 03 `apply.py` REMOVES them. Step names are stable constants so apply dispatches on them.
- **`SCHEMA_VERSION` single-sourced.** Both modules import it from `provision.state` (no bare `2` literal), so a future schema bump flows through one place. `to_schema` always equals it.

## Deviations from Plan

None - plan executed exactly as written. Both tasks followed the prescribed TDD RED→GREEN flow; no REFACTOR pass was needed (both modules were clean and fully documented on first GREEN). No bugs, missing-critical, or blocking issues surfaced.

## Issues Encountered
- `make pytest` (full suite) was auto-routed to a background task by the harness and took ~6.5 min; resolved by reading the completed background output file (exit 0, 780 passed / 1 skipped). The 1 skip is the pre-existing `e2e` opt-in test that requires a real mlx-whisper model — unrelated to this plan.

## User Setup Required
None - no external service configuration required. Pure-stdlib local read-only modules.

## Next Phase Readiness
- **Plan 03 (apply/verify/rollback/CLI)** can now consume `migrate.detect.detect_migration` and `migrate.plan.build_plan`: the dry-run plan is the proven, ordered list `apply.py` dispatches on by step name (`drop_mlx_python`, `route_recording_dir`, `stamp_schema_version`). `MigrationPlan.render()` is ready as the `yulu migrate --dry-run` output.
- **Plan 02 (recording-guard)** is a parallel sibling (Wave 1) and is untouched by this plan — no shared files.
- **Contract for apply:** preserve `.yulu-install.json` `source` (Phase 6 Pitfall 3) — `apply` should stamp via `provision.state.mark` (which preserves `_INSTALLER_KEYS`), not by re-writing the ledger from scratch. `MigrationNeed.from_schema`/`to_schema` are carried on `MigrationPlan.need` so apply/verify never re-detect.

## Self-Check: PASSED

- Files verified present: `migrate/__init__.py`, `migrate/detect.py`, `migrate/plan.py`, `tests/test_migrate_detect.py`, `07-01-SUMMARY.md`.
- Commits verified in git log: `46b7b39` (test/detect), `4f1da3d` (feat/detect), `a8cac9e` (test/plan), `20d9fa3` (feat/plan).
- Full suite: 780 passed, 1 skipped (pre-existing `e2e` opt-in).

---
*Phase: 07-seamless-auto-migration*
*Completed: 2026-05-30*
