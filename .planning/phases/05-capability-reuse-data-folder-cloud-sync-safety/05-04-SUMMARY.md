---
phase: 05-capability-reuse-data-folder-cloud-sync-safety
plan: 04
subsystem: ui
tags: [cloud-sync, icloud, data-folder, trpc, useUtils, react, restart-map, macos, data-loss-safety]

# Dependency graph
requires:
  - phase: 05-capability-reuse-data-folder-cloud-sync-safety (Plan 01)
    provides: runtime_dir/data_dir split + runtime lock (D-06) — runtime can never be routed into the synced data-folder, so the cloud-capable picker is safe to ship
  - phase: 05-capability-reuse-data-folder-cloud-sync-safety (Plan 03)
    provides: cloud.detect(path) read-only tRPC route + CloudRootResult contract (is_cloud/engine/reason/dataless) consumed by the warn flow
  - phase: 04 (settings UI)
    provides: InlineEditRow PathValue folder picker + the consolidated settings render test (the trpc-mock trap)
provides:
  - "audio.output_dir -> restart:audiodaemon in RESTART_MAP (DATA-01 propagation: a data-folder change now restarts the audio daemon)"
  - "Cloud-warn-before-accept in InlineEditRow.PathValue: a folder pick calls cloud.detect, and a detected cloud root shows an inline eviction/corruption warning with opt-in (detect-and-warn, NOT block)"
  - "Focused cloud-warn component test (InlineEditRow.cloudwarn.test.tsx) + the useUtils trpc-mock added to three sibling suites"
affects: [phase-07-migration, data-folder cloud-sync safety, future settings UI work]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Imperative tRPC query inside an event handler via trpc.useUtils().<router>.<proc>.fetch() — used to call cloud.detect on a folder pick without a standing useQuery"
    - "Detect-and-warn UX: an inline React-state warning block (role=alertdialog) that DEFERS onCommit until opt-in; degrades to immediate commit on detection failure (never blocks)"

key-files:
  created:
    - yulu/scripts/yulu_ui/tests/web/InlineEditRow.cloudwarn.test.tsx
  modified:
    - yulu/scripts/yulu_ui/src/config.ts
    - yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx
    - yulu/scripts/yulu_ui/web/src/components/InlineEditRow.css
    - yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx
    - yulu/scripts/yulu_ui/tests/web/InlineEditRow.test.tsx
    - yulu/scripts/yulu_ui/tests/web/TranscriptionSection.test.tsx

key-decisions:
  - "audio.output_dir maps to restart:audiodaemon (not SIGHUP, not plist re-render): the audio daemon caches RECORDING_DIR at process start and no plist injects YULU_OUTPUT_DIR (RESEARCH Pitfall 5 / Open-Q3)"
  - "Folder picker calls cloud.detect imperatively via trpc.useUtils().system.cloud.detect.fetch() — gated on mode === 'folder' so file pickers (model selection) are never cloud-warned"
  - "Warning copy cites EVICTION + DB-corruption-if-runtime-leaked, never socket-impossibility (RESEARCH Pitfall 3 — a Unix socket CAN bind under a sync folder); the copy says 'You can use this folder anyway'"
  - "Detection failure (route degrade / timeout / thrown) falls through to immediate commit — never blocks folder selection (D-03 detect-and-warn, not block; T-05-12)"

patterns-established:
  - "trpc.useUtils() is now part of the InlineEditRow.PathValue render — every test that renders a path-type InlineEditRow must mock trpc.useUtils().system.cloud.detect.fetch (extends the [04-02]/[04-03] consolidated-render mock trap)"
  - "Cloud-warn block reuses the existing inline-edit glass aesthetic (.cloud-warn in InlineEditRow.css) with Cancel / Use-anyway; no new dependency, React state only"

requirements-completed: [DATA-01, DATA-03]

# Metrics
duration: 13min
completed: 2026-05-30
---

# Phase 05 Plan 04: Cloud-Capable Data-Folder Picker Summary

**Wires the data-folder picker end to end: `audio.output_dir` now restarts the audio daemon on change (DATA-01), and choosing a detected cloud-sync root surfaces an inline eviction/corruption warning before the value is committed — opt-in, never a block (DATA-03).**

## Performance

- **Duration:** 13 min
- **Started:** 2026-05-30T10:50:07Z
- **Completed:** 2026-05-30T11:02:41Z
- **Tasks:** 3 code tasks complete (Tasks 1–3); Task 4 is a live-cloud human-verify checkpoint (see Pending Human Verification)
- **Files modified:** 7 (1 created test, 6 modified)

## Accomplishments
- **DATA-01 propagation fixed:** RESTART_MAP `audio.output_dir` `"none"` → `"restart:audiodaemon"`. A data-folder change now reports the audio daemon as needing restart (it caches `RECORDING_DIR` at start; no plist carries `YULU_OUTPUT_DIR`).
- **DATA-03 cloud-warn-before-accept:** `InlineEditRow.PathValue.choose()` now calls Plan 03's `cloud.detect` on a folder pick. A detected cloud root renders an inline eviction/corruption warning (`role=alertdialog`) with **Cancel** / **Use anyway**, and `onCommit` fires only on opt-in. Non-cloud folders — and any detection failure — commit immediately. File-mode pickers are untouched (`mode === "folder"` gate).
- **Tests:** a focused 6-case `InlineEditRow.cloudwarn.test.tsx` pinning the full detect-and-warn-not-block matrix, plus the `useUtils` trpc-mock added to the three suites that render a path picker (settings consolidated render, base InlineEditRow, TranscriptionSection).
- **Full suite green:** typecheck (src + web + root) clean, `vitest` 345/345, web build green, `pytest` 707 passed / 1 skipped.

## Task Commits

Each task was committed atomically:

1. **Task 1: audio.output_dir → restart:audiodaemon (DATA-01)** - `5601968` (fix)
2. **Task 2: cloud-warn-before-accept in the folder picker (DATA-03)** - `262b936` (feat)
3. **Task 3: focused cloud-warn folder-picker test (DATA-03)** - `3ca2fd7` (test)
4. **Deviation fix: useUtils mock for two sibling suites (Rule 3)** - `7dd20c3` (test)

**Plan metadata:** committed separately (docs: complete plan).

_Task 3 was `tdd="true"`. The implementation was built in Task 2 (the plan ordered the wiring before the focused test), so Task 3's test was authored GREEN against the existing behavior; it pins all five plan behaviors plus a sixth file-mode-never-warns case._

## Files Created/Modified
- `yulu/scripts/yulu_ui/src/config.ts` — RESTART_MAP: `audio.output_dir` → `restart:audiodaemon` + a WHY comment (daemon caches RECORDING_DIR; no plist env var; not SIGHUP).
- `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx` — `PathValue` reworked: `useUtils()` + a pending-cloud-warning React state; `choose()` calls `cloud.detect` on folder picks and defers commit when `is_cloud`; a new `CloudWarn` sub-component renders the honest eviction/corruption copy with Cancel / Use-anyway.
- `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.css` — `.cloud-warn` block styling (full-row, glass aesthetic, accent Use-anyway button).
- `yulu/scripts/yulu_ui/tests/web/InlineEditRow.cloudwarn.test.tsx` — **created**: 6 cases (cloud → warn + deferred commit; Use-anyway → commit; Cancel → no commit; not-cloud → immediate; detection error → immediate; file-mode → never warns).
- `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx` — added the `useUtils().system.cloud.detect` mock (default not-cloud) so the consolidated render stays green.
- `yulu/scripts/yulu_ui/tests/web/InlineEditRow.test.tsx`, `.../TranscriptionSection.test.tsx` — added the same `useUtils` mock (Rule 3 deviation, see below).

## Decisions Made
- **Restart, not SIGHUP, for `audio.output_dir`.** The audio daemon reads `audio.output_dir` once at start (`loadRecordingDir()`); SIGHUP wouldn't re-read it and no plist injects `YULU_OUTPUT_DIR`, so a restart is the only mechanism that applies a new default (RESEARCH Pitfall 5 / Open-Q3). Per-recording socket overrides and `record_audio.py` (re-reads each invocation) are unaffected.
- **`useUtils().…detect.fetch()` for the imperative call.** `cloud.detect` is a tRPC *query*; there is no standing `useQuery` for an arbitrary chosen path, so the picker fetches it imperatively inside `choose()` via the tRPC React-Query utils. The cloud branch is gated on `mode === "folder"`.
- **Honest copy, never impossibility.** The warning cites eviction (the OS may make a recording dataless → lost/corrupted mid-write) and that Yulu keeps its DBs/live files out of the folder; it never claims a socket "cannot exist" there (false on-device — RESEARCH Pitfall 3). It ends with "You can use this folder anyway."
- **Degrade, never block.** A `cloud.detect` failure is caught and treated as not-cloud → immediate commit, so a detection hiccup can never block folder selection (T-05-12/13).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Reworded the Pitfall-3 code comment to keep the verifier's grep gate clean**
- **Found during:** Task 2 (cloud-warn component)
- **Issue:** The plan's verification runs `grep -ni 'socket.*cannot\|cannot.*exist' InlineEditRow.tsx` and expects **nothing**. My explanatory comment documenting the Pitfall-3 prohibition literally contained `"a socket cannot exist here"`, tripping the coarse grep even though the intent (no impossibility copy shown to users) was correct.
- **Fix:** Reworded the comment to state the rationale ("a Unix socket CAN bind under a sync folder … so the rationale is corruption/eviction, not impossibility") without the literal `cannot…exist` substring. (Same docstring-vs-grep reconciliation Plan 03 hit.)
- **Files modified:** `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx`
- **Verification:** `grep -ni 'socket.*cannot\|cannot.*exist' InlineEditRow.tsx` → empty.
- **Committed in:** `262b936` (Task 2 commit)

**2. [Rule 3 - Blocking] Added the `useUtils` trpc-mock to two sibling suites the change broke**
- **Found during:** full `vitest` run after Task 3 (cross-file fallout of my own Task 2 change)
- **Issue:** `PathValue` now calls `trpc.useUtils()` on render. Two existing suites that render an `InlineEditRow` path picker — `InlineEditRow.test.tsx` (base path variant) and `TranscriptionSection.test.tsx` (local-model file picker) — mocked `trpc` without `useUtils`, so they crashed with `trpc.useUtils is not a function` (the exact [04-02]/[04-03] consolidated-render mock trap, now extended by the new hook).
- **Fix:** Added a default not-cloud `useUtils().system.cloud.detect.fetch` mock to both files (and to `settings.test.tsx` as part of Task 2).
- **Files modified:** `yulu/scripts/yulu_ui/tests/web/InlineEditRow.test.tsx`, `yulu/scripts/yulu_ui/tests/web/TranscriptionSection.test.tsx`
- **Verification:** full `vitest run` → 73 files / 345 tests pass.
- **Committed in:** `7dd20c3`

---

**Total deviations:** 2 auto-fixed (both blocking — a grep-gate reconciliation and a cross-file test-mock break directly caused by the new `useUtils()` call).
**Impact on plan:** No scope change. Both fixes were necessary to keep the verification gates and the existing suite green. The `useUtils`-in-every-path-picker-test rule is now documented as a pattern for future settings work.

## Issues Encountered
None beyond the two documented deviations. The Plan 03 `cloud.detect` route and its `CloudRootResult` JSON shape (`is_cloud/engine/reason/dataless`) plugged into the picker exactly as the 05-03 summary's "Next Phase Readiness" anticipated.

## Pending Human Verification

Task 4 is a **live-cloud human-verify checkpoint** (`gate="blocking-human"`). All code is written and fully Vitest-covered (detection is mocked: cloud / not-cloud / throw). The three behaviors below depend on a **real iCloud/Drive sync engine, a running daemon stack, and OS-induced eviction** — none of which exist in CI — so they cannot be unit-tested and are routed to a human. This is the phase's data-loss-safety gate.

Run the live stack (`yulu_ui` running) and confirm:

1. **Live cloud warning (real sync root).** Settings → Storage → Output directory → **Choose…** → pick a real iCloud folder (`~/Library/Mobile Documents/com~apple~CloudDocs/…`) OR a Google Drive folder (`~/Library/CloudStorage/GoogleDrive-<account>/…`). **EXPECT:** a warning appears naming the engine and citing eviction/corruption risk **before** the value commits; **Use anyway** (opt-in) and **Cancel** both work.
2. **Local folder → no warning, immediate commit.** Pick a normal local folder (e.g. `~/Movies/Yulu2`). **EXPECT:** NO warning; commits immediately; the row shows the restart (⟳) indicator for the audio daemon.
3. **Change → audio-daemon restart → new recording lands in the new folder.** Apply the data-folder change, restart the audio daemon (Daemons page or `yulu` CLI), record a short clip. **EXPECT:** the new recording lands in the new folder; the status_agent menu reflects it.
4. **Runtime stays machine-local (DATA-02 holds).** `ls ~/.config/yulu/*.sqlite ~/.config/yulu/*.sock` still resolves there; NO `*.sqlite`/`*.sock` appears in the chosen data-folder.
5. **(Optional) Live eviction reports SF_DATALESS.** If you can induce eviction ("Optimise Mac Storage" + disk pressure, or `brctl evict`), confirm an evicted file in the cloud folder reports `SF_DATALESS` — i.e. the harm the warning describes is real.

**Resume signal:** Type "approved" if the cloud warning appears (opt-in, not a block), the local-folder change restarts the audio daemon and new recordings land correctly, and runtime stays in `~/.config/yulu` — or describe what diverged.

## User Setup Required
None - no external service configuration required. (The live-cloud verification above needs a real iCloud/Drive account on the test machine, but no Yulu config changes.)

## Next Phase Readiness
- DATA-01 and DATA-03 are wired and unit-verified; the data-folder is configurable and cloud-aware. Phase 5's reuse-gating plans (REUSE-01/02) are independent of this picker.
- Phase 7 (migration) inherits the safe foundation: the runtime lock (Plan 01) + this detect-and-warn picker mean migration can move CONTENT into a cloud folder while runtime stays locked machine-local.
- Open follow-up (deferred, RESEARCH Pitfall 6 / threat T-05-14, **accepted**): no recording-active guard on a data-folder change yet — moving content mid-recording could orphan a WAV. Out of Phase 5 scope; the existing `recording_lock` arbitrates capture and this plan does not move existing files.

## Self-Check: PASSED

- FOUND: `yulu/scripts/yulu_ui/src/config.ts`
- FOUND: `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx`
- FOUND: `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.css`
- FOUND: `yulu/scripts/yulu_ui/tests/web/InlineEditRow.cloudwarn.test.tsx`
- FOUND: `.planning/phases/05-capability-reuse-data-folder-cloud-sync-safety/05-04-SUMMARY.md`
- FOUND commits: `5601968` (fix DATA-01), `262b936` (feat DATA-03), `3ca2fd7` (test), `7dd20c3` (test mock fix)

---
*Phase: 05-capability-reuse-data-folder-cloud-sync-safety*
*Completed: 2026-05-30*
