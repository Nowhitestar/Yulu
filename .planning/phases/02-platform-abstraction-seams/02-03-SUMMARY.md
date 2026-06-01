---
phase: 02-platform-abstraction-seams
plan: 03
subsystem: infra
tags: [swift, screencapturekit, capturebackend, launchd, plist, status-agent, platform-seam]

# Dependency graph
requires:
  - phase: 02-platform-abstraction-seams (02-01)
    provides: PathResolver + DaemonManager Python ABCs (the read-side caller routing this plan completes on the Swift/launchd side)
provides:
  - "Swift CaptureBackend protocol (PCM-frames + source-list seam) with ScreenCaptureKitBackend as the macOS 13–14.3 arm (PLAT-01, D-02, D-03)"
  - "Direct-launch com.yulu.audiodaemon.plist — open -W orphan vector removed at its root (PLAT-03 plist half, D-05)"
  - "status_agent.swift loadRecordingDir() — menu-bar Recent Recordings now reads audio.output_dir from config.json (PLAT-04 status_agent half, D-07)"
  - "02-04 insertion point: ScreenCaptureKitBackend is selected behind the CaptureBackend seam; the 14.4+ ProcessTapBackend arm drops in with one if #available switch"
affects: [02-04 (Core Audio process-tap arm + clean-machine TCC/zero-orphan human-verify), Phase 5 (DATA runtime/content split reads the same config path), Phase 7 (upgrade migration relies on the open -W orphan being gone)]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "CaptureBackend protocol: AnyObject seam hiding SCStreamConfiguration / CATapDescription / TCC vocabulary behind isReady/lastError/probePermission/startCapture/stopCapture/sources() + neutral CaptureSource{id,name,kind} (D-09)"
    - "Wrap-don't-rewrite (D-03): existing AudioCapture renamed to ScreenCaptureKitBackend with conformance added; SysAudioOutput planar-Float32→interleaved-Int16 conversion kept byte-for-byte"
    - "Swift source-static gate tests (no swiftc) mirroring the Python static-assert style: slice the protocol/struct declaration block and assert vocabulary neutrality"

key-files:
  created:
    - tests/test_audio_daemon_capture_gate.py
    - tests/test_audiodaemon_plist_direct_launch.py
  modified:
    - yulu/scripts/audio_daemon.swift
    - yulu/scripts/status_agent.swift
    - yulu/scripts/com.yulu.audiodaemon.plist
    - tests/test_status_agent_config.py

key-decisions:
  - "CaptureBackend declared with a value-type CaptureSource{id,name,kind}; sources() returns [] on a 2s SCShareableContent timeout (graceful 'no enumerable sources now', not an error) — keeps the protocol synchronous to match the existing start/stop semaphore idiom"
  - "ScreenCaptureKitBackend conforms to CaptureBackend only (NOT NSObject/SCStreamOutput as the RESEARCH idealized snippet showed) — the real AudioCapture delegates frame output to a separate SysAudioOutput, so conformance is added without collapsing that split (true wrap-don't-rewrite, D-03)"
  - "status_agent loadRecordingDir() returns String (not URL as the RESEARCH snippet) to match loadRecentRecordings' string-interpolated vmDir/mvDir call site; uses NSString.expandingTildeInPath/NSHomeDirectory() for in-file idiom consistency (line 10), not FileManager.homeDirectoryForCurrentUser"
  - "Swift static-assert section appended to existing tests/test_status_agent_config.py rather than a new file — the existing file already pairs Python (status_agent_config) + Swift concerns for the status agent; kept the Python tests untouched"

patterns-established:
  - "Platform-capability Swift seam = protocol : AnyObject with behavior-only members + a neutral value-type source descriptor; arms own all OS vocabulary internally (mirrors yulu_platform/base.py discipline in Swift)"
  - "02-04 tap-arm hook left as an explicit, commented if-#available insertion point in AppDelegate — the next plan switches arms without touching the consumer"

requirements-completed: [PLAT-01, PLAT-03, PLAT-04]

# Metrics
duration: 6min
completed: 2026-05-30
---

# Phase 02 Plan 03: CaptureBackend Swift Seam + Daemon Direct-Launch + Config Path Read Summary

**Swift `CaptureBackend` protocol extracted (ScreenCaptureKit conforms as `ScreenCaptureKitBackend`, wrap-not-rewrite), audiodaemon plist switched to direct binary launch (open -W orphan removed), and status_agent menu-bar list now reads `audio.output_dir` from config.json.**

## Performance

- **Duration:** 6 min
- **Started:** 2026-05-30T06:06:51Z
- **Completed:** 2026-05-30T06:13:00Z
- **Tasks:** 2
- **Files modified:** 6 (3 source, 1 plist→source, 2 tests; +1 test extended)

## Accomplishments
- **CaptureBackend protocol (PLAT-01, D-02):** the single Swift seam PLAT-01/02 require — `isReady`/`lastError`/`probePermission`/`startCapture`/`stopCapture`/`sources()` + `CaptureSource{id,name,kind}`, carrying no SCStreamConfiguration/SCContentFilter/CATapDescription/TCC vocabulary (D-09).
- **SCK arm conforms in place (D-03):** `AudioCapture` → `final class ScreenCaptureKitBackend: CaptureBackend`; the battle-tested `SysAudioOutput` planar-Float32→interleaved-Int16 conversion and the start/stop/probe semaphore bodies are unchanged. `AppDelegate.audioCapture` retyped to `CaptureBackend?` with a clearly-marked 02-04 tap-arm insertion point.
- **Daemon direct-launch (PLAT-03, D-05):** `com.yulu.audiodaemon.plist` `ProgramArguments` changed from `["/usr/bin/open","-W","…/Yulu.app"]` to the single in-bundle binary `__SCRIPT_DIR__/Yulu.app/Contents/MacOS/audio_daemon` — `launchctl unload` will leave zero orphan processes (no `open` helper in between). LSUIElement + `.accessory` already prevent a Dock icon, so no regression.
- **status_agent config path (PLAT-04, D-07):** ported `loadRecordingDir()` (from audio_daemon.swift:45-58) reads `audio.output_dir`, honors `~/`, falls back to `~/Movies/Yulu` only as default; `loadRecentRecordings` now derives `base`/`base/voicemails` from it instead of the hardcoded home path.
- **record_audio.py Python↔daemon socket boundary: untouched** (verified via git — the critical constraint held).

## Task Commits

Each task was committed atomically:

1. **Task 1: Extract CaptureBackend protocol; conform SCK as ScreenCaptureKitBackend (PLAT-01/D-02/D-03)** — `de5a0ad` (refactor)
2. **Task 2: Direct-launch plist (D-05) + status_agent reads config.json output_dir (D-07)** — `1012758` (fix)

**Plan metadata:** _(this commit)_ (docs: complete plan)

## Files Created/Modified
- `yulu/scripts/audio_daemon.swift` — Added `CaptureBackend` protocol + `CaptureSource` struct; renamed `AudioCapture` → `ScreenCaptureKitBackend` with conformance + `isReady`/`lastError`/`sources()` bridges; retyped `AppDelegate.audioCapture` to the protocol with the 02-04 insertion point.
- `yulu/scripts/com.yulu.audiodaemon.plist` — `ProgramArguments` now launches the in-bundle binary directly (no `open -W`).
- `yulu/scripts/status_agent.swift` — Added `loadRecordingDir()` config.json reader; `loadRecentRecordings` sources its base directory from it.
- `tests/test_audio_daemon_capture_gate.py` — NEW: static gate proving the protocol + SCK conformer exist, the conversion survives verbatim, and the protocol/struct stay free of SCK/tap vocabulary (D-09).
- `tests/test_audiodaemon_plist_direct_launch.py` — NEW: asserts the plist launches `MacOS/audio_daemon` directly and contains no `/usr/bin/open` or `-W`.
- `tests/test_status_agent_config.py` — EXTENDED: Swift static-asserts that `loadRecordingDir()`/`output_dir` exist and the hardcoded `\(home)/Movies/Yulu` source is gone (literal survives only as fallback).

## Decisions Made
- **`sources()` synchronous with a 2s timeout returning `[]`:** keeps the protocol on the same blocking semaphore idiom the existing start/stop use; an empty list means "no enumerable sources right now," not an error.
- **`ScreenCaptureKitBackend: CaptureBackend` only (not also `NSObject`/`SCStreamOutput`):** the RESEARCH idealized snippet merged the two, but the real code delegates frame output to a separate `SysAudioOutput` — conformance was added without collapsing that split, honoring D-03.
- **`loadRecordingDir() -> String` (not `URL`):** matches the string-interpolated `vmDir`/`mvDir` call site and status_agent's `NSString.expandingTildeInPath` idiom; cleaner than threading a `URL` through interpolation.
- **Swift static gate appended to the existing config test file:** that file already co-locates the status-agent's Python + Swift concerns; the Python tests were left byte-for-byte intact.

## Deviations from Plan

None — plan executed exactly as written. (The few shaping choices above — String vs URL return type, conformance set, test-file placement — are within the latitude the plan/RESEARCH explicitly granted, not deviations from planned behavior; no deviation rules were triggered.)

## Issues Encountered
None. Both Swift files typecheck clean (the `NSUserNotification` deprecation warnings in status_agent.swift:853-866 are pre-existing and out of scope — not introduced or touched by this plan). Full suite: 593 passed, 1 skipped (pre-existing skip).

## User Setup Required
None — Swift system frameworks only (ScreenCaptureKit/Cocoa/Carbon already linked); no package-manager install touched this plan (threat T-02-SC: N/A).

## Next Phase Readiness
- **02-04 is unblocked:** the `CaptureBackend` seam + `AppDelegate` insertion point are in place; the 14.4+ `ProcessTapBackend` arm drops in behind one `if #available(macOS 14.4, *)` switch.
- **Deferred to 02-04 (clean-machine human-verify, NOT automatable here):** confirm the directly-launched binary retains ScreenCapture + Microphone TCC under `com.yulu.audiodaemon` (responsible-process re-attribution, threat T-02-09 / Assumption A1) and that `launchctl unload` leaves zero processes.
- **macOS floor stays 13+ (D-01, informational):** the SCK arm is the floor arm; raising to 14.4 only gates the new tap arm in 02-04.

## Self-Check: PASSED

- Created files verified on disk: `tests/test_audio_daemon_capture_gate.py`, `tests/test_audiodaemon_plist_direct_launch.py`, `02-03-SUMMARY.md`.
- Modified files present: `audio_daemon.swift`, `status_agent.swift`, `com.yulu.audiodaemon.plist`, `tests/test_status_agent_config.py`.
- Task commits exist in history: `de5a0ad` (Task 1), `1012758` (Task 2).

---
*Phase: 02-platform-abstraction-seams*
*Completed: 2026-05-30*
