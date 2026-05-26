# Spec: Menu-Bar Status Agent + Global Hotkey

> **Status**: Draft — pending user review
> **Date**: 2026-05-26
> **Owner**: 不白 (yxliao.lewis@gmail.com)
> **Inspired by**: macparakeet `spec/20-status-agent.md` (NSStatusItem + Carbon hotkey for ad-hoc capture)
> **Builds on**: ADR-001 (resident `audio_daemon`), Phase 3 (`recording_lock`, `SYS_DISABLED`), Phase 4 (`voicemail` package — `cmd_new` / `cmd_stop` / post-stop pipeline)
> **Replaces**: nothing — pure addition of a new UI surface. The CLI (`yulu memo`) remains the canonical workflow; the status agent is a lightweight peer.
> **Out of scope** (future specs): hold-to-talk hotkey mode (this spec ships toggle only); settings GUI (use CLI + config.json); in-menu transcript preview; sound effects / waveform animation; iOS / iPad companion; Notification Center widget; per-action multi-hotkey binding

---

## 1. Background and Motivation

Phase 4 shipped voicemail capture as a CLI: `yulu memo new` blocks until silence-stop or Ctrl-C, then transcribes and enqueues. That makes voicemail a developer tool, not a daily tool. Capturing a 15-second thought from the kitchen requires a terminal window, focus shift, typing a command, then context-switching back to whatever you were doing. The friction defeats the use case.

The product expectation is "one click in the corner of the screen, or one keystroke from any app." That's a macOS menu-bar status item + a global hotkey — the same affordance as Voice Memos.app, Bear, or any quick-capture tool. It's the canonical Mac pattern.

A secondary motivation: Phase 4 smoke surfaced that the silence-stop monitor in `audio_daemon.swift` is one-shot (Phase 3 design). Voicemail's 3-second threshold fires once at +3s; if the mic was picking up speaker feedback at that moment, the monitor concludes "not silent yet" and never runs again. Recording continues until external stop. This wasn't visible in meetings (15s threshold; 15s of continuous mic-side audio in a meeting is unusual), but voicemail makes it routine. The fix is to re-schedule the monitor on each audio event — i.e., make silence-stop mean "no audio for the last N seconds" rather than "no audio at exactly +N seconds." It's a 5-line Swift change. This spec folds it in as a small companion fix because the menu-bar agent's `recording` state directly observes when the daemon flips back to `idle`; silence-stop reliability is part of the status agent's UX contract.

## 2. Goals

1. **One-click voicemail capture** from the menu bar (left-click the icon).
2. **One-keystroke voicemail capture** via a global hotkey (default `⌘⇧V`) that works from any app.
3. **Visible recording state** in the menu-bar icon (idle / recording / processing).
4. **Right-click menu** for inbox actions: Start/Stop, recent voicemails, Open Inbox, Quit.
5. **Always-on at login** via a new launchd LaunchAgent (`com.yulu.statusagent`).
6. **Pure client of the existing daemon** — the status agent never opens the microphone or owns recording state. It is a thin Cocoa front-end over the same Unix socket that `record_audio.py`, `meeting_daemon.py`, and `voicemail.cli` already talk to.
7. **Companion fix**: silence-stop monitor becomes periodic (re-armed on each audio event), making the Phase 4 voicemail 3-second auto-stop actually reliable.

## 3. Non-Goals

- **Meetings UI** — the status agent is voicemail-only. Meetings keep using calendar/detector triggers + `yulu record start <title>`. Adding meeting controls to the status icon would conflict with the recording-lock authority model and clutter the menu.
- **In-app preview / playback** — clicking a recent voicemail in the menu opens the existing `yulu memo show` CLI in a Terminal window (or `open <file>` for the `.summary.md`). No new UI for transcript rendering.
- **Hold-to-talk** — toggle only in v1. Hold-to-talk requires keydown/keyup monitoring (more permissions, more edge cases — accidental release on key-up jitter). Future spec.
- **Hotkey rebinding via GUI** — `yulu status-agent set-hotkey "<modifiers>+<key>"` writes the config.json block; status agent re-reads on SIGHUP. No native preferences pane.
- **Multiple hotkeys for different actions** — exactly one global hotkey, bound to "toggle voicemail recording."
- **Status agent for non-mac platforms** — macOS only; the entire architecture (NSStatusItem, Carbon RegisterEventHotKey) is platform-specific.

## 4. Topology

```
┌──────────────────────────────────────────────────────────────┐
│  StatusAgent.app (new Swift binary; launchd-managed)         │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  NSApplication (LSUIElement=YES → no dock icon)         │  │
│  │   │                                                     │  │
│  │   ├─ NSStatusItem with NSImage (template-mode 语)      │  │
│  │   │   ├─ left-click  → toggle()                         │  │
│  │   │   └─ right-click → NSMenu                           │  │
│  │   │                                                     │  │
│  │   ├─ Carbon RegisterEventHotKey (default ⌘⇧V)          │  │
│  │   │   └─ on press → toggle()                            │  │
│  │   │                                                     │  │
│  │   └─ Status poller (every 1s)                           │  │
│  │       └─ updates NSStatusItem image based on daemon     │  │
│  │           status (idle / recording / processing)        │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                  │
│           toggle() flow:   ▼                                  │
│           1. read daemon status                               │
│           2. if recording → send stop, spawn detached         │
│              post-stop pipeline (Python)                      │
│           3. if idle → spawn detached voicemail.cli new       │
│              (which acquires lock + sends start)              │
└──────────────────────────────────────────────────────────────┘
                            │ Unix socket
                            ▼
┌──────────────────────────────────────────────────────────────┐
│  audio_daemon (existing; silence_monitor periodic fix only)  │
└──────────────────────────────────────────────────────────────┘
```

The agent does **not** call `socket_send` directly. It shells out to `python3 -m voicemail.cli new` for start (which acquires `recording_lock` + sends start RPC + waits + transcribes + enqueues — the full Phase 4 happy path) and to `python3 -m voicemail.cli stop` for stop. This keeps **all** voicemail logic in one place (`voicemail.recorder`); the status agent is a button.

## 5. Status Agent (Swift)

### 5.1 Binary structure

`yulu/scripts/status_agent.swift` is a small Cocoa application. Built by `yulu/scripts/build_status_agent.sh` into `yulu/scripts/StatusAgent.app`. Info.plist key `LSUIElement = true` → no Dock icon, no main window, lives only in the menu bar.

Source modules (within the single .swift file, ~400 lines total):

| Section | Responsibility |
|---|---|
| `StatusAgentApp` | Top-level `NSApplicationDelegate`; owns the NSStatusItem and the hotkey registration; subscribes the daemon status poller |
| `DaemonClient` | Synchronous Unix-socket client mirroring `record_audio.socket_send`'s line-delimited JSON contract |
| `HotkeyRegistrar` | Carbon `RegisterEventHotKey` + handler; reads modifier+keycode from config; supports SIGHUP-style re-registration when config changes |
| `IconStateMachine` | Pure function `state → NSImage`; reads template-mode icon variants from app bundle resources |
| `MenuBuilder` | Constructs the right-click `NSMenu` (Start/Stop / Recent Voicemails / Open Inbox / Preferences / Quit) |
| `VoicemailLauncher` | Spawns `python3 -m voicemail.cli new` (start path) or `voicemail.cli stop` (stop path) as detached subprocesses; never blocks the main loop |

### 5.2 State machine

| State | Trigger to enter | Icon | Click behavior |
|---|---|---|---|
| `idle` | Poller reports `recording: false` AND no in-flight launcher subprocess | Template 语 logo | Left-click → start; hotkey → start |
| `recording` | Poller reports `recording: true` with audio_path under `voicemails/` | 语 logo with red dot overlay | Left-click → stop; hotkey → stop |
| `processing` | Stop sent; waiting for transcribe + enqueue subprocess to exit | 语 logo with pulsing dots | Left-click → no-op (clicks ignored); shows tooltip "transcribing…" |
| `meeting_busy` | Poller reports `recording: true` with audio_path NOT under `voicemails/` | 语 logo greyed out | Left-click → notification "Recording: <meeting title>"; menu Start item disabled |
| `daemon_down` | Poller fails to reach socket for ≥ 3 consecutive polls | 语 logo with red strikethrough | Left-click → notification "audio_daemon not running" |

Polling: every 1 s the agent sends `{"action": "status"}` to audio_daemon. On state change, icon is updated on the main thread.

### 5.3 Toggle logic

```
on toggle:
  state = current state
  if state == idle:
      spawn `python3 -m voicemail.cli new` (detached, inherits no terminal)
      transition to recording (the poller will confirm)
  elif state == recording:
      spawn `python3 -m voicemail.cli stop` (detached)
      transition to processing (poller will see recording=false; then the
      processing wait-loop monitors the launcher subprocess we spawned at
      start; when it exits, transition to idle)
  elif state == processing:
      ignore (re-clicks would race with the in-flight transcribe)
  elif state == meeting_busy:
      post NSUserNotification "Meeting recording in progress" with the
      live meeting's title (from socket status)
  elif state == daemon_down:
      post NSUserNotification "audio_daemon not running" with a "Start" button
      that runs `launchctl load ~/Library/LaunchAgents/com.yulu.audiodaemon.plist`
```

The processing → idle transition is observed by the agent tracking the pid of the launcher subprocess it spawned at start. When that subprocess exits (success or failure), the agent transitions back to idle. This is what gives "processing" state its visible meaning — it's the window between user-clicked-stop and pipeline-finished.

### 5.4 Global hotkey

Default binding: `⌘⇧V` (cmdKey | shiftKey, keyCode 9 for V on a US ANSI layout).

Carbon API: `RegisterEventHotKey(keyCode, modifiers, signature, GetApplicationEventTarget(), 0, &hotKeyRef)`. A single `EventHandlerUPP` dispatches on `kEventHotKeyPressed` and calls `toggle()`.

Configurable via `~/.config/yulu/config.json`:

```json
"status_agent": {
  "enabled": true,
  "hotkey": {
    "key": "V",
    "modifiers": ["cmd", "shift"]
  }
}
```

`yulu status-agent set-hotkey "cmd+shift+V"` writes the block, then SIGHUPs the running status agent (it re-reads config and re-registers). Invalid bindings (unknown modifier, multi-character key) fail with a clear error before writing.

Modifiers accepted: `cmd`, `shift`, `alt`, `ctrl`. Key must be a single ASCII alphanumeric or function key (`F1`–`F20`). Carbon keycodes are looked up via a static table embedded in `status_agent_config.py`.

Re-registration on SIGHUP: the agent installs `signal(SIGHUP, ...)` and on receipt calls `HotkeyRegistrar.reregister()` which `UnregisterEventHotKey` + reads config + `RegisterEventHotKey` again.

### 5.5 Menu

Right-click on the status icon shows:

```
┌─────────────────────────────────┐
│  ● Recording  / Start Voicemail │   ← title reflects state; click toggles
│  ─────────────────────────────  │
│  Recent voicemails              │
│  ├─ Anthropic follow-up   ✓     │   ← top 5 from list_voicemails(limit=5)
│  ├─ Phase 5 design idea   ✓     │     click → opens .summary.md (or .transcript.txt)
│  ├─ Reminder to email Mason     │
│  ├─ ...                         │
│  └─ Open inbox in Terminal      │   ← runs `yulu memo list` in Terminal.app
│  ─────────────────────────────  │
│  Hotkey: ⌘⇧V                    │   ← disabled label, shows current binding
│  ─────────────────────────────  │
│  Quit Yulu Status Agent         │
└─────────────────────────────────┘
```

Menu items below the recording control are dynamic — `Recent voicemails` is rebuilt every menu open from `voicemail.repo.list_voicemails(limit=5)`. Click on a recent → `open <stem>.summary.md` if present, else `<stem>.transcript.txt`, else `<wav>`.

"Open inbox in Terminal" runs:
```bash
osascript -e 'tell application "Terminal" to do script "yulu memo list"'
```

### 5.6 Icon resources

Three template-mode `NSImage` variants in `StatusAgent.app/Contents/Resources/`:
- `status_idle.png` — 18×18 + 36×36 (Retina) parchment 语 logo
- `status_recording.png` — same with a red dot in the bottom-right
- `status_processing.png` — same with three small dots in the bottom-right (the agent animates between 1-2-3 dots client-side via a `Timer`)

These are derived from `assets/Yulu.icns` at install time by a small `sips`-based step in `build_status_agent.sh`. The simpler-than-app-icon variants (16×16 menu-bar template) are hand-tweaked once and committed; the build script just copies them into the bundle.

Template mode (`image.isTemplate = true`) means macOS auto-inverts for dark mode. Red dot overlay is composited in code at draw time, not baked into the asset, so dark-mode renders correctly without a separate red variant.

## 6. Audio Daemon: Silence-Stop Periodic Fix

Phase 3 added `startSilenceMonitor()` to `AudioRecorder`, called once at recording start. It schedules a `DispatchWorkItem` at `+silenceSeconds` that checks "is both channels quiet right now?" — one shot.

Voicemail's 3-second threshold makes the one-shot timing brittle: speaker feedback into the mic during the 3-second window keeps `lastMicAudioTime` fresh, the check at +3s says "mic active in last 3s," monitor exits without rescheduling, recording runs forever until external stop.

Fix: re-arm the monitor on every audio event. Append `startSilenceMonitor()` to the end of `mixAndWrite()`. Each frame buffer that arrives cancels the pending monitor task and schedules a fresh one at +silenceSeconds. The semantics become "stop after silenceSeconds without any audio" — which is what users expect.

Implementation footprint:

```swift
private func mixAndWrite() {
    // ... existing body unchanged ...
    let out = channelInterleave(sysStereo: sysChunk, micMono: micChunk)
    w.append(Data(bytes: out, count: out.count * 2))
    startSilenceMonitor()   // NEW — re-arm
}
```

`startSilenceMonitor` already cancels its previous task before scheduling a new one (Phase 3 wrote it that way), so re-arming is safe and bounded. No new state.

This is a 1-line addition + a 1-line comment explaining the re-arm intent. Bundled with Phase 5 because the status agent's UX correctness depends on silence-stop firing reliably for voicemails.

## 7. Configuration

New block in `~/.config/yulu/config.json`:

```json
"status_agent": {
  "enabled": true,
  "hotkey": {
    "key": "V",
    "modifiers": ["cmd", "shift"]
  }
}
```

Defaults are applied by `status_agent_config.py::load()`: missing block → `enabled=true, key="V", modifiers=["cmd","shift"]`.

`yulu status-agent` subcommand:

```bash
yulu status-agent install        # install launchd plist, copy StatusAgent.app, load agent
yulu status-agent uninstall      # unload + remove plist + remove app bundle
yulu status-agent enable         # set config.enabled=true, load plist
yulu status-agent disable        # set config.enabled=false, unload plist
yulu status-agent status         # show plist load state + current hotkey + recent voicemails count
yulu status-agent set-hotkey "<modifiers>+<key>"
                                  # e.g. "cmd+shift+V", "alt+space", "ctrl+F19"
                                  # validates, writes config, SIGHUPs running agent
```

`yulu` shell wrapper dispatches `status-agent` to a new `status_agent_config.cli.main`.

## 8. Launchd Plist

`yulu/scripts/com.yulu.statusagent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yulu.statusagent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-W</string>
        <string>/Users/liaoyuxing/.yulu/yulu/scripts/StatusAgent.app</string>
    </array>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>/Users/liaoyuxing/.config/yulu/status_agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/liaoyuxing/.config/yulu/status_agent.log</string>
</dict>
</plist>
```

The path is templated by `setup.sh` (same `__SCRIPT_DIR__` substitution pattern Phase 1 uses for `com.yulu.sttdaemon.plist`).

## 9. CLI Module

New file `yulu/scripts/status_agent_config.py`:

```python
"""yulu status-agent — config + plist management."""

from __future__ import annotations
import json, signal, subprocess, sys
from pathlib import Path
from typing import Optional

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PLIST_PATH = Path.home() / "Library" / "LaunchAgents" / "com.yulu.statusagent.plist"
PID_PATH = Path.home() / ".config" / "yulu" / "status_agent.pid"

DEFAULT_HOTKEY = {"key": "V", "modifiers": ["cmd", "shift"]}
ALLOWED_MODIFIERS = {"cmd", "shift", "alt", "ctrl"}

# Carbon keycode table (US ANSI layout); used to validate `set-hotkey`
_KEYCODES = {
    "A": 0, "B": 11, "C": 8, "D": 2, ... "V": 9, ...
    "F1": 122, "F2": 120, ... "F20": 90,
    "Space": 49,
}


def load() -> dict:
    """Read config.json, return the status_agent block with defaults filled in."""

def save(block: dict) -> None: ...

def parse_hotkey(spec: str) -> dict:
    """Parse 'cmd+shift+V' → {'key': 'V', 'modifiers': ['cmd','shift']}.
    Raises ValueError on invalid syntax, unknown modifier, or unmapped key."""

def sighup_running_agent() -> None:
    """Send SIGHUP to the agent via PID_PATH so it re-reads config."""

# CLI handlers (install, enable, disable, status, set-hotkey)
```

Tests in `tests/test_status_agent_config.py` cover: defaults, parse_hotkey edge cases, config round-trip, PID-file SIGHUP plumbing.

## 10. Build Script

`yulu/scripts/build_status_agent.sh` mirrors `build_audio_daemon.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$SCRIPT_DIR/StatusAgent.app"

swiftc -o "$SCRIPT_DIR/status_agent" status_agent.swift \
  -framework Cocoa -framework Carbon

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$SCRIPT_DIR/status_agent" "$APP/Contents/MacOS/status_agent"

# Info.plist with LSUIElement=true (no Dock icon)
/usr/libexec/PlistBuddy ... (mirrors Yulu.app pattern)
plist_set_or_add LSUIElement bool true
plist_set_or_add CFBundleIdentifier string com.yulu.statusagent

cp "$SCRIPT_DIR/status_agent_icons/status_idle.png"       "$APP/Contents/Resources/"
cp "$SCRIPT_DIR/status_agent_icons/status_recording.png"  "$APP/Contents/Resources/"
cp "$SCRIPT_DIR/status_agent_icons/status_processing.png" "$APP/Contents/Resources/"

codesign --force --sign "$IDENTITY" "$APP"
```

The 3 PNG variants live in `yulu/scripts/status_agent_icons/` (hand-tweaked from `assets/Yulu.icns`, committed). 18×18 + 36×36 (@2x), template mode.

## 11. Setup Integration

`setup.sh` extensions:

```bash
# Build + install status agent
bash "$SCRIPT_DIR/build_status_agent.sh"
sed "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" "$SCRIPT_DIR/com.yulu.statusagent.plist" \
    > "$HOME/Library/LaunchAgents/com.yulu.statusagent.plist"
launchctl load "$HOME/Library/LaunchAgents/com.yulu.statusagent.plist"
```

`yulu doctor` adds a status-agent check: plist loaded, hotkey registered (read agent's log for "hotkey_registered" line), config.json block valid.

## 12. Failure Modes

| Failure | Behavior |
|---|---|
| Hotkey already taken by another app | Carbon `RegisterEventHotKey` returns error code; agent logs `hotkey_registration_failed key=V modifiers=cmd+shift`; menu item shows "Hotkey: unavailable"; click-toggle still works |
| audio_daemon socket missing for 3+ consecutive polls | Agent enters `daemon_down` state; icon shows red strikethrough; click posts NSUserNotification with a "Restart audio daemon" button |
| Recording lock busy (meeting in flight) when hotkey fires | `voicemail.cli new` exits 2 with `RecordingBusy`; agent reads the exit code from the launcher subprocess; posts NSUserNotification with the meeting's title; transitions back to idle |
| User clicks while in `processing` state | Click ignored; tooltip "Transcribing — please wait" appears |
| `voicemail.cli` launcher subprocess crashes | Agent's wait-loop sees non-zero exit; logs the error; transitions to idle; posts notification "voicemail capture failed: <stderr first line>" |
| Mic permission revoked | `voicemail.cli new` returns 1 from daemon "mic capture not available"; agent surfaces a notification with System Settings link |
| Config.json malformed (manual edit corrupts it) | `status_agent_config.load()` catches JSON error; agent falls back to defaults; logs warning; subsequent `set-hotkey` rewrites cleanly |
| Status agent itself crashes | `KeepAlive=true` + `ThrottleInterval=10` in plist; launchd respawns within 10 seconds |
| Carbon API removal in future macOS | Out-of-scope risk — Apple has signaled no Carbon removal for menu-bar/hotkey APIs in foreseeable releases. If it happens, this spec needs a successor using `NSEvent.addGlobalMonitorForEvents` (requires Input Monitoring permission) |

## 13. Acceptance Criteria

1. **Install**: `yulu status-agent install` builds StatusAgent.app, copies the launchd plist, and loads the agent. Within 2 seconds, a 语 icon appears in the menu bar.
2. **Left-click idle → recording**: clicking the icon while idle triggers `voicemail.cli new` (verified via daemon log showing `🎙 voicemail_*.wav`); icon changes to red-dot variant within 1 polling cycle (≤ 1 s).
3. **Left-click recording → processing → idle**: clicking again sends stop; icon flips to processing-dots; the agent's launcher subprocess (the original `voicemail.cli new` spawned at start) exits after transcribe + enqueue; icon returns to idle within the elapsed transcribe time.
4. **Global hotkey ⌘⇧V from another app**: focus a different application (Safari, Notes); press ⌘⇧V; voicemail recording starts; press again; recording stops + transcribes. No focus switch required.
5. **Right-click menu**: shows "Start Voicemail" (or "Recording…" when active), "Recent voicemails" submenu with up to 5 entries from `list_voicemails(limit=5)`, "Open inbox in Terminal", "Hotkey: ⌘⇧V" (disabled label), "Quit Yulu Status Agent".
6. **Recent voicemail click**: clicking a recent entry runs `open <stem>.summary.md` (or `.transcript.txt` fallback).
7. **`set-hotkey` round-trip**: `yulu status-agent set-hotkey "ctrl+option+M"` writes config, SIGHUPs agent, agent re-registers; new binding works; menu shows updated label; old `⌘⇧V` no longer fires voicemail.
8. **Meeting-busy state**: while a meeting is recording, the status icon greys out; clicking shows a notification with the meeting title; hotkey press surfaces same notification (no recording started).
9. **Silence-stop periodic fix**: a voicemail with 3-second silence_seconds reliably auto-stops within 3.5 seconds of the user falling silent (was: never, until external stop).
10. **No dock icon**: StatusAgent.app does not appear in the Dock, in ⌘-Tab, or in Mission Control.
11. **launchd respawn**: `launchctl unload com.yulu.statusagent.plist && launchctl load com.yulu.statusagent.plist` brings the icon back within 2 seconds.
12. **No regression**: all Phase 1+2+3+4 acceptance tests still pass (no daemon protocol changes; the silence-monitor re-arm is bounded and tested).

## 14. References

- macparakeet `spec/20-status-agent.md` — NSStatusItem + Carbon hotkey pattern
- Apple Cocoa `NSStatusItem` documentation (LSUIElement, template images)
- Carbon `RegisterEventHotKey` reference (`<Carbon/Carbon.h>`)
- Phase 4 spec `docs/superpowers/specs/2026-05-23-voicemail-inbox-design.md` §3 out-of-scope ("hotkey/menubar — Phase 5")
- Phase 3 spec `docs/superpowers/specs/2026-05-22-dual-track-recording-design.md` §5 (silence-monitor implementation that this spec fixes)
