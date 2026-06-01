---
phase: 05-capability-reuse-data-folder-cloud-sync-safety
plan: 01
subsystem: infra
tags: [path-resolver, cloud-sync, sqlite-wal, data-folder, macos, stdlib]

# Dependency graph
requires:
  - phase: 02-platform-seam-macos-impls
    provides: "MacOSPathResolver (config_dir/data_dir/runtime_dir seam); runtime_dir kept distinct from config_dir for this split"
  - phase: 03-host-capability-detection
    provides: "probes.probe_recording_dir lazy+guarded MacOSPathResolver import idiom (mirrored here)"
provides:
  - "runtime_dir() LOCKED machine-local (never reads audio.output_dir); diverges from configurable data_dir()"
  - "assert_runtime_not_synced() startup guard — rejects a cloud-detected runtime path (lazy/guarded cloud_detect import; no-op until Plan 03 lands)"
  - "The 3 hardcoded ~/Movies/Yulu content literals (search CORPUS_ROOT, voicemail VOICEMAIL_DIR_DEFAULT, record_audio output_dir fallback) route through data_dir()"
  - "SEARCH_DB_PATH (WAL SQLite, runtime) routes through runtime_dir(), staying ~/.config/yulu"
affects: [05-03-cloud-detect, 05-04-folder-picker, 07-migration]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy+guarded resolver helpers (_resolve_data_dir/_resolve_runtime_dir): try MacOSPathResolver, degrade to historical literal off-Darwin/on ImportError — module always imports"
    - "Runtime/content split: runtime_dir() never sourced from user config; assert-don't-configure lock (RESEARCH Pattern 2)"

key-files:
  created:
    - tests/test_search_corpus_root.py
  modified:
    - yulu/scripts/yulu_platform/macos/path_resolver.py
    - yulu/scripts/search/indexer.py
    - yulu/scripts/voicemail/repo.py
    - yulu/scripts/record_audio.py
    - tests/test_yulu_platform_macos.py

key-decisions:
  - "runtime_dir() stays ~/.config/yulu — NOT relocated to Application Support (RESEARCH Pitfall 1: pure churn against 38+ callers, zero DATA-02 benefit)"
  - "Runtime lock rationale framed as SQLite-WAL corruption + file eviction, NEVER 'sockets can't exist in a synced folder' (RESEARCH Pitfall 3: a socket CAN bind under iCloud — verified on-device)"
  - "cloud_detect imported lazily+guarded inside assert_runtime_not_synced — Plan 03 (same wave) owns that file; the guard degrades to no-op until it lands, so path_resolver imports on any OS"
  - "Tests assert via the resolver helpers directly (no importlib.reload of shared modules) — reloading mutated dataclass/exception identity and broke unrelated parse_stem/voicemail tests"

patterns-established:
  - "Content-root literal routing: every hardcoded ~/Movies/Yulu becomes _resolve_data_dir(); existing-file migration deferred to Phase 7 (D-08)"
  - "Runtime-state literal routing: ~/.config/yulu SQLite/socket/lock paths route through runtime_dir() (machine-local invariant), same value today"

requirements-completed: [DATA-02, DATA-01]

# Metrics
duration: 17min
completed: 2026-05-30
---

# Phase 5 Plan 01: Runtime/Content Path Split + Content-Literal Routing Summary

**Diverged the LOCKED machine-local `runtime_dir()` (SQLite/WAL, sockets, locks — never synced) from the configurable `data_dir()`, added an `assert_runtime_not_synced()` startup guard, and routed the three hardcoded `~/Movies/Yulu` content literals through `data_dir()` while keeping `SEARCH_DB_PATH` on `runtime_dir()`.**

## Performance

- **Duration:** 17 min
- **Started:** 2026-05-30T09:53:19Z
- **Completed:** 2026-05-30T09:58:00Z (approx)
- **Tasks:** 2 (both TDD)
- **Files modified:** 6 (5 modified, 1 created)

## Accomplishments
- `runtime_dir()` is now explicitly LOCKED machine-local — its docstring + a module-level comment block state it is NOT configurable, NEVER reads `audio.output_dir`, and stays `~/.config/yulu` (no relocation). This is the HARD PREREQUISITE (D-01/D-06) that must land before Plan 04's cloud-capable folder picker.
- `assert_runtime_not_synced()` rejects a cloud-detected runtime path at startup, lazily+guardedly importing `cloud_detect.is_cloud_root` (Plan 03's same-wave file) so it degrades to a no-op until that lands and never blocks import on any OS.
- The three content literals (`search.indexer.CORPUS_ROOT`, `voicemail.repo.VOICEMAIL_DIR_DEFAULT`, `record_audio.py` output_dir fallback) now follow `data_dir()`, so a configured data-folder moves new content. `record_audio`'s fallback changed from a repo-relative `meeting-recordings` dir to the resolver default.
- `SEARCH_DB_PATH` (WAL-mode SQLite) routes through `runtime_dir()` — the runtime/content split holds even when the content folder is configured elsewhere.
- Full Python suite green: **672 passed, 3 skipped** (2 skips are the cloud_detect-dependent guard tests, correctly waiting on Plan 03).

## Task Commits

Each task was committed atomically (TDD: test → feat):

1. **Task 1: Diverge runtime_dir() (locked) + runtime-lock guard** — `24c70f6` (test), `eac36de` (feat)
2. **Task 2: Route 3 content literals through data_dir() + routing test** — `781dc66` (test), `3fc4df4` (feat)

**Plan metadata:** _(this commit)_ docs: complete plan

## Files Created/Modified
- `yulu/scripts/yulu_platform/macos/path_resolver.py` - LOCKED `runtime_dir()` docstring + split comment block; new `assert_runtime_not_synced()` (lazy/guarded cloud_detect import, raises under a cloud root with WAL/eviction-framed message)
- `yulu/scripts/search/indexer.py` - `_resolve_runtime_dir()`/`_resolve_data_dir()` guarded helpers; `SEARCH_DB_PATH = _resolve_runtime_dir()/"search.sqlite"`, `CORPUS_ROOT = _resolve_data_dir()`
- `yulu/scripts/voicemail/repo.py` - `_resolve_data_dir()` helper; `VOICEMAIL_DIR_DEFAULT = _resolve_data_dir()/"voicemails"`
- `yulu/scripts/record_audio.py` - `_resolve_data_dir()` helper; output_dir `setdefault` fallback now `str(_resolve_data_dir())` instead of repo-relative `meeting-recordings`
- `tests/test_yulu_platform_macos.py` - 4 new tests: runtime_dir locked (regression), guard no-op on local path, guard raises under mocked cloud root (skips until Plan 03), guard no-op when cloud_detect unimportable
- `tests/test_search_corpus_root.py` (new) - 8 tests: helpers follow configured `data_dir()`, module constants wired to helpers, `SEARCH_DB_PATH` stays under runtime/`.config/yulu` and never under data_dir, fallback to historical literal when resolver unavailable

## Decisions Made
- **No runtime-dir relocation.** Kept `runtime_dir()` == `~/.config/yulu` per RESEARCH Pitfall 1 — moving to `~/Library/Application Support` is pure churn against 38+ callers with no DATA-02 benefit; belongs with Phase 7 migration if ever wanted.
- **Lock framed as corruption/eviction, not impossibility.** Per RESEARCH Pitfall 3 (a Unix socket bind under iCloud *succeeded* on-device), all comments + the `RuntimeError` message cite SQLite-WAL corruption (checkpoint + hot-journal relocation) and dataless file eviction — the word "impossibility" appears only as an explicit denial ("never physical impossibility").
- **`cloud_detect` imported lazily+guarded.** Plan 03 (same wave) owns `cloud_detect.py`; `assert_runtime_not_synced()` mirrors `probes.probe_recording_dir`'s try/except idiom so `path_resolver.py` imports cleanly today and the guard arms automatically once the sibling lands.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test fixture polluted shared module identity, breaking unrelated tests**
- **Found during:** Task 2 (full-suite verification after GREEN)
- **Issue:** The first draft of `tests/test_search_corpus_root.py` used `importlib.reload()` on `search.indexer` / `voicemail.repo` under a monkeypatched config to re-evaluate the module-level constants. Reloading replaced the module-level `StemInfo` dataclass and `AmbiguousVoicemailId`/`VoicemailNotFound` exception *class objects*, so structurally-equal instances compared unequal and `pytest.raises(<old class>)` no longer matched — failing `test_search_parse_stem.py`, `test_voicemail_repo.py`, and `test_voicemail_cli.py` (5 tests) purely from cross-test ordering pollution. The implementation code was correct; the test was the bug.
- **Fix:** Rewrote the test to import the modules once (no reload) and assert against the pure `_resolve_data_dir()`/`_resolve_runtime_dir()` helpers directly under monkeypatched config, plus structural assertions that the module constants are wired to those helpers. No shared module state is mutated.
- **Files modified:** tests/test_search_corpus_root.py
- **Verification:** `pytest tests/test_search_corpus_root.py tests/test_search_parse_stem.py tests/test_voicemail_repo.py tests/test_voicemail_cli.py` → all pass; full suite 672 passed / 3 skipped.
- **Committed in:** `3fc4df4` (Task 2 GREEN commit — folded into the same RED→GREEN cycle)

---

**Total deviations:** 1 auto-fixed (1 bug — in test infrastructure, not production code)
**Impact on plan:** The fix corrected a test-isolation defect introduced during this plan; it tightened the test approach (helper-direct, no module reload) and changed no production behavior. No scope creep.

## Issues Encountered
- The plan's Task 1 behavior spec requires exercising `assert_runtime_not_synced()`'s non-degraded raise path, which needs `cloud_detect.is_cloud_root` — a deliverable of Plan 03 (same-wave sibling, not yet landed). Resolved by writing those two assertions to `pytest.skip` when `cloud_detect` is absent, so they pass now and arm automatically once Plan 03 lands. The degrade-to-no-op contract (this plan's own) is tested unconditionally and passes.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- **DATA-02 (runtime/content split + lock) is landed** — the hard prerequisite for Plan 04's cloud-capable folder picker (D-06) is satisfied.
- **Plan 03 (`cloud_detect.py`) will auto-activate the guard:** once `yulu_platform/macos/cloud_detect.py` exists with `is_cloud_root` + `CloudRootResult`, the 2 currently-skipped tests in `test_yulu_platform_macos.py` will run and `assert_runtime_not_synced()` will enforce the lock for real. No further change to `path_resolver.py` is needed.
- **Plan 04 (folder picker)** can now wire the cloud-detect warning knowing runtime can never follow the chosen content folder.
- **Phase 7 migration** carries the existing-file move at the old `~/Movies/Yulu` root (D-08); this plan only fixed the live-config path so new content lands in the configured folder.

## Self-Check: PASSED

- Created files exist: `05-01-SUMMARY.md`, `tests/test_search_corpus_root.py`
- Task commits exist: `24c70f6` (RED T1), `eac36de` (GREEN T1), `781dc66` (RED T2), `3fc4df4` (GREEN T2)
- Full Python suite: 672 passed, 3 skipped

---
*Phase: 05-capability-reuse-data-folder-cloud-sync-safety*
*Completed: 2026-05-30*
