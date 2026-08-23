---
phase: 9
slug: release-safety
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-23
---

# Phase 9 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 9.0.3, Bash `bash -n`, ShellCheck 0.11.0, macOS `vtool` |
| **Config file** | Existing pytest discovery and GitHub Actions workflows |
| **Quick run command** | `python3 -m pytest -q tests/test_package_release.py tests/test_release_installer.py tests/test_migrate_recording_guard.py tests/test_setup_decomposition.py tests/test_provision_registry.py` |
| **Full suite command** | `python3 -m pytest -q` |
| **Estimated runtime** | ~60 seconds targeted; full suite varies |

## Sampling Rate

- **After every task commit:** Run the task's targeted pytest file plus `bash -n` and ShellCheck for touched shell files
- **After every plan wave:** Run the five-file targeted regression command
- **Before `$gsd-verify-work`:** Full pytest must be green and the real release artifact must pass `vtool`
- **Max feedback latency:** 60 seconds for the targeted suite

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 09-01-01 | 01 | 1 | DIST-01 | T-09-01 | Stable bootstrap never mixes moving `main` helper with a released runtime | unit | `python3 -m pytest -q tests/test_package_release.py -k 'install or release'` | ✅ extend | ⬜ pending |
| 09-01-02 | 01 | 1 | DIST-03 | Active recording refuses both release and dev update before runtime mutation | unit | `python3 -m pytest -q tests/test_release_installer.py -k recording tests/test_migrate_recording_guard.py` | ✅ extend | ⬜ pending |
| 09-02-01 | 02 | 1 | DIST-02 | Every shipped Mach-O declares macOS 13.0 and the final artifact is gated | integration | `python3 -m pytest -q tests/test_package_release.py -k 'macos or target'` | ❌ W0 gate | ⬜ pending |
| 09-03-01 | 03 | 1 | DIST-04 | Core setup performs no optional Agent/calendar/Homebrew mutation | unit | `python3 -m pytest -q tests/test_setup_decomposition.py tests/test_provision_registry.py` | ✅ extend | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

## Wave 0 Requirements

- [ ] `packaging/scripts/check_macos_deployment_target.sh` — fail-closed `vtool` validator for all five shipped Mach-O binaries
- [ ] Extend `tests/test_package_release.py` for release installer pairing, Swift target flags, and workflow gate invocation
- [ ] Extend `tests/test_release_installer.py` for active-recording refusal on release and dev paths before mutation
- [ ] Extend `tests/test_setup_decomposition.py` and `tests/test_provision_registry.py` for core-only dependency readiness

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Stable install runs on clean macOS 13 arm64 | DIST-01, DIST-02 | CI fixtures cannot prove the loader and real release asset | Publish a pre-release, download its own `install.sh`, install on macOS 13, and start all native helpers |
| Update refusal preserves a live recording | DIST-03 | Requires the real daemon, WAV, and launchd process state | Start a recording; run stable and dev update; verify non-zero refusal, unchanged PIDs/runtime, growing then valid WAV |
| Core install succeeds with optional tooling absent | DIST-04 | Clean-host package manager state is an external condition | Install with no Hermes/OpenClaw/gog/cloudflared/Homebrew while core commands are available; verify no optional bootstrap runs |

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s for task sampling
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
