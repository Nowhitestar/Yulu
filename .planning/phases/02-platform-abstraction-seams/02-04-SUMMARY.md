---
phase: 02-platform-abstraction-seams
plan: 04
subsystem: infra
tags: [swift, coreaudio, audiotoolbox, process-tap, capturebackend, tcc, entitlements, platform-seam]

# Dependency graph
requires:
  - phase: 02-platform-abstraction-seams (02-03)
    provides: "CaptureBackend protocol + ScreenCaptureKitBackend (13–14.3 arm) + the AppDelegate `if #available` insertion point the tap arm drops into; direct-launch audiodaemon plist"
provides:
  - "ProcessTapBackend (macOS 14.4+ Core Audio process-tap arm) conforming to CaptureBackend, selected behind `if #available(macOS 14.4, *)` with ScreenCaptureKitBackend as the else — floor stays 13+ (PLAT-02, D-01, D-03)"
  - "Pitfall-3 zero-buffer recovery: detect frameCount>0-yet-all-zero IO callbacks and teardown+rebuild the tap+aggregate stack (not merely log)"
  - "NSAudioCaptureUsageDescription wired in Info.plist AND build_audio_daemon.sh's plist ladder; mic entitlement com.apple.security.device.audio-input retained (Pitfall 4, A2)"
  - "Makefile swift-build per-stem framework scoping: audio_daemon links the tap frameworks while window_scanner/recorder_status keep the bare swiftc -o (the tap arm is now compiled by the suite without changing the siblings)"
affects: [Phase 5 (DATA runtime/content split reads the same config path), Phase 7 (upgrade migration relies on the open -W orphan being gone — clean-machine zero-orphan check lives here), "Phase 2 verification (3 runtime gates routed to human_needed)"]

# Tech tracking
tech-stack:
  added: []   # macOS system frameworks only (CoreAudio/AudioToolbox via -framework); no package install
  patterns:
    - "Dual-arm capture selection: `if #available(macOS 14.4, *) { ProcessTapBackend } else { ScreenCaptureKitBackend }` — a runtime OS gate behind the CaptureBackend seam, NOT a compile-time floor raise (D-01/D-03)"
    - "Core Audio process tap = CATapDescription(stereoGlobalTapButExcludeProcesses:[]) → AudioHardwareCreateProcessTap → private aggregate device (TapList=[{SubTapUID}]) → AudioDeviceCreateIOProcIDWithBlock → AudioDeviceStart, feeding the SAME recorder.onSysAudio sink as SCK"
    - "Verified-Apple-bug self-healing: a realtime IO callback counts consecutive all-zero buffers and schedules an off-thread teardown+rebuild once a sustained run crosses threshold (distinct from the both-channels silence-monitor)"
    - "Build-framework blast-radius containment: a per-stem `case` in the Makefile loop links frameworks for one binary only, leaving the other Swift stems' compile invocation byte-for-byte unchanged"

key-files:
  created:
    - tests/test_audiodaemon_entitlements.py
  modified:
    - yulu/scripts/audio_daemon.swift
    - yulu/scripts/Yulu.app/Contents/Info.plist
    - yulu/scripts/build_audio_daemon.sh
    - Makefile
    - tests/test_audio_daemon_capture_gate.py

key-decisions:
  - "Gate at EXACTLY 14.4, never 14.2: the tap symbols exist at 14.2 but AudioCap pins reliable runtime to 14.4; lowering the gate is a D-01/D-03 regression the gate test guards against"
  - "ProcessTapBackend reuses the SysAudioOutput Int16 clamp verbatim (`Int16(max(-1.0,min(1.0,$0))*Float(Int16.max))`) rather than re-deriving — the conversion is battle-tested and the test asserts it appears ≥2× (SCK + tap)"
  - "tap UID read via AudioObjectGetPropertyData(tap, kAudioTapPropertyUID) → CFString (the gist left this as a comment; this is the canonical insidegui/AudioCap approach) and fed as the aggregate's kAudioSubTapUIDKey"
  - "Aggregate device is kAudioAggregateDeviceIsPrivateKey:true (keeps it out of the user-visible device list — T-02-14) + TapAutoStartKey:true; probePermission builds+immediately tears down the tap (no IO proc) to force the one-time TCC handshake without streaming a frame"
  - "Zero-buffer recovery runs the rebuild off the realtime IO thread (DispatchQueue.global) guarded by a `rebuilding` flag so a single trip doesn't spawn concurrent rebuilds; silence (all-zero) is dropped, never written to the WAV"
  - "Entitlements left byte-for-byte unchanged (A2): only the mic entitlement, comment-free; no App-Sandbox / extra capture entitlement added — whether more is needed is the clean-machine human checkpoint, not a guess"

patterns-established:
  - "Platform-capability arm = `@available(macOS X.Y, *) final class … : CaptureBackend` owning all OS vocabulary internally; the consumer switches arms with one if #available and never sees CoreAudio/SCK types (D-09 discipline carried into the tap arm)"
  - "CI-uncoverable runtime behavior (TCC grant, OS downgrade, multi-minute soak for an Apple bug) is delivered as a blocking human-verify task with exact repro steps, NOT faked with automated asserts — the verifier routes it human_needed"

requirements-completed: [PLAT-02]

# Metrics
duration: 11min
completed: 2026-05-30
---

# Phase 02 Plan 04: Core Audio Process-Tap Capture Arm (macOS 14.4+) Summary

**The 14.4+ `ProcessTapBackend` Core Audio tap arm (with verified-Apple-bug zero-buffer teardown+rebuild) lands behind `if #available(macOS 14.4, *)` with ScreenCaptureKit as the 13–14.3 else — the floor stays 13+; NSAudioCaptureUsageDescription + AudioToolbox + the retained mic entitlement are wired, and the three CI-uncoverable runtime gates are documented for human verification.**

## Performance

- **Duration:** 11 min
- **Started:** 2026-05-30T06:30:16Z
- **Completed:** 2026-05-30T06:41:00Z
- **Tasks:** 2 code/config tasks executed + 1 blocking human-verify task documented (3 of 3 in plan)
- **Files modified:** 6 (1 Swift source, 1 Info.plist, 1 build script, 1 Makefile, 1 test extended, 1 test created)

## Accomplishments

- **ProcessTapBackend (PLAT-02 / D-01 / D-03):** `@available(macOS 14.4, *) final class ProcessTapBackend: CaptureBackend` implementing the verified tap sequence from 02-RESEARCH (CATapDescription global tap → `AudioHardwareCreateProcessTap` → read `kAudioTapPropertyUID` → private aggregate device with `TapList=[{SubTapUID}]` → `AudioDeviceCreateIOProcIDWithBlock` → `AudioDeviceStart`). The IO callback converts Float32 (interleaved or planar) to interleaved Int16 reusing the SysAudioOutput clamp verbatim and pushes through the identical `recorder.onSysAudio([Int16])` sink the SCK arm uses.
- **Dual-arm selection (floor stays 13+):** AppDelegate now does `if #available(macOS 14.4, *) { ProcessTapBackend } else { ScreenCaptureKitBackend }` at the 02-03 insertion point. The macOS minimum is **not** raised — 14.4 gates only the new tap arm. `applicationWillTerminate` already calls `audioCapture?.stopCapture()`, so the tap tears down on exit (confirmed, no edit needed).
- **Pitfall 3 zero-buffer self-healing:** the IO callback detects `allSatisfy { $0 == 0.0 }` over a non-empty buffer, counts the consecutive run, and once it crosses threshold while capturing, schedules an off-thread `teardown()`→`buildTap()` rebuild (destroy order `AudioDeviceStop → AudioDeviceDestroyIOProcID → AudioHardwareDestroyAggregateDevice → AudioHardwareDestroyProcessTap`). Silence is dropped, never written to the WAV. This is distinct from the both-channels silence-monitor, so a sys-only zero-out does not false-stop the recording.
- **TCC + entitlement wiring (Pitfall 4 / A2):** `NSAudioCaptureUsageDescription` added to `Yulu.app/Contents/Info.plist` **and** to `build_audio_daemon.sh`'s `plist_set_or_add` ladder (the build-time source of truth). The mic entitlement `com.apple.security.device.audio-input` is **retained** (the aggregate device carries a mic input stream). `-framework AudioToolbox` linked in the build script. Entitlements left comment-free (Phase 1 trap) with no App-Sandbox key.
- **Makefile blast-radius containment:** `swift-build` now links the full tap framework set for `audio_daemon` **only**, via a per-stem `case` — `window_scanner` and `recorder_status` keep the bare `swiftc -o`. `make swift-build` exits 0 and produces all three binaries, so the tap arm is now actually compiled by the suite without altering the siblings.

## Task Commits

Each code/config task was committed atomically:

1. **Task 1: ProcessTapBackend (14.4+ tap arm) + if #available selection + zero-buffer recovery (PLAT-02 / D-01 / D-03)** — `a6f1c3c` (feat)
2. **Task 2: Info.plist NSAudioCaptureUsageDescription + entitlement + AudioToolbox in build + scoped swift-build (PLAT-02 / Pitfall 4 / A2)** — `5081870` (feat)
3. **Task 3: Manual VM / clean-machine validation** — blocking human-verify; no code, see **Pending Human Verification** below.

**Plan metadata:** _(final docs commit)_

## Files Created/Modified

- `yulu/scripts/audio_daemon.swift` — Added `import CoreAudio` + `import AudioToolbox`; new `@available(macOS 14.4, *) final class ProcessTapBackend: CaptureBackend` (tap build/teardown, IO callback Float32→Int16, zero-buffer detection + rebuild); AppDelegate retyped its arm selection to `if #available(macOS 14.4, *)` choosing the tap arm, SCK as the else.
- `yulu/scripts/Yulu.app/Contents/Info.plist` — Added `NSAudioCaptureUsageDescription` (kept the existing mic + screen-capture usage strings).
- `yulu/scripts/build_audio_daemon.sh` — Added the `NSAudioCaptureUsageDescription` plist ladder line and `-framework AudioToolbox` to the swiftc link list.
- `Makefile` — `swift-build` loop now scopes the tap frameworks to `audio_daemon` via a per-stem `case`; other stems keep the bare compile.
- `tests/test_audio_daemon_capture_gate.py` — EXTENDED: 10 new static asserts (tap arm declared/conforms, referenced ≥2×, `@available(macOS 14.4, *)`, gate not lowered to 14.2, SCK is the else at the construction site, Pitfall-3 destroy order, zero-buffer detection + rebuild, tap feeds the shared sink with the reused clamp).
- `tests/test_audiodaemon_entitlements.py` — NEW: asserts the usage description (Info.plist + build ladder), the AudioToolbox + CoreAudio link, the retained mic entitlement, no XML comment (Phase 1 trap), and no App-Sandbox key (A2).

## Decisions Made

- **Gate fixed at 14.4, guarded by the test:** `test_tap_arm_gated_at_14_4_not_lowered` asserts `#available(macOS 14.2` appears nowhere — the gate cannot silently regress to the symbol-availability floor.
- **Tap UID via `kAudioTapPropertyUID`:** the RESEARCH gist left the UID read as a `// read from tapID` comment; implemented as the canonical `AudioObjectGetPropertyData(tap, kAudioTapPropertyUID, …) → CFString`, fed as the aggregate's `kAudioSubTapUIDKey`.
- **Probe builds the tap without an IO proc:** `probePermission()` constructs the tap+aggregate (enough to force the TCC handshake) and immediately tears down — the idle daemon never streams a frame and the macOS indicator does not light up, matching the SCK arm's probe semantics.
- **Rebuild is single-flight and off the realtime thread:** a `rebuilding` flag prevents concurrent rebuilds, and the actual teardown+rebuild runs on `DispatchQueue.global(qos:.userInitiated)` so the realtime IO callback never blocks on HAL destroy calls.
- **Entitlements untouched on purpose (A2):** the plan explicitly defers "does the tap need an extra capture entitlement?" to the clean-machine checkpoint; adding a speculative entitlement now would mask that signal.

## Deviations from Plan

None — plan executed exactly as written. The shaping choices within explicit RESEARCH/plan latitude (tap UID read mechanism, single-flight rebuild flag, planar-vs-interleaved buffer normalization in the IO callback) are not behavioral deviations and triggered no deviation rules. Task 3 is intentionally a documented human-verify checkpoint, not skipped work — see below.

## Pending Human Verification

**Task 3 is a `checkpoint:human-verify` (`gate="blocking-human"`).** All code/config it depends on is complete and compiled (Tasks 1–2). The three validation groups below are genuine runtime gates that CI on `macos-latest` **physically cannot perform** — it is always ≥14.4, cannot grant TCC, cannot soak for the multi-minute Apple zero-buffer bug, and cannot downgrade to 13.x/14.2. No machines matching these requirements are available in the execution environment, so they are documented here for a human/VM verifier (the verifier should route them `human_needed`). **A failure in group 3 is blocking** — it re-introduces the orphan vector Phase 7 depends on being gone.

**Prerequisite:** build + install the signed daemon (`bash yulu/scripts/build_audio_daemon.sh` then install via the dev/launchagent path), so the directly-launched `Yulu.app/Contents/MacOS/audio_daemon` is the running binary under `com.yulu.audiodaemon`.

### Group 1 — macOS 14.4+ tap capture (PLAT-02 / SC-3) [needs a real 14.4+ Mac]

1. **Real R-channel signal:** record a meeting with audible system audio, then confirm the WAV's system (R) channel is not flat zero:
   ```bash
   python3 -c "import wave,audioop; w=wave.open('<recording>.wav'); d=w.readframes(w.getnframes()); print('R-channel max abs:', audioop.max(audioop.tomono(d, w.getsampwidth(), 0, 1), w.getsampwidth()))"
   ```
   Expect a **non-zero** max abs.
2. **First-run prompt + no second-week nag:** the FIRST tap recording must show the **"System Audio Recording Only"** permission prompt (the `NSAudioCaptureUsageDescription` copy). A SECOND recording a week later (or after a reboot) must show **NO** re-permission nag — this is the success-criterion-3 win over ScreenCaptureKit.
3. **Zero-buffer soak (Pitfall 3):** run a single capture for **20+ minutes** across a Bluetooth device sleep/wake (e.g. AirPods) **or** a 44.1↔48 kHz sample-rate change. Confirm the R-channel does not silently go all-zero, **or** that if it does, the teardown+rebuild recovery restores signal (look for the `🔊 Sys tap rebuilt after zero-buffer recovery` log line and returning audio).

### Group 2 — macOS 13.x and/or 14.2 SCK fallback (PLAT-02 / SC-3) [needs a 13.x or 14.2 VM/machine]

1. On a **13.x or 14.2** VM/machine, record a meeting and confirm the `else` (ScreenCaptureKit) arm captures system audio via the `if #available` fallback path (R-channel has signal).
2. Observe the SCK re-permission **nag baseline** — this is the behavior the 14.4 tap arm exists to escape; documenting it is the comparison evidence for SC-3.

### Group 3 — Clean-machine direct-launch TCC + zero-orphan unload (PLAT-03 / SC-2 / A1) [needs a CLEAN Mac, BLOCKING]

1. On a **clean Mac** (no prior Yulu grants): install, grant ScreenCapture + Microphone, start a recording → confirm capture works. This proves the **directly-launched** binary acquired TCC under `com.yulu.audiodaemon` despite the `open`→direct launch change (Pitfall 1 / Assumption A1).
2. Stop the daemon via the DaemonManager / `launchctl unload` path, then:
   ```bash
   pgrep -f audio_daemon
   ```
   This **MUST return empty** — zero lingering processes (the `open -W` orphan is gone). This is the Phase-7 prerequisite (D-05).

**If a check fails:**
- **Group 3 fail:** the D-05 fallback (revert to `open` + a separate clean-stop) is documented in 02-RESEARCH.md:313 — but it re-introduces the orphan, so this is a **blocking finding to resolve before the phase verifies**.
- **Group 1 entitlement fail** (prompt never appears / daemon killed on first tap): revisit Assumption A2 — an extra capture entitlement may be required beyond the mic entitlement.

**Resume signal:** type "approved" with the pass/fail result for each of the three groups, or describe the failures observed (which OS version, which channel, any TCC prompt anomaly).

## Issues Encountered

None. `audio_daemon.swift` typechecks clean with the tap frameworks (`swiftc -typecheck … -framework CoreAudio -framework AudioToolbox` exit 0) and `make swift-build` exits 0 producing all three binaries. The pre-existing `window_scanner.swift:6` unused-`apps` warning is out of scope (not introduced or touched by this plan). Full suite: **613 passed, 1 skipped** (the 1 skip is the pre-existing one from 02-03).

## User Setup Required

None for the code to land. The runtime verification (Pending Human Verification above) requires a 14.4+ Mac, a 13.x/14.2 VM, and a clean Mac — these are validation steps, not setup. macOS system frameworks only; no package-manager install touched this plan (threat T-02-SC: N/A — CoreAudio/AudioToolbox added via `-framework`).

## Next Phase Readiness

- **PLAT-02 code-complete:** the dual-arm capture seam is finished — `ProcessTapBackend` (14.4+) and `ScreenCaptureKitBackend` (13–14.3) both conform to `CaptureBackend` and are selected at runtime; the floor stays 13+.
- **Phase 2 verification has 3 human_needed gates** (the three groups above) — they are the phase's crux runtime evidence and cannot be automated on `macos-latest`.
- **Phase 7 dependency:** the clean-machine zero-orphan check (Group 3) completes the D-05 evidence the 02-03 plist edit set up; the upgrade migration relies on `open -W` being gone.

## Self-Check: PASSED

- Created file verified on disk: `tests/test_audiodaemon_entitlements.py`; `02-04-SUMMARY.md`.
- Modified files present: `audio_daemon.swift`, `Yulu.app/Contents/Info.plist`, `build_audio_daemon.sh`, `Makefile`, `tests/test_audio_daemon_capture_gate.py`.
- Task commits exist in history: `a6f1c3c` (Task 1), `5081870` (Task 2).
- `swiftc -typecheck` with tap frameworks: exit 0. `make swift-build`: exit 0 (all three binaries). Full pytest: 613 passed, 1 skipped.

---
*Phase: 02-platform-abstraction-seams*
*Completed: 2026-05-30*
