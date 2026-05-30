# Phase 2: Platform-Abstraction Seams - Research

**Researched:** 2026-05-30
**Domain:** macOS audio capture (Core Audio process taps vs ScreenCaptureKit), launchd daemon supervision, TCC permissions, Python platform-seam implementations
**Confidence:** HIGH (repo grounding) / MEDIUM (Core Audio tap runtime behavior — needs VM validation per D-03)

## Summary

Phase 2 fills the macOS arm of a platform-abstraction layer whose **interfaces were already frozen in Phase 1** (`yulu_platform/base.py`: PathResolver, DaemonManager+ServiceSpec, PermissionModel, DependencyManager — all grep-clean of macOS vocabulary). The work splits cleanly into two independent tracks that share no code:

1. **Swift `CaptureBackend`** (PLAT-01/02) — a dual-arm system-audio capture seam: the existing ScreenCaptureKit (`SCStream`) path becomes the 13–14.3 arm, and a **new Core Audio process-tap arm** becomes the 14.4+ path, selected via `if #available`. The tap arm is the genuinely hard, under-documented part and the only place that requires clean-VM validation. The `record_audio.py ↔ daemon` boundary (a thin Unix-socket JSON protocol) is **already thin and does not change** — the CaptureBackend abstraction lives entirely Swift-side, inside `audio_daemon.swift`.

2. **Python seams** (PLAT-03/04/05) — `yulu_platform/macos/` implementations that wrap `launchctl` (DaemonManager), resolve paths (PathResolver), gate `tccutil` behind Darwin checks (PermissionModel), and wrap brew (DependencyManager). Plus two concrete fixes: the `open -W` orphan in `com.yulu.audiodaemon.plist` (D-05, load-bearing for Phase 7) and the hardcoded `~/Movies/Yulu` in `status_agent.swift` (D-07).

**Primary recommendation:** Build the tap arm by porting the canonical `insidegui/AudioCap` sample (the only authoritative, maintained reference). Keep the SCK arm verbatim behind the protocol. For the daemon-orphan fix, the heavy lifting is already done — `Yulu.app/Contents/Info.plist` already sets `LSUIElement=true` and the daemon already calls `app.setActivationPolicy(.accessory)`, so changing the plist from `open -W Yulu.app` to a direct binary launch will NOT regain a Dock icon. The one thing that MUST be validated on a clean machine: that the direct-launched binary still acquires ScreenCapture + Microphone TCC under bundle id `com.yulu.audiodaemon`.

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01 [constraint, → PROJECT.md]:** macOS floor STAYS at **13+**. System audio capture is **dual-arm behind one seam**: Core Audio process taps on **14.4+**, ScreenCaptureKit on **13–14.3**, selected via `if #available`. Do NOT raise the floor to 14.4. The taps arm removes the weekly re-permission nag on 14.4+ (success criterion 3); the SCK arm preserves compatibility.
- **D-02:** `CaptureBackend` = a **Swift protocol** ("PCM frames + source list"): emits PCM frames + exposes a capturable-source list, hiding `SCStreamConfiguration`/tap vocabulary. macOS impl is dual-arm. The Python side meets it only at `record_audio.py ↔ CaptureBackend`; keep that boundary thin (start/stop/status + frame sink).
- **D-03:** The two arms live behind `if #available(macOS 14.4, *)`; the 13–14.3 SCK arm is the existing capture code refactored behind the protocol (not rewritten). Tap arm is the new path — **research must validate the version gate + fallback on 14.2 and 13.x** (dev machine never reproduces the SCK nag; VM/dual-machine validation required before trusting the gate).
- **D-04:** `DaemonManager` macOS impl wraps `launchctl` and implements the Phase 1 `yulu_platform.base.DaemonManager` ABC (`ServiceSpec` + install/load/unload/status). No launchd vocabulary leaks into the interface.
- **D-05 [load-bearing for Phase 7]:** Fix the `open -W` orphan (CONCERNS §8b): the audiodaemon plist launches `Yulu.app/Contents/MacOS/audio_daemon` **directly** (set `LSUIElement=true` in Info.plist to suppress the Dock icon) so `launchctl unload` kills the process cleanly — **zero lingering processes** (success criterion 2). Removes the `pkill -9` truncation vector at its root. Verify the direct-launch binary still acquires ScreenCapture/Microphone TCC under its bundle identity.
- **D-06:** `PathResolver` macOS impl removes hardcoded `~/Movies/Yulu` and `~/.config/yulu`; all daemons resolve locations through it. Honor existing `YULU_CONFIG_DIR`/`YULU_OUTPUT_DIR` env (already half-wired via plist `EnvironmentVariables`).
- **D-07:** Fix `status_agent.swift` to read `audio.output_dir` from `config.json` instead of hardcoded `~/Movies/Yulu` (CONCERNS §6d/§1e) — the menu-bar "Recent Recordings" list must follow the configured dir.
- **D-08:** `PermissionModel` + `DependencyManager` macOS impls; all TCC calls (`tccutil`) and Homebrew calls gated behind a Darwin check (`platform.system() == "Darwin"` / `#if os(macOS)`). The interface reports platform-appropriate status without TCC scopes in the signature.
- **D-09:** No leaked macOS vocabulary in any seam signature (no plist keys, `SCStreamConfiguration`, TCC scope names). Phase 1's `base.py` already honors this; Phase 2 keeps macOS specifics inside `yulu_platform/macos/` and the Swift impl. A reviewer must be able to confirm a systemd arm could implement the same methods.

### Claude's Discretion
Per Lewis's milestone-wide autonomous mandate, ALL decisions above (D-01..D-09) were made by Claude from ROADMAP success criteria + REQUIREMENTS PLAT-01..05 + CONCERNS fix approaches + the Phase 1 `yulu_platform` ABC contract. The researcher/planner may refine method signatures and the exact macos/ package layout; the decisions fix intent, boundaries, and the floor constraint.

### Deferred Ideas (OUT OF SCOPE)
None new. Linux/Windows runtime impls remain v2 (XPLAT-01/02). The Swift CaptureBackend's non-macOS arms stay stubs this milestone (Swift binaries are macOS-only by design — there is no cross-platform Swift CaptureBackend; the cross-platform seam is the Python↔Swift boundary).
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| PLAT-01 | A `CaptureBackend` interface ("PCM frames + source list") exists with a macOS implementation; Linux/Windows are `NotImplementedError` stubs | Swift protocol shape in Architecture Patterns › Pattern 1; existing `AudioCapture`/`SysAudioOutput` classes (audio_daemon.swift:446-585) are the SCK arm to wrap. NOTE: Linux/Windows Swift stubs are N/A — Swift is macOS-only (see Open Q #1) |
| PLAT-02 | macOS system-audio capture uses Core Audio process taps on 14.4+, with a ScreenCaptureKit fallback arm behind the same seam (`if #available`) | Full tap API sequence in Code Examples; version-gate analysis (14.2 symbol / 14.4 practical) in State of the Art; SCK arm = existing code (audio_daemon.swift:498-585) |
| PLAT-03 | A `DaemonManager` interface (`ServiceSpec` + install/load/unload/status) wraps launchd; the audio daemon launches directly (no `open -W` orphan) so `stop()` leaves zero processes | DaemonManager impl maps to existing `dev_install.py` launchctl calls (_unload/_load/_install_launchagents); D-05 plist fix in Pattern 3 + Pitfall 1; Info.plist already has LSUIElement |
| PLAT-04 | A `PathResolver` removes hardcoded `~/Movies/Yulu` / `~/.config/yulu` (including fixing `status_agent.swift` to read `config.json`) | `audio_daemon.swift:loadRecordingDir()` (45-58) is the EXACT reuse pattern for the status_agent fix; PathResolver impl in Pattern 4; env-var precedence (YULU_CONFIG_DIR/YULU_OUTPUT_DIR) |
| PLAT-05 | `PermissionModel` and `DependencyManager` interfaces exist with macOS implementations; TCC calls are gated behind a Darwin check | `repair_permissions.py` (tccutil) + `doctor.py` (_check_command) are the callers to route; Darwin-gate pattern in Pattern 5 |
</phase_requirements>

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| System-audio PCM capture | Swift daemon (native) | — | ScreenCaptureKit / Core Audio taps are macOS C/Swift APIs; no Python equivalent. Lives in `audio_daemon.swift` |
| Mic PCM capture | Swift daemon (native) | — | AVAudioEngine; already in `MicCapture` (audio_daemon.swift:404-442). NOT part of CaptureBackend's system-audio arm but shares the recorder |
| Capture source list ("which apps/devices") | Swift daemon (native) | — | `SCShareableContent` (SCK) / `kAudioHardwarePropertyProcessObjectList` (taps). Exposed via CaptureBackend protocol |
| Start/stop/status orchestration | Python (`record_audio.py`) | Swift socket server | Python is the controller; Swift `SocketServer` (audio_daemon.swift:589-775) executes. Boundary = Unix socket JSON, already thin |
| Daemon lifecycle (install/load/unload/status) | Python (`yulu_platform/macos`) | launchctl subprocess | DaemonManager wraps `launchctl`; callers today are `dev_install.py`, `setup.sh`, `repair_permissions.py` |
| Path resolution | Python (`yulu_platform/macos`) + Swift (`loadRecordingDir`) | config.json | Two consumers: Python daemons + Swift status_agent. config.json `audio.output_dir` is the source of truth |
| Permission state (mic / screen-or-audio capture) | Python (`yulu_platform/macos`) | tccutil + socket probe | PermissionModel reports status; cannot *grant* (macOS requires user). Reads daemon's `sysReady`/`micReady` via socket |
| Dependency presence/install (brew) | Python (`yulu_platform/macos`) | brew subprocess | DependencyManager wraps Homebrew; Darwin-gated |

## Standard Stack

### Core
| Library / API | Version | Purpose | Why Standard |
|---------------|---------|---------|--------------|
| ScreenCaptureKit (`SCStream`) | macOS 12.3+ | System-audio capture, 13–14.3 arm | Already in use (audio_daemon.swift); Apple's pre-tap system-audio path |
| Core Audio process taps (`AudioHardwareCreateProcessTap`, `CATapDescription`) | symbol macOS 14.2+, **target 14.4+** | System-audio capture, 14.4+ arm; removes screen-recording indicator + recurring nag | Apple's modern replacement; "System Audio Recording Only" TCC scope |
| AVFoundation (`AVAudioEngine`) | macOS 10.10+ | Microphone capture | Already in use (audio_daemon.swift:404); unchanged this phase |
| CoreAudio / AudioToolbox (`AudioHardwareCreateAggregateDevice`, `AudioDeviceCreateIOProcIDWithBlock`) | macOS 14.2+ | Aggregate device + IO callback to receive tap PCM | Required companion to the tap API |
| launchd / `launchctl` | macOS (all) | Daemon supervision | Existing; wrapped by DaemonManager |
| Python stdlib (`subprocess`, `platform`, `pathlib`, `json`, `abc`) | 3.8+ | All `yulu_platform/macos/` impls | CLAUDE.md stdlib-first mandate; Phase 1 precedent |

### Supporting
| Library / API | Version | Purpose | When to Use |
|---------------|---------|---------|-------------|
| `kAudioHardwarePropertyTranslatePIDToProcessObject` | 14.2+ | Map PID → AudioObjectID for per-process taps | Only if scoping the tap to specific apps; the global-tap path (initStereoGlobalTapButExcludeProcesses with empty array) captures everything and is what Yulu wants |
| `tccutil` | macOS | Reset stale TCC grants | PermissionModel reset path (already in repair_permissions.py:114) |
| `plutil -lint` | macOS | Validate plist before load | Already used in dev_install.py:197 (`_load`) |

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Core Audio taps (14.4+ arm) | Keep SCK everywhere | SCK triggers the purple screen-recording indicator AND (per CONCERNS) the weekly re-permission nag. Taps use "System Audio Recording Only" — no recurring nag, no app restart. This IS success criterion 3. |
| Global tap (empty exclude list) | Per-process taps via PID translation | Per-process needs `kAudioHardwarePropertyProcessObjectList` enumeration + PID mapping; unnecessary complexity for "record the meeting" (whole-system) use case |
| Private TCC API for permission status (AudioCap's approach) | First-record-triggers-prompt (no pre-check) | Private API risks App Store / notarization review and breaks across OS versions. There is NO public API to query tap authorization status (`[CITED: maven.de]`). Recommend the build-flag-disabled path: let the first capture trigger the prompt. |

**Installation:** No new packages. All APIs are macOS system frameworks already linked or addable via `-framework CoreAudio -framework AudioToolbox` in `build_audio_daemon.sh` (which already links `-framework CoreAudio`).

**Version verification:** Core Audio tap symbols are confirmed `macOS 14.2+` (gist + AudioTee + makeusabrew/audiotee all build against 14.2). The canonical `insidegui/AudioCap` sample targets **14.4+** because early 14.2 builds had instability. D-01's 14.4 gate is the safe choice — see State of the Art for the full version analysis.

## Package Legitimacy Audit

> **N/A — no external packages installed this phase.** All capture APIs are macOS system frameworks (ScreenCaptureKit, CoreAudio, AudioToolbox, AVFoundation); all Python is stdlib (CLAUDE.md mandate, confirmed by Phase 1 `base.py` importing only `abc`/`dataclasses`/`pathlib`). slopcheck/registry verification does not apply — there is nothing to install.

The only "reference code" introduced is hand-ported from the `insidegui/AudioCap` sample (MIT, github.com/insidegui/AudioCap) — copied as a pattern, not as a dependency. No package manager touches this phase.

## Architecture Patterns

### System Architecture Diagram

```
                          record_audio.py  (controller, Python)
                                  │
                                  │  socket_send({"action": "start"/"stop"/"status"})
                                  │  Unix socket: ~/.config/yulu/audio_daemon.sock
                                  │  JSON request → JSON response, SHUT_WR framing
                                  ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  audio_daemon (Swift, Yulu.app/Contents/MacOS/audio_daemon)   │
        │                                                               │
        │  SocketServer ──► AudioRecorder ──► WavWriter (L=mic, R=sys)   │
        │       │                  ▲                                    │
        │       │ onRecordingStart │ onSysAudio([Int16]) / onMicAudio   │
        │       ▼                  │                                    │
        │  ┌─────────────────────────────────────────────────┐         │
        │  │  CaptureBackend  (NEW protocol — D-02)           │         │
        │  │  start() / stop() / status() / sources()         │         │
        │  │  frame sink: (samples) -> recorder.onSysAudio    │         │
        │  └───────────────┬───────────────────┬─────────────┘         │
        │      if #available│(macOS 14.4, *)    │ else                  │
        │                   ▼                   ▼                       │
        │  ┌────────────────────────┐  ┌─────────────────────────────┐ │
        │  │ ProcessTapBackend      │  │ ScreenCaptureKitBackend     │ │
        │  │ (NEW, 14.4+ arm)       │  │ (EXISTING code, 13–14.3 arm)│ │
        │  │ CATapDescription       │  │ SCStream + SCStreamConfig   │ │
        │  │ AudioHardwareCreate-   │  │ SCContentFilter             │ │
        │  │   ProcessTap           │  │ SysAudioOutput (planar f32) │ │
        │  │ AggregateDevice + IO   │  │                             │ │
        │  │ callback → PCM         │  │                             │ │
        │  │ TCC: "System Audio     │  │ TCC: "Screen & System Audio │ │
        │  │   Recording Only"      │  │   Recording" (the nag)      │ │
        │  └────────────────────────┘  └─────────────────────────────┘ │
        └──────────────────────────────────────────────────────────────┘

  Python platform seams (yulu_platform/macos/) — INDEPENDENT track:
  ┌─────────────────────────────────────────────────────────────────┐
  │ MacOSDaemonManager  → launchctl load/unload/list  (D-04)         │
  │ MacOSPathResolver   → config.json + env + ~ defaults  (D-06)     │
  │ MacOSPermissionModel→ socket probe (sysReady/micReady) + tccutil │
  │ MacOSDependencyMgr  → brew list / brew install  (D-08)           │
  └─────────────────────────────────────────────────────────────────┘
       ▲ consumed by: doctor.py, dev_install.py, repair_permissions.py
```

### Recommended Project Structure
```
yulu/scripts/
├── audio_daemon.swift          # MODIFY: extract CaptureBackend protocol;
│                               #   wrap existing SCStream code as SCK arm;
│                               #   add ProcessTapBackend arm (14.4+)
├── status_agent.swift          # MODIFY: loadRecentRecordings() reads config.json
│                               #   (port loadRecordingDir() from audio_daemon.swift)
├── com.yulu.audiodaemon.plist  # MODIFY: open -W → direct binary launch (D-05)
├── Yulu.app.entitlements       # MODIFY: add NSAudioCaptureUsageDescription? (see Pitfall 4)
├── Yulu.app/Contents/Info.plist # MODIFY: add NSAudioCaptureUsageDescription (tap prompt copy)
└── yulu_platform/
    ├── base.py                 # FROZEN (Phase 1) — do not touch
    └── macos/
        ├── __init__.py         # currently empty stub — fill with exports
        ├── daemon_manager.py   # NEW: MacOSDaemonManager (launchctl)
        ├── path_resolver.py    # NEW: MacOSPathResolver
        ├── permission_model.py # NEW: MacOSPermissionModel (tccutil + socket probe)
        └── dependency_manager.py # NEW: MacOSDependencyManager (brew)
```

### Pattern 1: Swift `CaptureBackend` protocol (D-02)
**What:** A protocol that hides both `SCStreamConfiguration`/SCK vocab and Core Audio tap vocab behind "emit PCM frames + list sources." Both arms implement it; the daemon picks one at startup via `if #available`.
**When to use:** This is the single seam PLAT-01/02 requires. Keep it minimal — the existing daemon already has the right lifecycle hooks (`onRecordingStart`/`onRecordingStop` in SocketServer, `onSysAudio` frame sink in AudioRecorder).

```swift
// Source: derived from existing audio_daemon.swift lifecycle (lines 498-585, 816-823)
// + insidegui/AudioCap tap structure. Protocol shape is new; both arms exist/derived.
protocol CaptureBackend: AnyObject {
    /// True once the backend has verified its capture permission (TCC handshake done).
    var isReady: Bool { get }
    var lastError: String { get }

    /// Probe permission without leaving the recording indicator on (idle daemon).
    func probePermission()

    /// Begin emitting system-audio PCM to the sink. Blocks until actually capturing.
    func startCapture()
    /// Stop; blocks until the OS-level capture indicator clears.
    func stopCapture()

    /// Capturable sources (windows/apps/displays). SCK: SCShareableContent;
    /// taps: process-object list. Neutral [CaptureSource] hides both.
    func sources() -> [CaptureSource]
}

struct CaptureSource { let id: String; let name: String; let kind: String } // "display"|"app"|"system"

// The frame sink stays exactly as today: recorder.onSysAudio([Int16] interleaved stereo).
// Each arm converts its native buffer (SCK planar Float32 / tap Float32) to interleaved Int16.
```

**Anti-pattern to avoid:** Do NOT put a `SCStreamConfiguration` or `CATapDescription` in the protocol signature (D-09 violation). The arms own those internally. The protocol speaks only `[Int16]` frames + `[CaptureSource]`.

### Pattern 2: ScreenCaptureKit arm = existing code, refactored in place
**What:** The current `AudioCapture` (audio_daemon.swift:498-585) and `SysAudioOutput` (446-494) classes ARE the 13–14.3 arm. Wrap them to conform to `CaptureBackend`; do not rewrite (D-03).
**When to use:** Always present (floor is 13). Selected when `!#available(macOS 14.4, *)`.

```swift
// EXISTING — already does the right thing (audio_daemon.swift:541-569 startCapture).
// The only change: make `AudioCapture` conform to CaptureBackend and rename to
// ScreenCaptureKitBackend. Its planar-Float32 → interleaved conversion (473-489)
// stays verbatim — it's correct and battle-tested.
@available(macOS 12.3, *)
final class ScreenCaptureKitBackend: NSObject, CaptureBackend, SCStreamOutput { /* existing body */ }
```

### Pattern 3: Core Audio process-tap arm (14.4+) — the new path
**What:** A new `ProcessTapBackend` that captures all system audio via a global tap → aggregate device → IO callback. See Code Examples for the full sequence.
**When to use:** Selected when `#available(macOS 14.4, *)`. Removes the screen-recording indicator + recurring nag.
**Critical reliability requirement (VERIFIED bug):** the tap can silently start delivering all-zero buffers after extended uptime or sample-rate/Bluetooth-device changes. The only fix is a full teardown+rebuild. Build this in from day one (see Pitfall 3).

### Pattern 4: Daemon direct-launch (D-05) — the orphan fix
**What:** Change `com.yulu.audiodaemon.plist` `ProgramArguments` from `["/usr/bin/open", "-W", "…/Yulu.app"]` to the binary path directly.

```xml
<!-- BEFORE (audio_daemon.plist:8-13) — launchd manages `open`, not the app child -->
<key>ProgramArguments</key>
<array>
    <string>/usr/bin/open</string>
    <string>-W</string>
    <string>__SCRIPT_DIR__/Yulu.app</string>
</array>

<!-- AFTER — launchd manages the daemon directly; `launchctl unload` kills it cleanly -->
<key>ProgramArguments</key>
<array>
    <string>__SCRIPT_DIR__/Yulu.app/Contents/MacOS/audio_daemon</string>
</array>
```

**Why this is safe (already-verified prerequisites):**
- `Yulu.app/Contents/Info.plist` ALREADY has `<key>LSUIElement</key><true/>` — no Dock icon.
- `audio_daemon.swift:842` ALREADY calls `app.setActivationPolicy(.accessory)` — belt-and-braces no-Dock.
- So direct launch does NOT regain a Dock icon. D-05's "set LSUIElement=true" is already done; the plist change is the only edit.

**What MUST be validated (clean machine):** TCC grants key on bundle identity + code signature, and the "responsible process" can differ between `open`-launched and launchd-launched binaries. Confirm the directly-launched binary still prompts for / retains ScreenCapture + Microphone under `com.yulu.audiodaemon`. (See Validation Architecture.)

### Pattern 5: Python macOS seams — stdlib + subprocess, Darwin-gated
**What:** Each `yulu_platform/macos/*.py` subclasses the frozen ABC and shells to the macOS tool. Pattern mirrors `dev_install.py`/`repair_permissions.py`/`doctor.py` `_run()` helpers.

```python
# Source: pattern from dev_install.py:_unload/_load (191-198) + doctor.py:_run (26-31)
import platform, subprocess
from pathlib import Path
from yulu_platform.base import DaemonManager, ServiceSpec

class MacOSDaemonManager(DaemonManager):
    def __init__(self) -> None:
        if platform.system() != "Darwin":          # D-08 Darwin gate
            raise RuntimeError("MacOSDaemonManager requires macOS")
        self._agents = Path.home() / "Library/LaunchAgents"

    def install(self, spec: ServiceSpec) -> None:
        # Render spec → plist dict (the launchd-specific translation lives HERE, not in the ABC).
        # ... write <Label>spec.name</Label>, <ProgramArguments>spec.program</ProgramArguments>,
        #     <KeepAlive>spec.keep_alive</KeepAlive>, <WorkingDirectory>, <EnvironmentVariables> ...
        ...
    def load(self, name: str) -> None:
        subprocess.run(["launchctl", "load", str(self._agents / f"{name}.plist")], check=False)
    def unload(self, name: str) -> None:
        subprocess.run(["launchctl", "unload", str(self._agents / f"{name}.plist")], check=False)
    def status(self, name: str) -> str:
        r = subprocess.run(["launchctl", "list"], capture_output=True, text=True)
        return "running" if any(name in ln for ln in r.stdout.splitlines()) else "stopped"
        # NOTE: return platform-neutral strings ("running"/"stopped"/"unknown"), never launchctl codes (D-09)
```

**Anti-Patterns to Avoid**
- **Leaking macOS vocabulary into the ABC** (D-09): `ServiceSpec` has NO `Label`/`KeepAlive`/`RunAtLoad` keys — it has `name`/`program`/`keep_alive`. The launchd plist key names appear ONLY inside `MacOSDaemonManager.install`. Verified: `base.py` is already grep-clean.
- **Rewriting the SCK arm** (D-03): the existing planar-Float32 handling (audio_daemon.swift:473-489) is subtle and correct. Wrap, don't rewrite.
- **Putting tap/SCK selection in Python**: the `if #available` gate is Swift-side. Python's CaptureBackend boundary is unchanged — `record_audio.py` keeps sending `{"action":"start"}`.
- **Querying tap authorization via private TCC API**: no public status API exists; private API breaks notarization. Let first capture trigger the prompt.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| System-audio capture on 14.4+ | A custom CoreAudio HAL plugin or virtual device | `AudioHardwareCreateProcessTap` + aggregate device (port AudioCap) | The tap API is Apple's sanctioned path; HAL plugins need a kext-adjacent installer and are exactly what Yulu's "no virtual audio device" value rejects |
| Tap PCM format conversion | Manual deinterleave guesswork | Read the tap's ASBD (`kAudioTapPropertyFormat`) and the existing `SysAudioOutput` conversion (473-491) | The SCK arm already solved planar-f32→int16; reuse the same `Int16(max(-1,min(1,x))*Int16.max)` clamp |
| Daemon orphan cleanup | More `pkill -9` patterns | Direct launchd launch (D-05) | `pkill -9` truncates active WAVs (CONCERNS §2d); direct launch lets `launchctl unload` SIGTERM cleanly |
| Plist generation in Python | f-string XML | stdlib `plistlib.dump()` | stdlib handles escaping/types; the repo already uses `plutil -lint` to validate |
| "Is the daemon running" | Parsing `ps aux` | `launchctl list` grep (doctor.py:221 pattern) + socket `{"action":"status"}` | launchctl is the source of truth; socket confirms liveness |
| Reading output_dir in Swift | Re-deriving `~/Movies/Yulu` | Port `loadRecordingDir()` (audio_daemon.swift:45-58) into status_agent | An identical, correct config.json reader ALREADY exists in the sibling Swift file |

**Key insight:** Almost every "new" piece already has a correct in-repo analog. The tap arm is the ONLY genuinely new code; everything else (SCK arm, config reading, launchctl wrapping, frame conversion) is extract-and-reuse.

## Runtime State Inventory

> Phase 2 is primarily a refactor (extract seams) + two surgical fixes (plist, status_agent path). It touches daemon supervision and TCC, so runtime state matters.

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | **None that the rename touches.** No string-rename in this phase; `audio.output_dir` value in config.json is read, not migrated. The `~/.config/yulu/.state.json`, `.audio_daemon.pid`, sockets are all regenerated at daemon start. | None |
| Live service config | **8 launchd plists installed in `~/Library/LaunchAgents/`** (com.yulu.*). Only `com.yulu.audiodaemon.plist` changes (ProgramArguments). After editing the source template, the INSTALLED copy must be re-rendered + reloaded (`dev_install.py:_install_launchagents` does unload→render→load). A user who upgrades keeps the OLD `open -W` plist until re-install. | Re-install plist on upgrade (Phase 7 migration consumes this); document that `launchctl unload` of the OLD plist still needs the pkill fallback until the NEW plist is loaded |
| OS-registered state | **TCC grants keyed on bundle id `com.yulu.audiodaemon`** for ScreenCapture + Microphone. Changing the plist launch method (open→direct) may change the "responsible process" macOS attributes the capture to. The 14.4+ tap arm introduces a NEW TCC scope ("System Audio Recording Only") — a DIFFERENT grant than the SCK "Screen & System Audio Recording" the user already approved. | **MUST validate on clean machine** (D-05 + D-03): (1) direct-launched binary still acquires existing grants; (2) tap arm's first run prompts for the new audio-only scope. A user upgrading on 14.4+ will see a NEW permission prompt the first time the tap arm runs |
| Secrets/env vars | `YULU_CONFIG_DIR` / `YULU_OUTPUT_DIR` referenced in plist `EnvironmentVariables` (half-wired per D-06). PathResolver formalizes reading them. No secrets. | PathResolver honors these env vars with documented precedence (env → config.json → platform default) |
| Build artifacts | `Yulu.app/Contents/MacOS/audio_daemon` (compiled binary) — re-signing after adding NSAudioCaptureUsageDescription / new frameworks invalidates the prior signature → TCC may re-prompt. `build_audio_daemon.sh` re-links frameworks; adding `-framework AudioToolbox` (if needed for tap) requires a rebuild. | Rebuild + re-sign after Info.plist/entitlement edits; expect a one-time TCC re-prompt after signature change (already a known consequence per Phase 1 research) |

**Nothing found in category Stored data:** verified — this phase does no string-rename and no datastore key migration; it refactors capture code and edits one plist + one Swift path-read.

## Common Pitfalls

### Pitfall 1: Direct-launch silently loses TCC grant (D-05 core risk)
**What goes wrong:** After changing the plist to launch the binary directly, the daemon starts but `sysReady`/`micReady` come back false — capture silently fails because macOS attributes the capture to a different responsible process and the existing TCC grant doesn't apply.
**Why it happens:** TCC keys on (bundle id + code signature + sometimes the launching/responsible process). `open` launches the app via LaunchServices (the app is the responsible process); a direct launchd exec makes launchd the parent and may change attribution.
**How to avoid:** The binary is inside a proper `.app` with a correct `CFBundleIdentifier`, so the bundle identity is preserved either way — this is *likely* fine, but it is the #1 thing to validate on a clean machine (not the dev machine, whose grants persist). If it regresses, the fallback is to keep `open` but add a separate clean-stop mechanism — however that re-introduces the orphan, so validation is mandatory before committing D-05.
**Warning signs:** `yulu doctor` shows `sysReady=false` immediately after the plist change; `repair_permissions.py` shows the daemon running but capture not ready.

### Pitfall 2: Version gate trusts the dev machine (D-03 core risk)
**What goes wrong:** The `if #available(macOS 14.4, *)` branch is only ever exercised on the developer's 14.4+/15+ machine. The SCK fallback (13–14.3) and the SCK re-permission nag NEVER reproduce locally, so a broken fallback ships undetected.
**Why it happens:** `#available` is a runtime check; the compiler can't tell you the 13.x path is wrong. The dev's machine never downgrades.
**How to avoid:** Validate the SCK arm on a **macOS 13.x and a 14.2 VM/machine** (the nag environment), and the tap arm on **14.4+**. This is explicitly called out in D-03 and is a human/VM validation gate, not an automated test.
**Warning signs:** Cannot be caught by CI on `macos-latest` (always ≥14.4). Only a 13.x/14.2 runner or VM surfaces it.

### Pitfall 3: Tap delivers all-zero buffers after uptime (VERIFIED Apple bug)
**What goes wrong:** The IO callback keeps firing with correct frame counts and timestamps, but every sample is `0.0` — silent recording — while audio is plainly audible. Onset ranges from ~53 s to 16+ min of uptime; can self-recover or persist.
**Why it happens:** Apple-side bug in `AudioHardwareCreateProcessTap` + `AudioHardwareCreateAggregateDevice`, triggered by sample-rate renegotiation (44.1↔48 kHz), Bluetooth device state changes (AirPods sleep/wake), or long sessions. Open, unanswered on Apple forums.
**How to avoid:** Build the documented teardown+rebuild recovery from the start, and detect silence-with-claimed-frames: `AudioDeviceStop → AudioDeviceDestroyIOProcID → AudioHardwareDestroyAggregateDevice → AudioHardwareDestroyProcessTap → recreate all`. NOTE: this interacts with Yulu's existing silence-monitor (audio_daemon.swift:387-401) which auto-stops on real silence — distinguish "zeros + nonzero frameCount from tap" (bug) from "genuine quiet" (mic RMS also low).
**Warning signs:** R-channel (sys) of the WAV is flat zero while a meeting is clearly playing; mic L-channel is fine.

### Pitfall 4: NSAudioCaptureUsageDescription / entitlement mismatch
**What goes wrong:** The tap's first-run prompt never appears (or the app is killed) because the Info.plist lacks the usage-description string the tap API requires, or the hardened-runtime entitlement is missing.
**Why it happens:** Like all TCC-gated capture, the tap requires `NSAudioCaptureUsageDescription` in Info.plist for the prompt copy. Under hardened runtime, the binary also needs the relevant audio entitlement. Yulu's current `Yulu.app.entitlements` has ONLY `com.apple.security.device.audio-input` (mic). Whether the tap additionally requires a screen/audio-capture entitlement is NOT definitively documented (Apple's docs are sparse — `[CITED: maven.de "documentation is terrible"]`).
**How to avoid:** Add `NSAudioCaptureUsageDescription` to `Yulu.app/Contents/Info.plist` (set in `build_audio_daemon.sh` via the existing `plist_set_or_add` ladder, lines 49-58). Keep `com.apple.security.device.audio-input` (the aggregate device with a mic input stream still needs mic permission — `[CITED: maven.de]`: "Devices with input streams still require microphone permissions even when using taps"). Validate on a clean machine that the prompt appears. Do NOT App-Sandbox the daemon (it isn't today; the tap global-capture path is for non-sandboxed apps).
**Warning signs:** Console shows a TCC violation / the daemon is killed on first tap call; no permission dialog ever shows.

### Pitfall 5: status_agent reads the wrong dir → empty "Recent Recordings" (D-07)
**What goes wrong:** A user sets `audio.output_dir` to a custom path; the menu-bar "Recent recordings" list is empty because `status_agent.swift:loadRecentRecordings()` (96-118) hardcodes `~/Movies/Yulu`.
**Why it happens:** status_agent never reads config.json, unlike its sibling audio_daemon.
**How to avoid:** Port `loadRecordingDir()` from audio_daemon.swift (45-58) — it is a complete, correct config.json reader handling the `~/` prefix and empty-string fallback. Replace the hardcoded `vmDir`/`mvDir` (lines 98-99) with `<resolvedDir>/voicemails` and `<resolvedDir>`. The applyPollResult voicemail classification (709) already keys on stem prefix, not directory, so it's unaffected.
**Warning signs:** Empty recents menu when output_dir ≠ default; works fine on default-config machines (so the dev never sees it — same blind-spot family as Pitfall 2).

## Code Examples

### Core Audio process tap — full capture sequence (the 14.4+ arm)
```swift
// Source: insidegui/AudioCap (github.com/insidegui/AudioCap) + gist sudara/34f00efad69a...
// + Apple "Capturing system audio with Core Audio taps". VERIFIED API names; runtime
// behavior needs 14.4+ machine validation (D-03).
import CoreAudio
import AudioToolbox

@available(macOS 14.4, *)
final class ProcessTapBackend: CaptureBackend {
    private var tapID: AudioObjectID = 0
    private var aggID: AudioObjectID = 0
    private var ioProcID: AudioDeviceIOProcID?

    func startCapture() {
        // 1. Describe a global tap that captures ALL processes (empty exclude list).
        //    initStereoGlobalTapButExcludeProcesses([]) = whole-system audio.  [CITED: gist]
        let desc = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        desc.isPrivate = true            // don't expose the tap device system-wide
        desc.muteBehavior = .unmuted     // passthrough: user still hears the meeting

        // 2. Create the tap → yields an AudioObjectID.
        var tap: AudioObjectID = 0
        guard AudioHardwareCreateProcessTap(desc, &tap) == noErr else { /* set lastError */ return }
        self.tapID = tap

        // 3. Read the tap UID, then build an aggregate device that contains the tap.
        //    Keys VERIFIED from gist: NameKey, UIDKey, TapListKey, TapAutoStartKey, IsPrivateKey.
        let aggDict: [String: Any] = [
            kAudioAggregateDeviceNameKey:        "Yulu-SysTap",
            kAudioAggregateDeviceUIDKey:         UUID().uuidString,
            kAudioAggregateDeviceIsPrivateKey:   true,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceTapListKey: [[
                kAudioSubTapUIDKey: /* tap UID string read from tapID */ "",
            ]],
        ]
        var agg: AudioObjectID = 0
        guard AudioHardwareCreateAggregateDevice(aggDict as CFDictionary, &agg) == noErr else { return }
        self.aggID = agg

        // 4. Read the aggregate device's stream format (ASBD) — tap delivers Float32.
        //    Reuse the existing SysAudioOutput float32→int16 conversion (audio_daemon.swift:473-491).

        // 5. Install an IO callback; convert PCM and feed the existing sink.
        let status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, agg, nil) {
            _, inInputData, _, _, _ in
            // inInputData: AudioBufferList of Float32. Convert to interleaved Int16
            // exactly as SysAudioOutput does, then: recorder.onSysAudio(int16s)
        }
        guard status == noErr, let proc = ioProcID else { return }
        AudioDeviceStart(agg, proc)
        isReadyBacking = true
    }

    func stopCapture() { teardown() }   // see Pitfall 3 — also call on the zero-buffer bug

    private func teardown() {
        if let proc = ioProcID { AudioDeviceStop(aggID, proc); AudioDeviceDestroyIOProcID(aggID, proc); ioProcID = nil }
        if aggID != 0 { AudioHardwareDestroyAggregateDevice(aggID); aggID = 0 }
        if tapID != 0 { AudioHardwareDestroyProcessTap(tapID); tapID = 0 }
    }
    // isReady / lastError / probePermission / sources() omitted for brevity
}
```

### config.json reader to port into status_agent (D-07 fix)
```swift
// Source: audio_daemon.swift:45-58 — copy verbatim into status_agent.swift,
// then use it for both vmDir and mvDir in loadRecentRecordings().
func loadRecordingDir() -> URL {
    let configPath = CONFIG_DIR.appendingPathComponent("config.json")
    guard let data = try? Data(contentsOf: configPath),
          let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let audio = json["audio"] as? [String: Any],
          let raw = audio["output_dir"] as? String,
          !raw.isEmpty else {
        return /* status_agent's existing ~/Movies/Yulu default */ URL(fileURLWithPath: "\(NSHomeDirectory())/Movies/Yulu")
    }
    let path = raw.hasPrefix("~/") ? "\(NSHomeDirectory())/\(raw.dropFirst(2))" : raw
    return URL(fileURLWithPath: path)
}
// status_agent CONFIG_DIR already defined (status_agent.swift:10). Note status_agent uses
// NSString.expandingTildeInPath; audio_daemon uses FileManager.homeDirectoryForCurrentUser —
// keep status_agent's idiom for consistency within that file.
```

### Interface-neutrality proof test (success criterion 4 / D-09)
```python
# Source: pattern from tests/test_yulu_platform_stubs.py + test_yulu_platform_no_shadow.py
# Proves a reviewer (and CI) that a systemd arm could implement the same methods:
# the ABC signature carries no launchd/TCC/SCStream vocabulary.
import inspect, re
from yulu_platform import base

def test_no_macos_vocabulary_in_signatures():
    src = inspect.getsource(base)
    forbidden = ["launchctl", "plist", "LaunchAgent", "KeepAlive", "RunAtLoad",
                 "tccutil", "ScreenCapture", "SCStream", "CATap", "Homebrew", "brew"]
    for word in forbidden:
        assert word.lower() not in src.lower(), f"macOS vocab '{word}' leaked into base.py (D-09)"

def test_macos_arm_satisfies_abc():
    # MacOSDaemonManager must be a drop-in for DaemonManager — same as a hypothetical SystemdDaemonManager.
    from yulu_platform.macos import MacOSDaemonManager
    assert issubclass(MacOSDaemonManager, base.DaemonManager)
    # Every abstract method is implemented (instantiable on Darwin; the systemd arm would mirror this).
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| ScreenCaptureKit for system audio (requires "Screen & System Audio Recording", purple indicator, recurring nag) | Core Audio process taps ("System Audio Recording Only", less-intrusive purple dot, no app restart) | macOS 14.2 (symbols) / 14.4 (stable, per AudioCap) | The whole point of D-01's dual-arm: 14.4+ users escape the nag (success criterion 3) |
| `open -W Yulu.app` under launchd (orphans the app child; needs `pkill -9`) | Direct binary launch under launchd (clean SIGTERM on unload) | This phase (D-05) | Removes the WAV-truncation vector Phase 7 migration depends on |
| Hardcoded `~/Movies/Yulu` in status_agent | config.json `audio.output_dir` via ported `loadRecordingDir()` | This phase (D-07) | Menu follows the user's configured dir |

**Version analysis (the load-bearing D-03 question — RESOLVED):**
- The tap **symbols** (`AudioHardwareCreateProcessTap`, `CATapDescription`) are available from **macOS 14.2** — confirmed by 3 independent sources building against 14.2 (sudara gist, AudioTee article, makeusabrew/audiotee README).
- The **canonical, maintained sample** `insidegui/AudioCap` targets **14.4+** ("With macOS 14.4, Apple introduced new API…") because early 14.2 had instability.
- **Conclusion:** D-01's `if #available(macOS 14.4, *)` gate is the correct, safe choice. Gating at 14.4 (not 14.2) means 14.2–14.3 users get the SCK arm — slightly more users on the nag path, but those two point releases are a narrow band and the tap was unstable there anyway. **Do not lower the gate to 14.2.**

**Deprecated/outdated:**
- Yulu's `sox` + BlackHole path (record_audio.py:367-431) is already legacy/fallback — NOT touched this phase, but note it exists as the non-daemon backend. CaptureBackend covers only the daemon path.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | Direct-launched binary (D-05) retains TCC grants under `com.yulu.audiodaemon` because bundle identity is preserved inside the `.app` | Pitfall 1, Runtime State | HIGH — if wrong, capture silently fails after the plist change; must validate on clean machine BEFORE committing D-05. The plist change is reversible but D-05 is a Phase 7 prerequisite |
| A2 | The tap arm requires `NSAudioCaptureUsageDescription` + keeping `com.apple.security.device.audio-input`, and does NOT need an additional screen-capture entitlement | Pitfall 4, Standard Stack | MEDIUM — Apple docs are sparse; if an extra entitlement is needed the daemon may be killed on first tap call. Validate on clean 14.4+ machine |
| A3 | The global-tap path (`initStereoGlobalTapButExcludeProcesses([])`) captures all system audio and is sufficient for "record the meeting" | Code Examples, Alternatives | LOW — well-attested in gist + AudioCap; per-process scoping is the only alternative and is unnecessary |
| A4 | `record_audio.py ↔ daemon` socket boundary is unchanged by CaptureBackend (abstraction is Swift-internal) | Summary, Resp. Map | LOW — verified by reading record_audio.py:78-98 (socket_send) + audio_daemon.swift:589-775 (SocketServer); the protocol is JSON action strings, capture-impl-agnostic |
| A5 | The tap delivers Float32 (like SCK), so the existing `SysAudioOutput` int16 conversion is reusable | Don't Hand-Roll, Code Examples | LOW — taps deliver Float32 per all sources; read the ASBD at runtime to confirm sample rate/channel count and adapt as SysAudioOutput already does |
| A6 | Linux/Windows Swift CaptureBackend arms are N/A (Swift is macOS-only by design); PLAT-01's "Linux/Windows NotImplementedError stubs" are satisfied by the **Python** seam stubs (already in yulu_platform/linux,windows), not Swift | Open Q #1, phase_requirements | MEDIUM — PLAT-01 wording says "CaptureBackend … Linux/Windows are NotImplementedError stubs"; if the planner reads that as requiring a Swift stub, clarify. CONTEXT D-02 + deferred section confirm Swift stays macOS-only |

## Open Questions

1. **Does PLAT-01's "Linux/Windows are NotImplementedError stubs" mean a Swift stub or a Python stub?**
   - What we know: CONTEXT.md deferred section says "The Swift CaptureBackend's non-macOS arms stay stubs this milestone" and code_context says "keep [Swift binaries] macOS-only; the abstraction is the Python/Swift boundary." The Python `yulu_platform/{linux,windows}/__init__.py` stubs already exist from Phase 1.
   - What's unclear: whether the planner must add a literally-compiling Swift stub type, or whether "CaptureBackend is a Swift protocol with only a macOS conformer + the Python boundary carries the cross-platform stubs" satisfies PLAT-01.
   - Recommendation: Treat PLAT-01's stub requirement as satisfied by (a) the Swift `CaptureBackend` protocol existing with a macOS conformer, and (b) the existing Python linux/windows NotImplementedError seams. Do NOT author non-compiling Swift for Linux. Flag for discuss-phase confirmation if the planner wants certainty.

2. **Should DaemonManager.install render plists via `plistlib`, or reuse the existing `__TOKEN__` template + sed approach?**
   - What we know: The repo today ships `.plist` templates with `__SCRIPT_DIR__`/`__HOME__`/`__PYTHON__` tokens substituted by `dev_install.py:render_plist` and `setup.sh:install_plist`. ServiceSpec is a clean dataclass.
   - What's unclear: whether DaemonManager should generate plists from ServiceSpec programmatically (cleaner, more "neutral") or keep the template-substitution pipeline (less churn, but couples to existing tokens).
   - Recommendation: For Phase 2, have `MacOSDaemonManager.install(spec)` generate the plist from ServiceSpec via `plistlib` (truly neutral, proves the abstraction). Leave the existing template/sed pipeline in `setup.sh`/`dev_install.py` as-is for now (don't rip out working install code mid-milestone). The two can coexist; convergence is a later concern. This is Claude's-discretion territory per the mandate.

3. **Does the existing silence-monitor conflict with the tap zero-buffer bug?**
   - What we know: `AudioRecorder.startSilenceMonitor` (audio_daemon.swift:387-401) auto-stops after N seconds of BOTH channels quiet. The tap bug produces zero sys-buffers while mic is live.
   - What's unclear: whether mic activity alone keeps the recording alive during a tap-zero episode (it should, since the monitor requires BOTH quiet), but the user gets a silent R-channel.
   - Recommendation: The monitor won't false-stop (mic keeps it alive), but add zero-buffer detection in ProcessTapBackend (frameCount > 0 yet all-zero over a window → teardown+rebuild per Pitfall 3). Validate during 14.4+ testing.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Xcode CLI tools / `swiftc` | Building audio_daemon + status_agent (dev install) | ✓ (assumed — dev machine) | — | Release installs ship pre-built signed binaries (Phase 1 BUILD-03); swiftc only needed for `--dev` |
| `launchctl` | DaemonManager, daemon lifecycle | ✓ | macOS builtin | — (macOS-only, no fallback by design) |
| `tccutil` | PermissionModel reset path | ✓ | macOS builtin | — |
| `brew` (Homebrew) | DependencyManager | ✓ (per CLAUDE.md system deps) | — | DependencyManager.is_available returns False if absent; install raises (don't auto-install brew — OUT OF SCOPE per REQUIREMENTS) |
| macOS 14.4+ machine/VM | Validating the tap arm (D-03) | ⚠️ MUST CONFIRM | — | **No fallback — human/VM validation required** |
| macOS 13.x + 14.2 machine/VM | Validating the SCK fallback arm + the nag (D-03) | ⚠️ MUST CONFIRM | — | **No fallback — the dev machine cannot reproduce; VM required** |

**Missing dependencies with no fallback:**
- A macOS 13.x (and ideally 14.2) environment to validate the SCK arm and reproduce the re-permission nag. CI `macos-latest` is ≥14.4 and cannot exercise this. This is the single biggest validation gap.
- A macOS 14.4+ environment to validate the tap arm end-to-end (capture works, no nag, no zero-buffer over a long session, first-run prompt appears). The dev machine likely satisfies this but the long-session zero-buffer bug needs a deliberate soak test.

**Missing dependencies with fallback:**
- `swiftc` on end-user machines — already handled by Phase 1 (pre-built binaries in release; swiftc is `--dev`-only).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework | pytest (Python seams) + `swift build`/`swiftc -typecheck` (Swift compile) + manual/VM (capture + TCC) |
| Config file | none (pytest auto-discovers `tests/`); `tests/conftest.py` only registers `e2e`/`integration` markers |
| Quick run command | `python3 -m pytest tests/test_yulu_platform_stubs.py tests/test_yulu_platform_no_shadow.py -x` |
| Full suite command | `make test` (= `py-compile` + `pytest tests -q` + `swift-build`) |

### Phase Requirements → Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| PLAT-01 | CaptureBackend protocol exists; macOS conformer compiles | compile | `swiftc -typecheck audio_daemon.swift -framework ScreenCaptureKit -framework CoreAudio -framework AudioToolbox …` | ❌ Wave 0 (add to `make swift-build`) |
| PLAT-02 | tap arm gated `#available(macOS 14.4,*)`; SCK arm is the else | manual-VM + static | grep for `#available(macOS 14.4` in audio_daemon.swift; **runtime: VM** | ❌ Wave 0 (static grep test) + VM gate |
| PLAT-02 | system audio actually captured on 14.4+ (R-channel non-zero) | manual-VM | record a meeting on 14.4+, assert WAV R-channel has signal | ❌ human (no fallback) |
| PLAT-02 | SCK arm captures on 13.x/14.2 (the nag environment) | manual-VM | record on 13.x VM, confirm capture + observe nag baseline | ❌ human (no fallback) |
| PLAT-03 | DaemonManager satisfies ABC; status returns neutral string | unit | `pytest tests/test_yulu_platform_macos.py::test_daemon_manager -x` | ❌ Wave 0 |
| PLAT-03 | `launchctl unload` leaves ZERO audio_daemon processes (direct-launch) | integration-macOS | load→record→unload, then `pgrep -f audio_daemon` returns empty | ❌ Wave 0 (macOS-gated) |
| PLAT-03 | direct-launched daemon still acquires ScreenCapture+Mic TCC | manual-clean-machine | clean install, observe permission prompts, `yulu doctor` sysReady=true | ❌ human (no fallback — Pitfall 1) |
| PLAT-04 | PathResolver honors env → config → default precedence | unit | `pytest tests/test_yulu_platform_macos.py::test_path_resolver -x` | ❌ Wave 0 |
| PLAT-04 | status_agent reads config.json output_dir (no hardcoded ~/Movies/Yulu) | static | grep audio_daemon-style `loadRecordingDir` present in status_agent.swift; assert no bare `Movies/Yulu` literal as sole source | ❌ Wave 0 (extend test_status_agent_*) |
| PLAT-05 | PermissionModel/DependencyManager satisfy ABCs; Darwin-gated | unit | `pytest tests/test_yulu_platform_macos.py -x` | ❌ Wave 0 |
| D-09 | no macOS vocabulary leaks into base.py signatures | unit | `pytest tests/test_yulu_platform_no_vocab.py -x` (new, see Code Examples) | ❌ Wave 0 |

### Sampling Rate
- **Per task commit:** `python3 -m pytest tests/test_yulu_platform_*.py -x` (the seam unit + neutrality tests; < 5 s)
- **Per wave merge:** `make test` (pytest + py-compile + swift-build typecheck)
- **Phase gate:** Full suite green + the **manual VM/clean-machine validations** (14.4 tap capture, 13.x/14.2 SCK arm, direct-launch TCC acquisition, zero-orphan unload) signed off before `/gsd-verify-work`. These manual gates are the crux — automated CI cannot cover them.

### Wave 0 Gaps
- [ ] `tests/test_yulu_platform_macos.py` — unit tests for MacOSDaemonManager / PathResolver / PermissionModel / DependencyManager (Darwin-gated with `@pytest.mark.skipif(platform.system() != "Darwin")`)
- [ ] `tests/test_yulu_platform_no_vocab.py` — D-09 neutrality assertion (grep base.py for forbidden macOS terms) — covers D-09
- [ ] `tests/test_audio_daemon_capture_gate.py` — static assert `#available(macOS 14.4` present and SCK arm is the else branch — covers PLAT-02 (static portion)
- [ ] Extend `tests/test_status_agent_*.py` — assert status_agent has a config.json reader and no longer hardcodes the recordings dir as sole source — covers PLAT-04
- [ ] `tests/test_daemon_zero_orphan.py` (macOS-gated, integration marker) — load→unload leaves no `audio_daemon` process — covers PLAT-03 zero-orphan
- [ ] Add tap frameworks to `make swift-build` / `build_audio_daemon.sh` (`-framework AudioToolbox` if the tap arm needs it) so the typecheck covers the new arm
- [ ] **Manual validation checklist** (not a file — a phase-gate doc): 14.4+ tap capture + soak (zero-buffer), 13.x/14.2 SCK arm, clean-machine direct-launch TCC, first-run audio-capture prompt

## Security Domain

> `security_enforcement: true`, `security_asvs_level: 1` in config.json — included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | No auth surface; local single-user daemon |
| V3 Session Management | no | No sessions |
| V4 Access Control | yes (OS-level) | macOS TCC is the access-control boundary for capture; PermissionModel reports but never bypasses it. NEVER attempt to grant TCC programmatically (impossible by design) |
| V5 Input Validation | yes | Socket JSON from `record_audio.py` — the daemon already validates `action` and bounds request size (audio_daemon.swift:607 `maxRequestBytes`, 686-687 action check). DaemonManager subprocess calls take fixed args (no shell string interpolation) — keep `subprocess.run([...])` list form, never `shell=True` |
| V6 Cryptography | no | No crypto in this phase (signing is Phase 1; binaries are signed/notarized) |
| V7 Error Handling | yes | PermissionModel/DependencyManager must not leak paths/PII in errors; daemon already returns structured `{"error": ...}` not stack traces |

### Known Threat Patterns for macOS native daemon + subprocess seams

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Command injection via subprocess (launchctl/tccutil/brew args) | Tampering / Elevation | Always `subprocess.run([list], check=False)` — never `shell=True`, never f-string a user value into a command. Service names/paths come from fixed config, not arbitrary input |
| Tap captures audio from ALL processes (privacy surface) | Information Disclosure | The global tap is the user's explicit recording action, TCC-gated, audio stays local (PROJECT.md core value). Document that the tap records system-wide audio so users understand scope; the `desc.muteBehavior = .unmuted` keeps it passthrough (no silent interception) |
| TCC grant attributed to wrong responsible process after direct-launch | Spoofing / Elevation | Validate the bundle-identity TCC attribution on a clean machine (Pitfall 1); the binary stays inside a correctly-signed `.app` |
| Socket world-access to daemon control | Tampering | Socket already `chmod 0o600` (audio_daemon.swift:630) + per-fd timeouts; unchanged this phase |
| Aggregate device left registered after crash (leaks a virtual device) | DoS | `kAudioAggregateDeviceIsPrivateKey: true` keeps it out of the system device list; teardown() destroys it; daemon `applicationWillTerminate` (828) should also call backend teardown |

## Sources

### Primary (HIGH confidence)
- **Repo source (read this session):** `yulu_platform/base.py` (frozen ABCs), `audio_daemon.swift` (843 lines — SCK arm, socket protocol, WAV writer, silence monitor), `status_agent.swift` (865 lines — hardcoded paths at 96-118, loadRecentRecordings), `com.yulu.audiodaemon.plist` (open -W), `record_audio.py` (socket_send boundary 78-98), `repair_permissions.py` (tccutil), `doctor.py` (launchctl/_check_command), `dev_install.py` (launchctl _unload/_load 191-219), `build_audio_daemon.sh` (codesign + plist_set_or_add + frameworks), `Yulu.app/Contents/Info.plist` (LSUIElement already true, usage descriptions), `Yulu.app.entitlements` (audio-input only), `.planning/phases/01-.../01-PATTERNS.md` (entitlement+yulu_platform-naming traps verified in Phase 1)
- Apple Developer — "Capturing system audio with Core Audio taps" (developer.apple.com/documentation/CoreAudio/capturing-system-audio-with-core-audio-taps) — API surface, NSAudioCaptureUsageDescription requirement [body did not render via WebFetch; corroborated by samples below]
- insidegui/AudioCap (github.com/insidegui/AudioCap) — canonical 14.4+ sample; API call sequence, NSAudioCaptureUsageDescription, private-TCC-vs-first-record permission model

### Secondary (MEDIUM confidence)
- sudara gist (gist.github.com/sudara/34f00efad69a7e8ceafa078ea0f76f6f) — "macOS 14.2" tap example; VERIFIED the aggregate-device dictionary keys + `initStereoGlobalTapButExcludeProcesses([])` global-capture initializer + `kAudioAggregateDeviceIsPrivateKey`
- makeusabrew/audiotee + AudioTee article (stronglytyped.uk/articles/audiotee-capture-system-audio-output-macos) — confirms symbols build against macOS 14.2; "System Audio Recording Only" TCC scope distinct from "Screen Recording"; no purple-indicator-for-audio-only; CLI vs bundle TCC note
- maven.de "CoreAudio Taps for Dummies" (maven.de/2025/04/coreaudio-taps-for-dummies/) — VERIFIED: no public API to query tap authorization status; "devices with input streams still require microphone permissions even when using taps"; less-obnoxious purple dot
- recall.ai blog (recall.ai/blog/how-to-access-to-system-audio) — Screen-Recording vs System-Audio-Recording permission distinction; purple indicator behavior

### Tertiary (LOW confidence — flagged for VM validation)
- Apple Developer Forums thread 825780 — VERIFIED-as-real-but-unresolved: all-zero-buffer bug + the teardown/rebuild workaround sequence (treat as a known hazard to design around, not a settled fact about all OS versions)

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — every API name cross-verified across ≥3 sources + Apple docs; all Python is stdlib (Phase 1 precedent)
- Architecture (seam shapes, boundary): HIGH — grounded in actual repo source read this session; the Python boundary is verified-unchanged
- Tap runtime behavior (format, zero-buffer, TCC scope): MEDIUM — API confirmed, but runtime requires 14.4+ machine validation (D-03 explicitly demands this)
- Version gate (14.2 vs 14.4): HIGH — discrepancy resolved (symbols 14.2, stable/canonical 14.4, D-01 gate correct)
- Pitfalls: HIGH for the in-repo ones (Pitfall 1/5 from source), MEDIUM for tap-specific (Pitfall 3/4 from forums+samples)
- Direct-launch TCC retention (A1) & tap entitlement (A2): the two MEDIUM-risk assumptions gating the phase — both require clean-machine validation before lock

**Research date:** 2026-05-30
**Valid until:** 2026-06-30 for the Python seams (stable); 2026-06-13 for the Core Audio tap specifics (fast-moving, sparse Apple docs, active forum bugs)

## RESEARCH COMPLETE

**Phase:** 2 - Platform-Abstraction Seams
**Confidence:** HIGH (repo-grounded refactor + Python seams) / MEDIUM (Core Audio tap runtime — VM validation required per D-03)

### Key Findings
1. **The Python boundary doesn't change.** `record_audio.py ↔ daemon` is already a thin Unix-socket JSON protocol (`{"action":"start/stop/status"}`); CaptureBackend is a Swift-internal abstraction. The two tracks (Swift capture / Python seams) are fully parallel as D-02 promised.
2. **D-05 is mostly already done.** `Yulu.app/Contents/Info.plist` already has `LSUIElement=true` and the daemon already runs `.accessory` — so the `open -W` → direct-launch plist edit will NOT regain a Dock icon. The single real risk is TCC re-attribution under direct launch (Pitfall 1 / A1) — clean-machine validation required.
3. **The tap arm is the only genuinely new code; everything else has an in-repo analog.** SCK arm = existing `AudioCapture`/`SysAudioOutput` (wrap, don't rewrite per D-03). status_agent fix = port `loadRecordingDir()` from the sibling Swift file. launchctl wrapping = existing dev_install.py calls.
4. **Version gate RESOLVED:** tap symbols are macOS 14.2+, but the canonical AudioCap sample and stability target 14.4 — D-01's `if #available(macOS 14.4, *)` is correct; do not lower it.
5. **Two verified hazards to design in:** (a) the tap's all-zero-buffer bug (teardown+rebuild recovery, Pitfall 3); (b) the tap needs `NSAudioCaptureUsageDescription` + keep the mic entitlement (Pitfall 4). Both need 14.4+ validation.

### File Created
`.planning/phases/02-platform-abstraction-seams/02-RESEARCH.md`

### Confidence Assessment
| Area | Level | Reason |
|------|-------|--------|
| Standard Stack | HIGH | API names cross-verified ×3+ sources; stdlib-only Python |
| Architecture | HIGH | Grounded in repo source read this session; boundary verified unchanged |
| Pitfalls | HIGH (in-repo) / MEDIUM (tap) | In-repo pitfalls from source; tap pitfalls from samples + forums |
| Tap runtime behavior | MEDIUM | API confirmed; runtime needs 14.4+ VM validation (D-03) |

### Open Questions
- PLAT-01 stub wording: Swift stub vs Python stub for Linux/Windows (recommend Python; flag for discuss). 
- DaemonManager plist generation: `plistlib` from ServiceSpec vs existing template/sed (recommend plistlib for the seam, leave install pipeline alone).
- Tap zero-buffer vs silence-monitor interaction (recommend zero-buffer detection in ProcessTapBackend).

### Ready for Planning
Research complete. The two tracks (Swift CaptureBackend / Python seams) can be separate plan waves. The planner has, per requirement: the exact in-repo analog with line numbers, the verified tap API sequence, the load-bearing constraints (14.4 gate, direct-launch TCC validation, NSAudioCaptureUsageDescription), and the explicit list of validations that REQUIRE clean-VM/13.x/14.2/14.4 human sign-off (which CI on macos-latest cannot cover).
