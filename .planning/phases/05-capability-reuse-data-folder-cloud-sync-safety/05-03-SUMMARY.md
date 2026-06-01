---
phase: 05-capability-reuse-data-folder-cloud-sync-safety
plan: 03
subsystem: infra
tags: [cloud-sync, icloud, cloudstorage, sf_dataless, file-provider, trpc, macos, stdlib, security]

# Dependency graph
requires:
  - phase: 05-capability-reuse-data-folder-cloud-sync-safety (Plan 01)
    provides: MacOSPathResolver.assert_runtime_not_synced() — lazily imports is_cloud_root from this module
  - phase: 02 (PathResolver seam)
    provides: yulu_platform.macos package + runtime_dir/data_dir split this detection guards
  - phase: 04 (capabilities tRPC router)
    provides: the safe python-spawn idiom (PYTHONPATH + SIGKILL timeout + typed degrade) mirrored here
provides:
  - "yulu_platform.macos.cloud_detect.is_cloud_root(path) -> CloudRootResult (stdlib path-prefix + SF_DATALESS)"
  - "is_evicted(path) — single-file SF_DATALESS eviction signal for warning copy"
  - "cloud.detect(path) read-only tRPC route in system.ts (argv-passed, typed-error degrade)"
  - "Unskipped 05-01 runtime-lock guard tests (assert_runtime_not_synced now exercised)"
affects: [05-04 folder-picker warn flow, data-folder cloud-sync safety]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Stdlib cloud-root detection: path-prefix relative to Path.home() + os.stat().st_flags & stat.SF_DATALESS — NO os.getxattr (absent on macOS CPython)"
    - "Read-only tRPC python-spawn: user path passed as a SEPARATE argv element (sys.argv[1]), never shell-interpolated; degrades to a typed not-cloud default"

key-files:
  created:
    - yulu/scripts/yulu_platform/macos/cloud_detect.py
    - tests/test_cloud_detect.py
  modified:
    - yulu/scripts/yulu_ui/src/routers/system.ts

key-decisions:
  - "Eviction detection uses stat.SF_DATALESS (0x40000000), NEVER os.getxattr — the latter is absent on macOS CPython (RESEARCH Pitfall 2, on-device verified)"
  - "cloud.detect passes the candidate path as a separate spawn argv element read via sys.argv[1] — never concatenated into the -c body or a shell (T-05-07); proven with an adversarial $(touch) path that did not execute"
  - "Detection is metadata-only (os.stat, no open()) so it never materializes a dataless file (T-05-08); child scan bounded to [:64] with follow_symlinks=False (T-05-09/10)"
  - "Module is pure stdlib with NO Darwin gate at import — imports on any OS (off-Darwin st_flags simply lacks the bit = correct not-dataless); satisfies Plan 01's lazy import + the no-shadow/stub tests"

patterns-established:
  - "CloudRootResult frozen dataclass (is_cloud, engine, reason, dataless_sample) as the single detection contract shared by the runtime-lock guard and the UI route"
  - "Never-raise detection: is_cloud_root/is_evicted degrade to a safe not-cloud value on any exception (mirrors capabilities.probes idiom)"

requirements-completed: [DATA-03]

# Metrics
duration: 11min
completed: 2026-05-30
---

# Phase 05 Plan 03: Cloud-Sync-Root Detection Primitive Summary

**Stdlib `is_cloud_root(path)` classifying the two macOS sync-root families (iCloud Drive + `~/Library/CloudStorage/<Provider>`) plus the live `SF_DATALESS` eviction flag, exposed to the UI via a read-only `cloud.detect` tRPC route that passes user input as argv (never shell-interpolated).**

## Performance

- **Duration:** 11 min
- **Started:** 2026-05-30T10:34:47Z
- **Completed:** 2026-05-30T10:45:26Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- `cloud_detect.py` (199 lines): `is_cloud_root(path) -> CloudRootResult` matching iCloud Drive (`~/Library/Mobile Documents/com~apple~CloudDocs`) and third-party File Provider engines (`~/Library/CloudStorage/<Provider>-<account>` → google-drive/dropbox/onedrive/cloudstorage) by path-prefix, plus `is_evicted()`/`_is_dataless()` using `os.stat().st_flags & stat.SF_DATALESS`. Pure stdlib, no Darwin gate, never raises.
- `cloud.detect(path)` tRPC route in `system.ts`: spawns `python3` read-only with `PYTHONPATH=scriptDir`, the candidate path passed as a separate argv element and read via `sys.argv[1]`; parses the JSON `CloudRootResult` and degrades to a typed not-cloud default on any failure so detection can never block the Plan 04 folder picker.
- The two previously-skipped 05-01 runtime-lock guard tests (`assert_runtime_not_synced_local_is_noop`, `..._rejects_cloud_root`) now unskip and pass on Darwin — `cloud_detect` landing armed Plan 01's lazy import.
- Verified the command-injection mitigation directly: an adversarial path `/tmp/$(touch /tmp/PWNED_0503); .../Yulu` was treated as a literal path and did NOT execute (file never created).

## Task Commits

1. **Task 1 (RED): failing cloud_detect tests** - `c3300b3` (test)
2. **Task 1 (GREEN): cloud_detect.py implementation** - `5cebcdd` (feat)
3. **Task 2: cloud.detect tRPC route** - `dbb6658` (feat)

_Task 1 was `tdd="true"` → RED (test) then GREEN (feat); no REFACTOR needed (code matches the on-device-validated RESEARCH Pattern 1 reference)._

## Files Created/Modified
- `yulu/scripts/yulu_platform/macos/cloud_detect.py` - DATA-03 detection: `CloudRootResult` frozen dataclass, `is_cloud_root`, `is_evicted`, `_is_dataless`, `_engine_from_cloudstorage_segment`. Stdlib path-prefix + `SF_DATALESS`; metadata-only; bounded child scan.
- `tests/test_cloud_detect.py` - 14 fully-mocked, OS-independent tests: both cloud families + each engine, not-cloud for `~/.config/yulu` and `~/Movies/Yulu`, SF_DATALESS eviction via mocked `os.stat`, belt-and-suspenders dataless flagging, never-raise on garbage input, and a no-`getxattr` source guard.
- `yulu/scripts/yulu_ui/src/routers/system.ts` - added the `cloud.detect` sub-route + an env/timeout-aware `runSpawnEnv`, the read-only `CLOUD_DETECT_PY` one-liner, the `cloudDetectSchema`, and the typed `CLOUD_DETECT_DEGRADED` default.

## Decisions Made
- **SF_DATALESS, not os.getxattr.** The CONTEXT.md hint (`com.apple.fileprovider` via `os.getxattr`) is wrong for macOS — the `os` xattr family is compiled only on Linux. `stat.SF_DATALESS` (0x40000000) is the OS's own ground-truth eviction bit and is stdlib. Verified on this Mac: `hasattr(os,'getxattr')` is False; the literal `getxattr` token is absent from the module (plan grep clean).
- **Path as argv, never shell.** The route passes `input.path` as a separate spawn argv element (`["-c", CLOUD_DETECT_PY, input.path]`) read via `sys.argv[1]`. zod validates a non-empty string at the boundary; the python side `expanduser+resolve`s and bounds the scan. No shell, no `-c` string concatenation (T-05-07).
- **Degrade, never block.** A detection failure (spawn error, SIGKILL timeout, bad JSON, off-Darwin) returns `{is_cloud:false, engine:"", reason:"detection unavailable", dataless:false}` so folder selection is never blocked by a detection hiccup.

## Deviations from Plan

The plan body contained an internal contradiction: its `<action>` asked the module docstring to "state: ... NOT os.getxattr (Pitfall 2)", while its `<verify>`/success-criteria assert `grep -n getxattr cloud_detect.py` **returns nothing**. Naming `os.getxattr` literally in the docstring would fail the grep gate the verifier runs.

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reconciled the docstring-vs-grep contradiction**
- **Found during:** Task 1 (GREEN) — my own source-guard test (`test_module_uses_sf_dataless_not_getxattr`) caught the literal `getxattr` token in the module docstring.
- **Issue:** The plan's `<action>` (docstring must name `os.getxattr`) conflicts with its hard verify gate (`grep getxattr` must return nothing). The load-bearing intent is "no executable `os.getxattr` *call*"; the grep is a coarse proxy.
- **Fix:** Kept the full Pitfall-2 documentation but reworded the docstring to refer to the Linux-only xattr family obliquely (`os.get<x>attr`) so no literal `getxattr` substring remains. Strengthened the test to assert the primary intent (no `os.getxattr(`/`os.listxattr`/`os.setxattr`/`getxattr(` call) AND the grep-clean property.
- **Files modified:** `yulu/scripts/yulu_platform/macos/cloud_detect.py`, `tests/test_cloud_detect.py`
- **Verification:** `grep -c getxattr cloud_detect.py` → 0; `grep -c SF_DATALESS` → 10; 14/14 tests pass.
- **Committed in:** `5cebcdd` (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 blocking — internal plan contradiction).
**Impact on plan:** Resolution honors both the documentation intent and the verifier's hard grep gate. No scope change; detection behavior unaffected.

## Issues Encountered
None beyond the documented deviation. The `cloud_detect` module landing automatically flipped 05-01's two skipped guard tests to passing, as Plan 01 designed (lazy import + `_cloud_detect_or_skip`).

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- DATA-03 detection primitive is complete and in Wave 1. Plan 04 (Wave 2) can wire `cloud.detect` into the folder-picker warn-before-accept flow (D-03): call `system.pickFile` then `system.cloud.detect({ path })` and surface a warning when `is_cloud` is true (using `engine`/`reason`/`dataless` for the copy).
- The `CloudRootResult` contract (is_cloud, engine, reason, dataless_sample) and the route's JSON shape (`is_cloud, engine, reason, dataless`) are the stable interfaces for Plan 04.
- No pinning, no blocking, no migration introduced (Phase 5 scope guard D-08 honored).

## Self-Check: PASSED

- FOUND: `yulu/scripts/yulu_platform/macos/cloud_detect.py`
- FOUND: `tests/test_cloud_detect.py`
- FOUND: `.planning/phases/05-capability-reuse-data-folder-cloud-sync-safety/05-03-SUMMARY.md`
- FOUND commits: `c3300b3` (RED), `5cebcdd` (GREEN), `dbb6658` (route)
- FOUND `cloud.detect` route in `system.ts`

---
*Phase: 05-capability-reuse-data-folder-cloud-sync-safety*
*Completed: 2026-05-30*
