---
phase: 1
slug: build-foundation-setup-decomposition-signed-notarized-binari
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-29
---

# Phase 1 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Per-task map is populated after planning (needs task IDs); infrastructure + Wave 0 + manual rows are derived from RESEARCH.md §Validation Architecture.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (Python, existing `tests/`) + `bash -n` syntax check + `swiftc` build (all in CI) + shellcheck (Wave 0 add) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest` / `make test`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~60–120 seconds (pytest + syntax + swift build) |

---

## Sampling Rate

- **After every task commit:** Run `make pytest` (plus `bash -n` on any touched `*.sh`)
- **After every plan wave:** Run `make test`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** ~120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning — one row per task; planner/nyquist-auditor fills task IDs)_ | | | | | | | | | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `tests/test_yulu_platform_stubs.py` — assert `yulu_platform.linux`/`windows` ABC methods raise `NotImplementedError`; assert `yulu_platform/` does NOT shadow stdlib `platform` (import both, check distinct) — covers BUILD foundation success criterion 5
- [ ] `shellcheck` added to CI (or a `bash -n` per-script gate) — proves each decomposed `setup_*.sh` parses under `set -uo pipefail` (BUILD-01)
- [ ] CI zip-integrity test extended to assert `external_attr` exec bits on `*.app` binaries (CONCERNS §8a regression guard)

*If none: "Existing infrastructure covers all phase requirements."*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Notarized build passes `spctl -a -vvv` on a clean second machine | BUILD-02 | Requires a second physical Mac that never trusted the dev cert; Gatekeeper assessment can't be faked in CI | On a clean Mac: download release zip, unzip, run `spctl -a -vvv Yulu.app` → expect `accepted ... source=Notarized Developer ID`; launch with no Gatekeeper prompt and no `xattr` strip |
| Release install runs with no Xcode/`swiftc` present | BUILD-03 | Needs a machine without Xcode CLT to prove the swiftc-free path | On a Mac without CLT: run the curl installer; confirm capture/transcription/daemons start from pre-built binaries |
| `gh attestation verify` against Yulu's CI | BUILD-04 | Needs a published release asset + CI provenance | `gh attestation verify <release-zip> --repo Nowhitestar/Yulu` → expect verified provenance |

*If none: "All phase behaviors have automated verification."*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
