---
phase: 2
slug: platform-abstraction-seams
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 2 — Validation Strategy

> Per-phase validation contract. Per-task map populated after planning. Infra + Wave 0 + manual rows derived from RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (Python seams `yulu_platform/macos/`) + `swiftc` build (CaptureBackend + audio_daemon) + `bash -n` (CI) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`), CI swift build job |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` + swift build of all `.swift` |
| **Estimated runtime** | ~120s pytest + swift compile |

---

## Sampling Rate

- **After every task commit:** `make pytest` (Python seams) or `swiftc` typecheck (Swift capture)
- **After every plan wave:** `make test` + swift build
- **Before verify:** full suite green
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_yulu_platform_macos.py` — assert macOS impls of PathResolver/DaemonManager/PermissionModel/DependencyManager satisfy the Phase 1 ABCs (no abstractmethod left unimplemented); TCC/launchctl/brew calls Darwin-gated (PLAT-05)
- [ ] Interface-neutrality test — grep/AST assert no `SCStreamConfiguration` / plist-key / TCC-scope vocab leaks into `yulu_platform/base.py` signatures (success criterion 4)
- [ ] Swift build gate — CaptureBackend protocol + both arms (`if #available` 14.4) compile under the CI swift build job

---

## Manual-Only Verifications (VM / clean-machine — human required)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Core Audio process taps capture system audio on 14.4+ with no weekly re-permission nag | PLAT-02 / SC-3 | Needs a real macOS 14.4+ machine; CI can't grant the "System Audio Recording Only" TCC scope or soak for the zero-buffer bug | On 14.4+: record a meeting, confirm system audio captured; re-record next week → no re-permission prompt; soak-test for all-zero buffers (Pitfall 3 recovery path) |
| ScreenCaptureKit fallback arm works on 13–14.3 + reproduces the nag baseline | PLAT-02 / SC-3 | Dev's machine never reproduces the SCK nag; needs 13.x / 14.2 VM | On a 13.x or 14.2 VM: confirm SCK arm captures audio via the `if #available` fallback path |
| Direct-launched audio daemon acquires ScreenCapture + Microphone TCC under `com.yulu.audiodaemon` | PLAT-03 / SC-2 | TCC re-attribution under direct launch vs `open -W` can only be verified on a clean machine (Assumption A1) | On a clean Mac: install, grant permissions, stop daemon via DaemonManager → confirm zero lingering processes AND capture still works (TCC held) |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers macOS-impl ABC conformance + interface neutrality + swift build
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
