---
status: partial
phase: 05-capability-reuse-data-folder-cloud-sync-safety
source: [05-VERIFICATION.md]
started: 2026-05-30T06:30:00Z
updated: 2026-05-30T06:30:00Z
---

## Current Test

[awaiting human testing — requires a real iCloud/Google Drive folder + running daemons. Code is complete: 707 pytest + 345 vitest pass, SF_DATALESS detection + warn-before-accept + runtime lock all unit-covered with mocks. These are live-sync confirmation checks; the runtime LOCK (assert_runtime_not_synced) already structurally prevents the catastrophic SQLite-on-sync-root case regardless.]

## Tests

### 1. Live cloud-folder warning (DATA-03)
expected: Settings → data-folder picker → choose a real iCloud (`~/Library/Mobile Documents/com~apple~CloudDocs/...`) or Google Drive (`~/Library/CloudStorage/GoogleDrive-...`) folder → an inline eviction/corruption WARNING appears before commit (Cancel / Use-anyway); committing only on opt-in; a non-cloud folder commits immediately with no warning
result: [pending]

### 2. Data-folder change → audio-daemon restart → new recording lands (DATA-01)
expected: With daemons running — change the data-folder in settings → the audio daemon restarts (it caches RECORDING_DIR at start) → record → the WAV lands in the NEW folder; status_agent "Recent Recordings" menu reflects the new folder
result: [pending]

### 3. Live SF_DATALESS eviction (DATA-02)
expected: On a real sync engine — an evicted (dataless) file in a cloud folder reports `os.stat().st_flags & SF_DATALESS` true; runtime/state (SQLite/sockets) stays in `~/.config/yulu` and is never placed in the data-folder; the runtime lock rejects any attempt to point runtime at a synced path
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps

None — code-complete, live-sync confirmation checks. The runtime LOCK structurally prevents the catastrophic case (SQLite/sockets on a sync root) regardless of the live warning. Detail in 05-04-SUMMARY.md "Pending Human Verification".
