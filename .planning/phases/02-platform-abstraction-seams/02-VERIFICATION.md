---
phase: 02-platform-abstraction-seams
verified: 2026-05-30T15:05:00Z
status: human_needed
score: 5/5 must-haves verified (code); 3 runtime groups require human/VM
overrides_applied: 0
human_verification:
  - test: "macOS 14.4+ Core Audio tap captures real system audio (R-channel non-zero), shows the 'System Audio Recording Only' prompt on first run, and shows NO re-permission nag a week/reboot later; survives a 20+ min soak across a Bluetooth sleep/wake or 44.1<->48kHz change (zero-buffer teardown+rebuild recovers signal)."
    expected: "R-channel max abs non-zero; first-run audio prompt appears; second-week run no nag; soak never silently all-zero, or recovers via rebuild."
    why_human: "CI on macos-latest is always >=14.4, cannot grant the TCC scope, and cannot soak for the multi-minute Apple zero-buffer bug. Needs a real 14.4+ Mac. (PLAT-02 / SC-3, 02-04 Task 3 Group 1)"
  - test: "macOS 13.x and/or 14.2 ScreenCaptureKit fallback arm captures system audio via the `if #available` else path, and the SCK re-permission nag baseline is observed (the behavior the tap arm exists to escape)."
    expected: "SCK `else` arm captures R-channel signal on 13.x/14.2; nag baseline documented for SC-3 comparison."
    why_human: "Requires a 13.x or 14.2 VM/machine; the dev box and CI cannot downgrade the OS. (PLAT-02 / SC-3, 02-04 Task 3 Group 2)"
  - test: "CLEAN-MACHINE direct-launch TCC + zero-orphan unload (BLOCKING). On a clean Mac with no prior Yulu grants: install, grant ScreenCapture + Microphone, start a recording -> capture works (directly-launched binary acquired TCC under com.yulu.audiodaemon). Then stop via DaemonManager/`launchctl unload` and run `pgrep -f audio_daemon` -> MUST return empty."
    expected: "Capture works under com.yulu.audiodaemon despite open->direct-launch change (A1); `pgrep -f audio_daemon` empty after unload (the `open -W` orphan vector is gone)."
    why_human: "TCC re-attribution under direct launch vs `open -W` can only be verified on a clean machine; CI cannot grant TCC or prove zero-orphan after unload. BLOCKING: Phase 7 migration depends on the orphan vector being gone. (PLAT-03 / SC-2 / A1, 02-04 Task 3 Group 3)"
---

# Phase 2: Platform Abstraction Seams Verification Report

**Phase Goal:** Every macOS-coupled concern (paths, daemon supervision, permissions, dependencies, audio capture) sits behind a neutral interface with a clean macOS implementation, so daemon stop leaves zero orphans and a future Linux/Windows arm is pure addition.
**Verified:** 2026-05-30T15:05:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| SC-1 | No hardcoded `~/Movies/Yulu` / `~/.config/yulu`; status_agent reads config.json; daemons resolve via PathResolver | ✓ VERIFIED | `MacOSPathResolver` (path_resolver.py:33-95) implements all 3 ABC methods with real env→config.json→default precedence (not stubs); literals centralized to `_DEFAULT_*` constants. `status_agent.swift:100` `loadRecordingDir()` reads `audio.output_dir`, used at :118. `swiftc -typecheck status_agent.swift` exit 0. |
| SC-2 | DaemonManager stop leaves zero lingering processes (`open -W` orphan gone; binary launches directly) | ⚠️ CODE VERIFIED / runtime human_needed (BLOCKING) | plist direct-launch present: `com.yulu.audiodaemon.plist:10` = `MacOS/audio_daemon`; `grep /usr/bin/open` = 0, no `-W`. `MacOSDaemonManager.unload` (daemon_manager.py:74) wraps `launchctl unload` list-form. The CODE is complete. Runtime "zero orphans after unload on a clean machine" + TCC re-attribution (A1) cannot be proven by CI — routed human_needed (Group 3, BLOCKING for Phase 7). |
| SC-3 | macOS 14.4+ Core Audio taps / 13–14.3 SCK behind `if #available` | ⚠️ CODE VERIFIED / runtime human_needed | `ProcessTapBackend` (audio_daemon.swift:696) + `ScreenCaptureKitBackend` (:548) both conform to `CaptureBackend`. AppDelegate selects at :1223 `if #available(macOS 14.4, *)` → tap (:1224), else SCK (:1226). Gate is exactly 14.4 (no 14.2 match). `swiftc -typecheck` with CoreAudio+AudioToolbox exit 0. Runtime tap-capture/no-nag/SCK-fallback need 14.4+/13.x/14.2 machines — human_needed (Groups 1+2). |
| SC-4 | Interfaces carry no leaked macOS vocabulary | ✓ VERIFIED | `test_yulu_platform_no_vocab.py` GREEN (1 passed); signature-scoped (`grep getsource`=0, `grep inspect.signature`=2) — inspects abstractmethod signatures + ServiceSpec fields, not docstrings. Swift `protocol CaptureBackend` block (audio_daemon.swift:521-537): 0 occurrences of SCStreamConfiguration/CATapDescription/SCContentFilter/TCC. base.py frozen & neutral. |
| SC-5 | PermissionModel + DependencyManager with TCC behind Darwin check | ✓ VERIFIED | `MacOSPermissionModel` (permission_model.py:60) + `MacOSDependencyManager` (dependency_manager.py:34), both Darwin-gated (RuntimeError off Darwin). TCC scope strings confined to `_TOKEN_TO_RESET_SERVICE` map + `reset()` body (:104); brew confined to `_BREW`. doctor.py:61 routes `MacOSDependencyManager().is_available`; repair_permissions.py:74 routes `MacOSPermissionModel().reset("system-audio-capture")`. |

**Score:** 5/5 must-haves verified at the CODE level. SC-2 and SC-3 carry runtime groups that legitimately require human/VM machines (code is complete — these are NOT gaps).

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu_platform/macos/path_resolver.py` | MacOSPathResolver (env/config/default) | ✓ VERIFIED | 95 lines; subclasses PathResolver; 3 methods real impl; Darwin-gated |
| `yulu_platform/macos/daemon_manager.py` | MacOSDaemonManager (launchctl wrapper) | ✓ VERIFIED | 101 lines; subclasses DaemonManager; plistlib install, neutral status strings; launchd vocab confined to `install()` |
| `yulu_platform/macos/permission_model.py` | MacOSPermissionModel (socket+tccutil, Darwin-gated) | ✓ VERIFIED | 126 lines; subclasses PermissionModel; socket probe; scope map internal |
| `yulu_platform/macos/dependency_manager.py` | MacOSDependencyManager (brew wrapper, Darwin-gated) | ✓ VERIFIED | 75 lines; subclasses DependencyManager; never auto-installs brew |
| `yulu_platform/macos/__init__.py` | Exports all 4 seams | ✓ VERIFIED | 15 lines; imports + `__all__` for all 4 MacOS* classes |
| `audio_daemon.swift` | CaptureBackend + SCK + tap arms | ✓ VERIFIED | protocol :521; ScreenCaptureKitBackend :548; ProcessTapBackend :696; typechecks |
| `com.yulu.audiodaemon.plist` | direct-launch ProgramArguments | ✓ VERIFIED | :10 `MacOS/audio_daemon`; no `open`/`-W` |
| `status_agent.swift` | config.json output_dir reader | ✓ VERIFIED | `loadRecordingDir()` :100, used :118 |
| `Yulu.app/Contents/Info.plist` | NSAudioCaptureUsageDescription | ✓ VERIFIED | present (count 1) |
| `Yulu.app.entitlements` | mic entitlement retained, comment-free | ✓ VERIFIED | `audio-input` count 1; `<!--` count 0 |
| `build_audio_daemon.sh` | NSAudioCapture line + AudioToolbox | ✓ VERIFIED | NSAudioCapture count 2; AudioToolbox count 1 |
| 6 test files | gate/conformance/neutrality | ✓ VERIFIED | all 6 present; 61 phase tests pass |

### Key Link Verification

| From | To | Via | Status |
|------|-----|-----|--------|
| macos/daemon_manager.py | base.DaemonManager | `class MacOSDaemonManager(DaemonManager)` | ✓ WIRED |
| macos/path_resolver.py | base.PathResolver | `class MacOSPathResolver(PathResolver)` | ✓ WIRED |
| macos/permission_model.py | base.PermissionModel | `class MacOSPermissionModel(PermissionModel)` | ✓ WIRED |
| doctor.py | MacOSDependencyManager | `is_available()` routed (guarded import, :61/:75) | ✓ WIRED |
| repair_permissions.py | MacOSPermissionModel | `.reset("system-audio-capture")` (:74) | ✓ WIRED — inline `tccutil reset ScreenCapture` literal absent |
| audio_daemon.swift AppDelegate | CaptureBackend | `var audioCapture: CaptureBackend?` (:1188) | ✓ WIRED |
| AppDelegate | ProcessTapBackend/SCK | `if #available(macOS 14.4)` selects (:1223-1226) | ✓ WIRED |
| ProcessTapBackend IO callback | recorder.onSysAudio | Float32→Int16 reused clamp → shared sink (:951) | ✓ WIRED (same sink as SCK :494) |

### Data-Flow Trace (Level 4 — tap arm)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| ProcessTapBackend | int16s → recorder.onSysAudio | CATapDescription→AudioHardwareCreateProcessTap→aggregate→AudioDeviceCreateIOProcIDWithBlock→AudioDeviceStart IO callback | Real Core Audio frames (zero-buffer = bug, drops+rebuilds, never fake-fills) | ✓ FLOWING (code); live signal proof is Group 1 human gate |
| ScreenCaptureKitBackend | int16s → recorder.onSysAudio | SCStream sample buffers (existing battle-tested path, refactored not rewritten) | Real SCK frames | ✓ FLOWING |

Note: the SysAudioOutput Int16 clamp appears 6× (shared by both arms + conversion helpers) — the tap reuses the verified conversion verbatim rather than re-deriving it. Zero-buffer recovery (audio_daemon.swift:929 `allSatisfy { $0 == 0.0 }`, single-flight `rebuilding` flag :718, off-thread rebuild :968) is substantive, not a log-only stub.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| D-09 neutrality gate (SC-4) | `pytest tests/test_yulu_platform_no_vocab.py` | 1 passed | ✓ PASS |
| All phase-2 gate tests | `pytest` (5 phase test files) | 61 passed | ✓ PASS |
| Full suite (regression) | `python3 -m pytest -q` | 613 passed, 1 skipped (121s) | ✓ PASS — matches SUMMARY claim exactly |
| audio_daemon typecheck (tap frameworks) | `swiftc -typecheck … -framework CoreAudio -framework AudioToolbox` | exit 0 | ✓ PASS |
| status_agent typecheck | `swiftc -typecheck status_agent.swift -framework Cocoa -framework Carbon` | exit 0 (1 pre-existing NSUserNotificationCenter deprecation warning) | ✓ PASS |

The 1 skipped test is `test_e2e_stt_daemon.py:38` (missing audio fixture `tiny_10s.wav`) — a pre-existing STT e2e skip unrelated to Phase 2, NOT a masked phase gap.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| PLAT-01 | 02-03 | CaptureBackend interface + macOS impl; Linux/Windows NotImplementedError stubs | ✓ SATISFIED | `protocol CaptureBackend` + `ScreenCaptureKitBackend`; Python linux/windows arms remain stubs (Phase 1) |
| PLAT-02 | 02-04 | Core Audio taps on 14.4+, SCK fallback behind same seam | ✓ SATISFIED (code) | `ProcessTapBackend` gated 14.4, SCK else; runtime = Groups 1+2 human gates |
| PLAT-03 | 02-01, 02-03 | DaemonManager (ServiceSpec+install/load/unload/status) wraps launchd; direct-launch no orphan | ✓ SATISFIED (code) | `MacOSDaemonManager` + plist direct-launch; runtime zero-orphan = Group 3 human gate |
| PLAT-04 | 02-01, 02-03 | PathResolver removes hardcoded paths incl. status_agent config.json | ✓ SATISFIED | `MacOSPathResolver` + `status_agent.loadRecordingDir()` |
| PLAT-05 | 02-02 | PermissionModel + DependencyManager macOS impls; TCC Darwin-gated | ✓ SATISFIED | both seams Darwin-gated; read-sites routed |

No orphaned requirements — all 5 PLAT IDs declared across plans 01-04 and map to Phase 2 in REQUIREMENTS.md (all marked Complete).

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| (none) | — | No TBD/FIXME/XXX in any phase-modified file | — | Clean |
| status_agent.swift | 866 | NSUserNotificationCenter deprecation warning | ℹ️ Info | Pre-existing, not introduced by this phase; out of scope |
| repair_permissions.py | 36 | `f"tccutil reset ScreenCapture {bundle_id}"` | ℹ️ Info | NOT a stub/anti-pattern — this is the human-readable dry-run **plan display** string in `plan()`; the real reset routes through `MacOSPermissionModel().reset()` (:74). Verified not a subprocess call. |

### Human Verification Required

Three runtime validation groups (02-04 Task 3, a `checkpoint:human-verify` `gate="blocking-human"`) cannot be performed by CI on macos-latest. The CODE they depend on is complete and compiled. See frontmatter `human_verification` for full repro steps.

1. **macOS 14.4+ tap capture + no-nag + soak** (PLAT-02/SC-3, Group 1) — needs a real 14.4+ Mac.
2. **macOS 13.x/14.2 SCK fallback** (PLAT-02/SC-3, Group 2) — needs a 13.x or 14.2 VM.
3. **Clean-machine direct-launch TCC + zero-orphan unload (BLOCKING)** (PLAT-03/SC-2/A1, Group 3) — needs a clean Mac. `pgrep -f audio_daemon` MUST be empty after unload. **This is the Phase-7 prerequisite** — the migration depends on the `open -W` orphan vector being gone; a failure here is a blocking finding (D-05 fallback re-introduces the orphan).

### Gaps Summary

**No code gaps found.** All 5 ROADMAP success criteria are satisfied at the code/test level, independently verified against the actual codebase (not SUMMARY claims):
- SC-1, SC-4, SC-5 are fully automatable and GREEN: 613 passed/1 skipped, D-09 neutrality test passing & correctly signature-scoped, both Swift files typecheck, all seams subclass their frozen ABCs with real (non-stub) implementations, read-side callers routed through the seams, install pipeline (dev_install/setup.sh) left intact per the coexist decision.
- SC-2 and SC-3 are code-complete (plist direct-launch + dual-arm `if #available(macOS 14.4)` both verified in source and typechecking) but carry runtime behaviors — TCC grant/re-attribution, OS downgrade, multi-minute zero-buffer soak — that CI on macos-latest physically cannot exercise. These are routed `human_needed`, **not** `gaps_found`.

Status is `human_needed` (not `passed`) because the human verification section is non-empty and Group 3 is a BLOCKING gate that Phase 7 depends on. Per the decision tree, human items take priority over a 5/5 code score.

---

*Verified: 2026-05-30T15:05:00Z*
*Verifier: Claude (gsd-verifier)*
