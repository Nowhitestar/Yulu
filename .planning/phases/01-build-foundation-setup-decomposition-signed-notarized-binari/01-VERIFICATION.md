---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
verified: 2026-05-30T05:30:00Z
status: human_needed
score: 5/5 must-haves verified (3 fully automated + 2 code-complete pending human credential-gated proof)
overrides_applied: 0
human_verification:
  - test: "Notarized build passes spctl -a -vvv on a clean second Mac (SC-2 / BUILD-02)"
    expected: "On a Mac that never trusted the dev cert: download the published release zip, unzip, run `spctl -a -vvv -t exec Yulu.app` -> 'accepted ... source=Notarized Developer ID', NO Gatekeeper warning, NO xattr quarantine-strip. Then `xcrun stapler validate Yulu.app` -> 'The validate action worked!'. Repeat for StatusAgent.app."
    why_human: "Requires a real Apple Developer ID signing run (7 GitHub Actions secrets only Lewis can inject) + a clean second physical Mac. Gatekeeper assessment cannot be faked or run in CI. The CI signing/notarize/staple pipeline code exists and is statically validated; only the end-to-end Gatekeeper acceptance is unverifiable here."
  - test: "Release asset integrity verifies via `gh attestation verify` against Yulu's CI (SC-4 / BUILD-04)"
    expected: "After a real release-publish run: `gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu` -> verified provenance against Yulu's CI."
    why_human: "Requires a published release asset with CI-minted SLSA provenance. The `actions/attest-build-provenance@v4` step + id-token/attestations:write permissions are wired in release-publish.yml; the attestation can only be minted (and verified) by an actual CI run with the OIDC token. RESEARCH Assumption A4 (reusable-workflow OIDC permission inheritance) is also confirmed only by this run."
  - test: "Release-publish dry-run: notarytool reaches Accepted + attest step succeeds + keychain torn down + no secret in logs"
    expected: "Trigger a pre-release tag. The Sign-and-notarize step reaches notarytool status:Accepted; the Attest step succeeds (A4 OIDC confirmation); the if:always() Clean-up signing keychain step runs; scanning the run logs shows NO cert/key/identity value (masked/absent)."
    why_human: "Requires the 7 injected GitHub Actions secrets and a live CI run. If the Attest step fails with an OIDC/permissions error, the documented A4 follow-up is to add id-token:write + attestations:write to the publish job in release-please.yml (the caller)."
---

# Phase 1: Build Foundation — Setup Decomposition + Signed/Notarized Binaries Verification Report

**Phase Goal:** Release installs ship trustworthy, pre-built signed binaries with no `swiftc`/Xcode on the user's machine, and the install flow is decomposed into per-concern, individually testable scripts — the shared prerequisite that unblocks agent provisioning.
**Verified:** 2026-05-30T05:30:00Z
**Status:** human_needed
**Re-verification:** No — initial verification

## Goal Achievement

The phase decomposes into two halves: (1) the **decomposition + platform-abstraction + signing-code** half, which is fully achievable and verifiable in this environment, and (2) the **notarization + attestation end-to-end proof** half, which depends on real Apple Developer ID credentials, GitHub Actions secrets, a published release, and a clean second Mac — none of which can exist in the codebase. The code deliverables for all five success criteria are complete and substantive; SC-2 and SC-4 carry an irreducible human-verification tail by design (plan 06 is `autonomous: false` with a `checkpoint:human-verify` Task 3).

### Observable Truths

| #   | Truth (ROADMAP Success Criterion) | Status | Evidence |
| --- | --------------------------------- | ------ | -------- |
| 1 | SC-1: A release installs without Xcode/`swiftc` and capture/transcription/daemons run from pre-built binaries | ✓ VERIFIED | `install.sh:125` gates the `xcode-select -p` pre-flight inside `[[ "${TARGET_ARGS[0]}" == "--dev" ]]`; `setup_audio.sh` has a dev/release fork where `swiftc`/`build_audio_daemon.sh` appear ONLY in the `if [[ "$mode" == "dev" ]]` branch (line 60-86) and the release arm self-heals exec bits with no compiler. `test_release_no_swiftc.py` (6 tests pass) proves it both structurally AND behaviorally — a recording PATH shim confirms `setup_audio.sh release` invokes no swiftc/build script (sentinel stays empty). |
| 2 | SC-2: A notarized build passes `spctl -a -vvv` on a clean second machine | ⚠ HUMAN-NEEDED (code complete) | CI pipeline `packaging/scripts/sign_and_notarize.sh` performs ephemeral-keychain import + `ditto -c -k --keepParent` + `xcrun notarytool submit --wait` + `xcrun stapler staple`/`validate` of the `.app` DIRECTORIES (Pitfall-4 ordering: staple before zip). Bottom-up hardened-runtime signing verified in `build_*.sh`. The `spctl`/Gatekeeper acceptance on a clean Mac CANNOT be produced in this environment — requires real Developer ID + clean 2nd machine. Routed to human verification. |
| 3 | SC-3: Each former `setup.sh` concern runs as its own script under `set -uo pipefail`, isolated re-run | ✓ VERIFIED | Six `setup_*.sh` (deps/audio/models/capabilities/daemons/ui) + `lib/common.sh` all exist, declare `set -uo pipefail`, pass `bash -n`, source `lib/common.sh`, and end with the `[[ "${BASH_SOURCE[0]}" == "${0}" ]]` direct-invocation guard. `setup.sh` is a thin orchestrator sequencing all six (lines 895-919) with no inline concern bodies remaining. `test_setup_decomposition.py` (33 tests pass) asserts pipefail + hermetic isolation (no "unbound variable") + double-run idempotency. Live spot-check: `setup_deps.sh release` ran behind a no-op shim, exit 0, no unbound variable. |
| 4 | SC-4: A release asset verifies via `gh attestation verify` against Yulu's CI | ⚠ HUMAN-NEEDED (code complete) | `release-publish.yml` declares `id-token: write` + `attestations: write`, and mints `actions/attest-build-provenance@v4` with `subject-path dist/yulu-macos-arm64-${{ inputs.tag }}.zip`. YAML valid, permissions asserted. `gh attestation verify` against a published asset CANNOT run here — needs a real release + CI-minted provenance (and confirms RESEARCH Assumption A4). Routed to human verification. |
| 5 | SC-5: `platform/base.py` exposes platform ABCs with linux/windows raising `NotImplementedError` | ✓ VERIFIED | Package is `yulu_platform` (NOT `platform` — the verified shadow guard). `base.py` declares 4 ABCs (DaemonManager, PathResolver, PermissionModel, DependencyManager) with 10 `@abstractmethod`s + frozen `ServiceSpec`; no leaked macOS vocabulary in signatures. `linux/` + `windows/` arms override every method to raise `NotImplementedError("... v2 XPLAT-01")`. Live behavioral check: bare ABC raises `TypeError`, all 5 stub methods raise `NotImplementedError`, stdlib `platform.__file__` resolves to the system path (not shadowed). `test_yulu_platform_stubs.py` + `test_yulu_platform_no_shadow.py` (10 tests pass). |

**Score:** 5/5 must-haves verified — 3 fully automated (SC-1, SC-3, SC-5), 2 code-complete with credential-gated end-to-end proof routed to human (SC-2, SC-4).

### Required Artifacts

| Artifact | Expected | Status | Details |
| -------- | -------- | ------ | ------- |
| `yulu/scripts/yulu_platform/base.py` | 4 platform ABCs + ServiceSpec | ✓ VERIFIED | 99 lines, 10 abstractmethods, frozen ServiceSpec, no macOS vocab |
| `yulu/scripts/yulu_platform/{linux,windows}/__init__.py` | NotImplementedError arms | ✓ VERIFIED | Every method raises NotImplementedError; imports from base; live-confirmed |
| `yulu/scripts/yulu_platform/macos/__init__.py` | Empty placeholder (D-17) | ✓ VERIFIED | Docstring-only stub; Phase 2 fills it |
| `yulu/scripts/lib/common.sh` | Hoisted install_plist + stable launch_path + source-detection | ✓ VERIFIED | 194 lines; ONE canonical install_plist(); launch_path globs `*/bin` (no nvm literal); resolve_install_mode reads .yulu-install.json; all 5 plist tokens handled |
| `yulu/scripts/setup_{deps,models,ui,audio,capabilities,daemons}.sh` | 6 standalone concern scripts | ✓ VERIFIED | All exist, `set -uo pipefail`, `bash -n` clean, source common.sh, invocation guard; ui/daemons use hoisted install_plist (0 local redefs) |
| `yulu/scripts/setup.sh` | Thin orchestrator | ✓ VERIFIED | Sequences all 6 concerns (895-919); 0 inline concern bodies; swiftc only via setup_audio dev branch |
| `install.sh` | Xcode pre-flight --dev-gated | ✓ VERIFIED | `xcode-select -p` inside `[[ "${TARGET_ARGS[0]}" == "--dev" ]]` (line 125) |
| `yulu/scripts/{Yulu,StatusAgent}.app.entitlements` | Least-privilege entitlements | ✓ VERIFIED | plutil OK; Yulu=audio-input only (no screen-capture); StatusAgent=apple-events only; both committed |
| `yulu/scripts/build_{audio_daemon,status_agent}.sh` | Bottom-up hardened-runtime signing | ✓ VERIFIED | `--options runtime` + `--timestamp` + `--entitlements`; inner `$APP_BIN` before bundle `$APP`; no `--deep`/`--timestamp=none`; env-driven identity, no hardcoded creds |
| `packaging/scripts/sign_and_notarize.sh` | CI keychain/notarize/staple | ✓ VERIFIED (code) | notarytool submit --wait, ditto --keepParent, stapler staple+validate, set-key-partition-list; no secret literals; `set -x` only in a comment explaining it is NOT used |
| `.github/workflows/release-publish.yml` | permissions + attest + keychain teardown | ✓ VERIFIED (code) | id-token/attestations:write; attest-build-provenance@v4; --skip-build package step; if:always() delete-keychain |
| `.github/workflows/ci.yml` | bash -n loop + shellcheck step | ✓ VERIFIED | shellcheck step present; setup_capabilities.sh + lib/common.sh in bash -n loop; valid YAML; no step removed |
| `tests/test_*.py` (5 phase-1 tests) | Wave 0 scaffolds | ✓ VERIFIED | All 5 exist and pass (55 tests); substantive assertions (not hollow) |

### Key Link Verification

| From | To | Via | Status | Details |
| ---- | -- | --- | ------ | ------- |
| linux/__init__.py | base.py | `from yulu_platform.base import ...` | ✓ WIRED | Import present + classes subclass the ABCs |
| setup_deps.sh / setup_ui.sh | lib/common.sh | `. $SCRIPT_DIR/lib/common.sh` | ✓ WIRED | All 6 concern scripts source it |
| setup_ui.sh | install_plist | hoisted helper (no §8c dup) | ✓ WIRED | 0 local install_plist() defs; 6 call-sites |
| setup_daemons.sh | install_plist | hoisted helper | ✓ WIRED | 0 local defs; 14 references; seed steps preserved |
| build_audio_daemon.sh | Yulu.app.entitlements | `--entitlements $ENTITLEMENTS` | ✓ WIRED | Line 84-88 |
| build_status_agent.sh | StatusAgent.app.entitlements | `--entitlements $ENTITLEMENTS` | ✓ WIRED | Confirmed |
| setup_audio.sh | build_audio_daemon.sh | dev-branch only | ✓ WIRED | Line 63, inside `[[ "$mode" == "dev" ]]` |
| setup.sh | 6 concern scripts | sequenced `$mode` invocations | ✓ WIRED | Lines 895-919 (gsd-sdk regex false-negatived this; manually + grep-confirmed) |
| release-publish.yml | attest-build-provenance@v4 | subject-path release zip | ✓ WIRED | Present + permissions correct |
| sign_and_notarize.sh | Apple notary | `notarytool submit --wait` | ✓ WIRED | 2 submit calls, 3 --wait |

### Data-Flow Trace (Level 4)

Not applicable — this phase ships infrastructure (interface ABCs, bash install scripts, signing config, CI workflows). No artifact renders dynamic data from a DB/store/API. The `yulu_platform` ABCs are interface-only by design (D-15). Behavioral correctness is instead proven by the spot-checks and probe-style test runs below.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| -------- | ------- | ------ | ------ |
| Bare ABC uninstantiable | `DaemonManager()` | TypeError raised | ✓ PASS |
| Linux/Windows arms raise | `LinuxDaemonManager().load('x')` etc (5 methods) | all NotImplementedError | ✓ PASS |
| stdlib platform not shadowed | `import platform; platform.__file__` | resolves to system python3.14/platform.py | ✓ PASS |
| Concern script hermetic isolation | `setup_deps.sh release` behind no-op shim | exit 0, no unbound variable | ✓ PASS |
| D-05 verify-not-install | grep `find_spec('mlx_whisper')` in setup_capabilities.sh | present (line 45), 0 pip-install | ✓ PASS |
| D-02 venv removed | grep `venv-mlx-whisper` in setup_capabilities.sh | 0 matches | ✓ PASS |
| SC-1 test suite | `pytest tests/test_release_no_swiftc.py` | 6 passed | ✓ PASS |
| SC-3 test suite | `pytest tests/test_setup_decomposition.py` | 33 passed | ✓ PASS |
| SC-5 test suite | `pytest tests/test_yulu_platform_{stubs,no_shadow}.py` | 10 passed | ✓ PASS |
| Full regression | `make pytest` | 567 passed, 1 skipped | ✓ PASS |

### Probe Execution

No conventional `scripts/*/tests/probe-*.sh` probes are declared in this phase. The Wave 0 pytest scaffolds serve the equivalent runnable-check role and were executed in this verifier's own process (results above). The full suite (`make pytest`) was run end-to-end: **567 passed, 1 skipped** — exactly the expected baseline, confirming no regression.

### Requirements Coverage

| Requirement | Source Plan(s) | Description | Status | Evidence |
| ----------- | -------------- | ----------- | ------ | -------- |
| BUILD-01 | 01-01, 01-02, 01-04, 01-05 | Decompose monolithic setup.sh into per-concern `set -uo pipefail` scripts | ✓ SATISFIED | 6 setup_*.sh + lib/common.sh + thin orchestrator; test_setup_decomposition.py (33 pass) |
| BUILD-02 | 01-03 (sign), 01-06 (notarize) | Developer ID signed (bottom-up, no --deep) + notarized + stapled | ✓ SATISFIED (code) / ⚠ end-to-end human | Sign-side fully verified; clean-machine Gatekeeper proof = human (SC-2) |
| BUILD-03 | 01-04, 01-05 | Release ships pre-built signed binaries, no swiftc/Xcode | ✓ SATISFIED | dev/release fork + install.sh gate; test_release_no_swiftc.py (6 pass) |
| BUILD-04 | 01-06 | CI publishes Artifact Attestations, verifiable via gh attestation verify | ✓ SATISFIED (code) / ⚠ end-to-end human | attest-build-provenance@v4 wired; verify proof = human (SC-4) |

All 4 requirement IDs declared in PLAN frontmatter are accounted for and mapped to Phase 1 in REQUIREMENTS.md (all marked Complete). No orphaned requirements — no REQUIREMENTS.md entry maps to Phase 1 without a claiming plan.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| ---- | ---- | ------- | -------- | ------ |
| — | — | — | — | None. No TBD/FIXME/XXX debt markers, no TODO/HACK/PLACEHOLDER, no "not yet implemented"/"coming soon" phrases across all 27 phase-modified files. |

The `NotImplementedError` raises in `linux/__init__.py` and `windows/__init__.py` are the **intended deliverable** per D-15 / XPLAT-01 (deferred to v2), not stub smell — they are fail-loud, carry explicit "v2 XPLAT-01" messages, and are asserted by tests. The single `set -x` token in `sign_and_notarize.sh` is inside a comment explicitly stating `set -x` is deliberately NOT used (D-08 secret hygiene) — verified not active code; the D-08 secret-leak grep returned 0 matches.

### Human Verification Required

Two ROADMAP success criteria (SC-2, SC-4) plus the release-publish dry-run are credential-and-hardware-gated. They are **not missing work** — the code deliverables are complete and statically validated; they are work that can only be proven by a human with Apple Developer ID credentials, the 7 injected GitHub Actions secrets, a published release, and a clean second Mac.

#### 1. Notarized build passes `spctl` on a clean Mac (SC-2 / BUILD-02)

**Test:** On a second Mac that never trusted the dev cert, download the published release zip, unzip, then run:
```bash
spctl -a -vvv -t exec Yulu.app          # expect: accepted … source=Notarized Developer ID (no warning, no xattr strip)
xcrun stapler validate Yulu.app         # expect: The validate action worked!
spctl -a -vvv -t exec StatusAgent.app   # same expectation
xcrun stapler validate StatusAgent.app  # The validate action worked!
```
**Expected:** Both bundles accepted as Notarized Developer ID with no Gatekeeper warning and no quarantine strip.
**Why human:** Requires a real Developer ID signing run + a clean physical Mac; Gatekeeper assessment cannot be faked or run in CI.

#### 2. Release asset verifies via `gh attestation verify` (SC-4 / BUILD-04)

**Test:** `gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu`
**Expected:** Verified provenance against Yulu's CI.
**Why human:** Requires a published release asset with CI-minted SLSA provenance (and confirms RESEARCH Assumption A4 — reusable-workflow OIDC inheritance).

#### 3. Release-publish dry-run (notarytool Accepted + attest + keychain teardown + log secret-scan)

**Test:** Inject the 7 GitHub Actions secrets (YULU_CODESIGN_IDENTITY, YULU_CODESIGN_P12_BASE64, P12_PWD, KEYCHAIN_PWD, ASC_KEY_P8_BASE64, ASC_KEY_ID, ASC_ISSUER_ID), then trigger a pre-release tag.
**Expected:** Sign-and-notarize step reaches notarytool `status: Accepted`; Attest step succeeds (A4 OIDC confirmed); `if: always()` Clean-up signing keychain step runs; run logs contain NO secret value.
**Why human:** Requires injected secrets + a live CI run. If Attest fails with an OIDC/permissions error, the documented A4 follow-up is to add `id-token: write` + `attestations: write` to the publish job in `release-please.yml` (the caller).

### Gaps Summary

**No gaps.** Every code deliverable for all five success criteria exists, is substantive (not a stub), is wired, and — for the automatable three (SC-1, SC-3, SC-5) — is proven by passing behavioral tests (49 phase-specific tests + a clean full-suite run of 567 passed / 1 skipped). All four requirement IDs (BUILD-01..04) are covered.

The only outstanding items are the **end-to-end proofs for SC-2 and SC-4**, which are credential-and-hardware-gated and impossible to produce in this environment by design (plan 06 is `autonomous: false`, Task 3 is a `checkpoint:human-verify` gate). These are surfaced as `human_needed` rather than `gaps_found` — per the verification instructions and the Step 9 decision tree, the presence of human-verification items makes the overall status `human_needed` even though all automatable truths are VERIFIED.

One note on tooling: the `gsd-sdk query verify.key-links` matcher reported a false-negative FAIL for plan 01-05's setup.sh→concern-scripts link (its `setup_.*\\.sh` regex did not match the multi-target `to:` field). Manual + grep verification confirms setup.sh genuinely invokes all six concern scripts at lines 895-919 — the link is WIRED. This is a matcher artifact, not a real gap.

---

_Verified: 2026-05-30T05:30:00Z_
_Verifier: Claude (gsd-verifier)_
