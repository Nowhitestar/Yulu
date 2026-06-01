---
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
plan: 02
subsystem: infra
tags: [provisioning, resume, atomic-write, ledger, install-metadata, idempotency, stdlib]

# Dependency graph
requires:
  - phase: 06-agent-orchestrated-provisioning-decoupled-skill-install (Plan 01)
    provides: "provision/registry.py — Step/StepResult/REGISTRY (the named, idempotent step contract the ledger records)"
  - phase: 01-build-foundation
    provides: "release_installer.write_install_metadata — the .yulu-install.json {schema:1, source, version, sha256} doc this ledger extends"
provides:
  - "provision/state.py — resumable per-step .yulu-install.json ledger (atomic write, mark/is_done/resume_order, installer-key preservation)"
  - "Kill-at-step-N resume contract: mark running BEFORE apply / ok only AFTER; resume redoes only non-ok steps, never an ok step"
  - "Wave-0 tests proving atomicity, missing/corrupt degrade, Pitfall-3 source preservation, and the kill-at-step-N walk"
affects: [06-04-cli-provision-walk, 06-03-attest, phase-7-migration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Atomic JSON ledger via tempfile.mkstemp + os.replace (+ optional fcntl.flock) — mirrors queue_store._write_queue_atomic byte-for-byte"
    - "mark-running-before / mark-ok-after durability so a SIGKILL leaves a step non-ok (claim_summary_request 'mark inside the lock' shape)"
    - "setdefault-preserve of installer-written keys when extending a third-party-owned JSON doc (never clobber source — Pitfall 3)"

key-files:
  created:
    - "yulu/scripts/provision/state.py"
    - "tests/test_provision_state.py"
    - "tests/test_provision_resume.py"
  modified:
    - "yulu/scripts/provision/__init__.py"

key-decisions:
  - "[06-02] state.py provides primitives ONLY (mark/is_done/resume_order); the resume WALK loop lives in the Plan-04 CLI/registry driver — state.py never imports REGISTRY, so the ledger has no dependency on step semantics"
  - "[06-02] _INSTALLER_KEYS allowlist (source/version/sha256/installed_at/asset/branch/commit/schema) is preserved via setdefault on every mark(); a dropped `source` flips lib/common.sh:detect_source into the swiftc dev branch (Pitfall 3 / T-06-07) — guarded by a PRESERVE test across both a single mark and the full 6-step walk"
  - "[06-02] schema_version:2 is ADDED alongside (never replacing) the installer's own schema:1 key — both coexist in the doc (D-04)"
  - "[06-02] fcntl.flock parity with queue_store kept (best-effort, degrades unlocked on OSError); os.replace single-writer atomicity is the load-bearing correctness guarantee (T-06-08). The persistent `.<name>.lock` sidecar is expected (== queue_store's .agent-queue.lock) and excluded from the no-temp-litter assertion"
  - "[06-02] Missing `steps` key OR a corrupt/non-object ledger ⇒ fresh ledger (resume_order returns ALL steps), NOT a migration — legacy-install cleanup is Phase 7 (D-08)"

patterns-established:
  - "Atomic ledger write: mkstemp in the same dir → json.dump indent=2 ensure_ascii=False + trailing newline → os.replace → unlink-tmp-in-finally"
  - "is_done is true ONLY on status=='ok'; running/skipped/error/absent are all non-done so resume re-applies them"
  - "resume_order preserves registry order (not mark order): the not-yet-ok names filtered through the caller-supplied registry sequence"

requirements-completed: [PROV-04, PROV-02]

# Metrics
duration: 16min
completed: 2026-05-30
---

# Phase 6 Plan 02: Resumable .yulu-install.json Per-Step Ledger Summary

**`provision/state.py` — an atomic (`tempfile.mkstemp` + `os.replace`) per-step `.yulu-install.json` ledger that extends the Phase-1 installer doc (preserving `source`/`version`/`sha256`) and powers kill-at-step-N resume: a step is marked `running` before `apply()` and `ok` only after, so a SIGKILL re-runs exactly that step (and only steps after it), never an `ok` one.**

## Performance

- **Duration:** ~16 min
- **Started:** 2026-05-30T12:03:18Z
- **Completed:** 2026-05-30T12:19:44Z
- **Tasks:** 2
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments
- **Atomic durability primitive (T-06-05):** `_atomic_write` is byte-for-byte `queue_store._write_queue_atomic` — `mkstemp` in the target dir, `json.dump` + trailing newline, `os.replace`, unlink-in-`finally`. A kill mid-write leaves the OLD doc fully intact, never a torn file. `load()` degrades a missing / corrupt / non-object ledger to `{}` (matching `read_install_metadata`).
- **Kill-at-step-N resume contract (T-06-06, PROV-02/PROV-04):** `mark(running)` is durable BEFORE `apply()`, `mark(ok)` only AFTER a clean exit; `is_done` is true only on `status=="ok"`. `resume_order(registry_names, path)` returns the not-yet-`ok` steps in registry order — the killed step plus everything after it, never a completed step.
- **Installer-key preservation (T-06-07, Pitfall 3):** `mark()` loads the existing installer-written doc and preserves the `_INSTALLER_KEYS` allowlist via `setdefault`, adding only `steps` + `schema_version:2`. Dropping `source` would flip `lib/common.sh:detect_source` into the swiftc dev branch on the next update — guarded by PRESERVE tests on a single mark, the full 6-step walk, and across the resume path (dev + release).
- **Wave-0 tests green:** 20 new tests (12 state + 8 resume), full repo suite **738 passed, 1 skipped**.

## Task Commits

Each task was committed atomically:

1. **Task 1: provision/state.py — atomic ledger + mark/is_done/resume_order, preserving installer keys** — `5363b72` (feat)
2. **Task 2: Wave-0 tests (atomic write + preserve source + kill-at-step-N)** — `752c4ac` (test)

**Plan metadata:** _(this commit)_ `docs(06-02): complete plan`

_Note: this plan carried `tdd="true"` on Task 1. RED was established by writing the contract tests (Task 2 content) and a standalone RED-sanity check confirming a clobbering `mark()` would drop `source` and trip the PRESERVE guard; GREEN is the committed `state.py`. The plan's explicit task split (impl = Task 1, test files = Task 2) was honored for the commit boundaries._

## Files Created/Modified
- `yulu/scripts/provision/state.py` (created, 237 lines) — `_now`, `default_ledger_path`, `_ledger_lock`, `_atomic_write`, `load`, `mark`, `is_done`, `resume_order`. stdlib only (json, os, tempfile, datetime, pathlib, fcntl, contextlib).
- `tests/test_provision_state.py` (created, 191 lines) — round-trip; atomic write / no mkstemp litter; missing/corrupt/non-object → `{}`; PRESERVE source/version/sha256 (single mark + full walk); is_done only-on-ok; resume_order order.
- `tests/test_provision_resume.py` (created, 138 lines) — kill-at-step-N walk; error-step reruns from failure; killed-before-first-mark runs all; all-done runs nothing; corrupt ledger starts fresh; source survives resume (release + dev).
- `yulu/scripts/provision/__init__.py` (modified) — export `state` from the package surface alongside the registry symbols.

## Decisions Made
- **state.py is primitives-only.** The resume walk loop (`for step in REGISTRY: if is_done → skip; mark(running); apply; mark(result)`) is documented in the module docstring but deliberately NOT implemented here — it belongs to the Plan-04 CLI/registry driver. `state.py` therefore never imports `provision.registry`, keeping the ledger independent of step semantics (`resume_order` takes the registry names as a plain argument).
- **`_INSTALLER_KEYS` is an explicit allowlist** (`source, version, sha256, installed_at, asset, branch, commit, schema`) preserved via `setdefault` on every `mark()`. The whole-doc `load → add-only → write` shape already guarantees nothing is dropped; the explicit loop makes the Pitfall-3 source-clobber guard grep-visible (the plan's `key_links` requires a `source`-referencing preserve).
- **`schema_version:2` coexists with the installer's `schema:1`** — added, never replacing (D-04).
- **fcntl.flock kept for queue_store parity** but is best-effort (degrades unlocked on `OSError`); `os.replace` single-writer atomicity is the correctness guarantee (T-06-08, accept disposition). The persistent `.<name>.lock` sidecar is expected behaviour (exactly like `queue_store`'s `.agent-queue.lock`).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] no-temp-litter test assertion was too strict (counted the fcntl lock sidecar)**
- **Found during:** Task 2 (test authoring / first green run)
- **Issue:** `test_ledger_written_atomically_no_temp_litter` asserted the directory held ONLY the ledger after a `mark()`, but the `fcntl.flock` parity (decision: keep queue_store parity) leaves a persistent `.<name>.lock` sidecar — exactly as `queue_store.py` leaves `.agent-queue.lock`. The assertion flagged that legitimate sidecar as litter.
- **Fix:** Narrowed the assertion to its real intent — no leftover **mkstemp** temp file (`.<name>.XXXXXX`) — while explicitly excluding the expected `.<name>.lock` sidecar. The durability guarantee (no torn/partial temp survives) is still fully asserted.
- **Files modified:** tests/test_provision_state.py
- **Verification:** `cd yulu/scripts && python3 -m pytest ../../tests/test_provision_state.py ../../tests/test_provision_resume.py -x -q` → 20 passed.
- **Committed in:** 752c4ac (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug — test assertion)
**Impact on plan:** Test-only correction so the assertion matches the (planned) fcntl parity; no change to `state.py` behaviour, no scope creep. All durability/preservation/resume guarantees are still asserted.

## Issues Encountered
None beyond the deviation above. The full suite (738 passed, 1 skipped — the pre-existing e2e opt-in requiring a real mlx model) confirmed no regressions across the repo.

## User Setup Required
None - no external service configuration required. `state.py` is pure local file I/O over the existing `.yulu-install.json`.

## Next Phase Readiness
- **Plan 06-04 (CLI provision walk):** the resume primitives are ready. The driver composes `provision.REGISTRY` + `provision.state` exactly as the docstring's walk contract specifies — `is_done` → skip, `mark(running)` → `apply` → `mark(result)`, break on error. `resume_order` gives the not-yet-ok worklist directly.
- **Plan 06-03 (attest.py):** a parallel sibling; the attestation gate runs BEFORE the walk and is untouched here. `default_ledger_path()` (runtime_dir / `.yulu-install.json`) is available for the CLI to resolve the live ledger.
- **Phase 7 (migration):** a missing `steps` key is intentionally treated as a fresh ledger here, NOT migrated. The legacy `venv-mlx-whisper` removal + stale `transcription.mlx.python` normalization remain Phase-7 work (D-08, already tracked as a blocker in STATE.md).

## Self-Check: PASSED

- FOUND: yulu/scripts/provision/state.py
- FOUND: tests/test_provision_state.py
- FOUND: tests/test_provision_resume.py
- FOUND: .planning/phases/06-.../06-02-SUMMARY.md
- FOUND commit: 5363b72 (feat — state.py)
- FOUND commit: 752c4ac (test — state + resume)

---
*Phase: 06-agent-orchestrated-provisioning-decoupled-skill-install*
*Completed: 2026-05-30*
