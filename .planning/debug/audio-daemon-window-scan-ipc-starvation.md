# audio daemon window scan IPC starvation

## Goal

Fix intermittent "recording backend disconnected" symptoms during active recordings without interrupting the current recording while editing the dev checkout.

## Assumptions

- Editing the development checkout does not affect the running installed daemon.
- `make dev-install` can restart LaunchAgents, so it must run only after code/test verification and after checking whether a recording is active.

## Root Cause

`audio_daemon.swift` routes `windows`, `status`, `start`, and `stop` through one serial IPC queue. `meeting_detector.py` can issue `windows` polls during recording. The `windows` action calls macOS Accessibility APIs, and a stuck `AXUIElementCopyAttributeValue` call blocks the serial queue. The daemon process keeps running, but later `status` / `stop` requests time out behind the stuck window scan, which surfaces as the backend going offline.

## Verification

- Add a regression check that window scanning is isolated from control IPC.
- Build the Swift audio daemon.
- Run the focused IPC starvation tests.
- Dev install only when the local runtime is recording-safe.

## Result

- Patched `audio_daemon.swift` so request reads, control IPC, and Accessibility window scans no longer share one serial queue.
- Repeated `windows` polls now return a `window_scan_busy` response while an earlier scan is still in flight.
- Verified with focused tests, Swift build, dev install, and a live audio-daemon socket probe.
