---
phase: 9
slug: release-safety
status: draft
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-23
---

# Phase 9 — Validation Strategy

> Execution-time validation contract. `nyquist_compliant: true` means every planned task has a mapped verification; it does not mean implementation exists or any pending test is green. `wave_0_complete` stays false until execution creates/extends the missing tests and validator and their commands pass.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest 9.0.3, Bash `bash -n`, ShellCheck 0.11.0, macOS `vtool` |
| **Config file** | Existing pytest discovery and GitHub Actions workflows |
| **Quick run command** | `python3 -m pytest -q tests/test_package_release.py tests/test_release_installer.py tests/test_migrate_recording_guard.py tests/test_setup_decomposition.py tests/test_provision_registry.py` |
| **Full suite command** | `python3 -m pytest -q` |
| **Current phase status** | Planned/pending; no Phase 9 implementation test is claimed green |

## Sampling Rate

- **After every autonomous task:** run that task's exact `<verify><automated>` command.
- **After Wave 1:** run the combined Plan 09-01 and 09-02 automated gates.
- **After Wave 2 implementation:** run all six autonomous-task commands and the targeted five-file pytest command before opening checkpoint 09-03-03.
- **Before `$gsd-verify-work`:** full pytest must pass and checkpoint 09-03-03 must be approved against one traceable signed draft/pre-release candidate.
- **Max automated feedback latency:** target under 60 seconds per task command; the credentialed workflow and real-host checkpoint are manual/external and excluded from this latency target.

## Per-Task Verification Map

| Task ID | Plan | Wave | Kind | Requirement | Threat Ref | Secure Behavior | Verification | Planned Artifact/Test | Status |
|---------|------|------|------|-------------|------------|-----------------|--------------|-----------------------|--------|
| 09-01-01 | 01 | 1 | auto | DIST-01 | T-09-01-01, T-09-01-02 | Hermetic stable-channel bootstrap selects Release-owned code, rejects injected versions, and pins packaged helper/runtime to one candidate tag | `python3 -m pytest -q tests/test_release_installer.py -k 'target or bootstrap or packaged or main'` plus `bash -n`/ShellCheck from the task | Extend `tests/test_release_installer.py` | ⬜ pending |
| 09-01-02 | 01 | 1 | auto | DIST-03 | T-09-01-03, T-09-01-04 | Canonical guard refuses release/dev mutation and uses only a verified staged guard for legacy release updates | `python3 -m pytest -q tests/test_release_installer.py tests/test_migrate_recording_guard.py` plus `py_compile` | Extend existing tests | ⬜ pending |
| 09-02-01 | 02 | 1 | auto | DIST-02 | T-09-02-01, T-09-02-02 | Every shipped and CI-smoke Swift compile declares `arm64-apple-macosx13.0` | `python3 -m pytest -q tests/test_package_release.py -k 'macos or target or swift'` plus build-script `bash -n`/ShellCheck | Extend `tests/test_package_release.py` | ⬜ pending |
| 09-02-02 | 02 | 1 | auto | DIST-02 | T-09-02-03, T-09-02-04 | Fail-closed `vtool` gate checks all five exact extracted final binaries before release publication | `python3 -m pytest -q tests/test_package_release.py -k 'macos or target or deployment or workflow'` plus checker `bash -n`/ShellCheck | Create checker; extend test | ⬜ pending |
| 09-03-01 | 03 | 2 | auto | DIST-04 | T-09-03-01, T-09-03-02 | Core readiness is ffmpeg + sox + compatible Node; no automatic Homebrew or default calendar tooling mutation | `python3 -m pytest -q tests/test_setup_decomposition.py tests/test_provision_registry.py` plus setup-script `bash -n`/ShellCheck | Extend existing tests | ⬜ pending |
| 09-03-02 | 03 | 2 | auto | DIST-04 | T-09-03-03, T-09-03-04 | Agent registration is detected-only/non-fatal, calendar defers, and credential paths are not shell-evaluated | Targeted setup/provision/package pytest `-k 'setup or deps or provision or mcp or calendar or package'` plus negative source gates | Extend existing tests | ⬜ pending |
| 09-03-03 | 03 | 2 | blocking human checkpoint | DIST-01, DIST-02, DIST-03, DIST-04 | All HIGH release/data-integrity/host-mutation threats | One exact signed candidate passes real asset, live recording, legacy staged-guard, and clean-host checks without public latest-stable publication | Human evidence per 09-03-PLAN Task 3 after all six auto tasks pass | External signed asset and real host state | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky. All seven rows are pending; this document does not claim Phase 9 tests have run or passed.*

## Wave 0 Requirements

- [ ] Create `packaging/scripts/check_macos_deployment_target.sh` with fail-closed path/tool/platform/architecture/exact-`minos 13.0` checks for supplied binaries.
- [ ] Extend `tests/test_release_installer.py` for Release bootstrap/tag pairing, adversarial version input, release/dev active refusal, late rollback, and verified staged-guard behavior.
- [ ] Extend `tests/test_package_release.py` for explicit Swift target flags, all-five-binary workflow invocation, release gate ordering, and optional all-Agent setup contract.
- [ ] Extend `tests/test_setup_decomposition.py` for core-ready/no-brew, optional calendar gating, no Agent requirement, no `eval`, and idempotency.
- [ ] Extend `tests/test_provision_registry.py` for the ffmpeg + sox + compatible Node readiness boundary.

`wave_0_complete` remains `false` until execution creates these cases/artifacts and the mapped automated commands pass. The external 09-03-03 checkpoint is not a Wave 0 test and cannot be replaced by fixtures.

## Blocking Human Checkpoint — 09-03-03

The checkpoint opens only after Tasks 09-01-01 through 09-03-02 pass their automated gates. It uses one traceable signed/notarized candidate: draft status is sufficient for exact-byte workflow checks, and it is published only as a pre-release if end-to-end release-by-tag download requires it. It is never promoted to public latest stable in Phase 9.

| Check | Requirements | Why Manual | Required Evidence |
|-------|--------------|------------|-------------------|
| Exact signed candidate asset | DIST-01, DIST-02 | Local fixtures cannot prove credentialed signing/notarization, remote asset identity, or attestation | Candidate tag/workflow URL; hashes of downloaded `install.sh`/zip/checksums; signing/notarization/manifest/attestation/remote-byte and five-binary `vtool` success for those bytes; packaged tag pairing |
| Live recording release/dev refusal | DIST-03 | Requires real daemon/PID/WAV state and a destructive-boundary observation | Before/after VERSION, metadata, daemon PIDs, WAV size/validity; candidate version-pinned stable-channel and dev refusals; legacy pre-v0.6 candidate update proving verified staged guard before swap |
| Clean-host core install without optional tools | DIST-04 | Package-manager/Agent/calendar absence is an external host condition | Clean host/account with ffmpeg, sox, compatible Node but no Homebrew/Hermes/OpenClaw/gog/cloudflared/terminal-notifier; successful core startup and zero default optional mutation |

Public `releases/latest` stable post-release smoke and documentation alignment remain Phase 13 DOCS-03. A draft/pre-release candidate must never be described as accepted public latest stable.

## Validation Sign-Off

- [x] Six autonomous tasks have exact automated verification mappings.
- [x] Blocking human checkpoint 09-03-03 has three explicit real-world evidence groups; macOS 13 arm64 hardware acceptance is explicitly waived while the five-binary `vtool` gate remains required.
- [x] Plan 03 is Wave 2 and depends on both Wave 1 plans.
- [x] Sampling continuity has no unmapped autonomous task.
- [x] No watch-mode flag is used.
- [x] `nyquist_compliant: true` records complete plan-to-verification mapping only.
- [ ] Wave 0 artifacts/tests have been created and passed (`wave_0_complete` remains false).
- [ ] All six autonomous tasks are green.
- [ ] Checkpoint 09-03-03 is approved.

**Approval:** pending execution and human checkpoint
