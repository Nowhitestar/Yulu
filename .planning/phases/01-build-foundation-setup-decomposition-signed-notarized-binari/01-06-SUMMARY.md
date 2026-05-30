---
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
plan: 06
subsystem: infra
tags: [ci, codesign, notarization, stapling, attestation, keychain, shellcheck, release-publish, build-04, build-02]

# Dependency graph
requires:
  - phase: 01-plan-03
    provides: "build_audio_daemon.sh / build_status_agent.sh — bottom-up hardened-runtime Developer ID signing (-o runtime + --entitlements + --timestamp, never --deep); Yulu.app.entitlements (audio-input), StatusAgent.app.entitlements (apple-events); package.sh ALLOWED_BUILD_OUTPUTS incl. _CodeSignature/CodeResources"
  - phase: 01-plan-02
    provides: "lib/common.sh + the decomposed setup_*.sh concern scripts now covered by the CI bash -n + shellcheck gates"
  - phase: 01-plan-05
    provides: "setup.sh thin orchestrator — also gated by the extended bash -n / shellcheck steps"
provides:
  - "packaging/scripts/sign_and_notarize.sh — CI-only: ephemeral-keychain import, build+bottom-up sign via build_*.sh, ditto zip, notarytool submit --wait (App Store Connect API key), stapler staple+validate the .app DIRECTORIES before packaging (Pitfall 4)"
  - ".github/workflows/release-publish.yml — id-token/attestations: write permissions; Sign-and-notarize step (7 secrets by NAME, D-08); package step uses --skip-build so the staple survives; attest-build-provenance@v4 on the release zip (BUILD-04); always-run keychain teardown (T-01-19)"
  - ".github/workflows/ci.yml — bash -n loop extended to the six setup_*.sh + lib/common.sh + sign_and_notarize.sh; new ShellCheck step (shellcheck -x -P SCRIPTDIR) over setup/lib/build/sign scripts (BUILD-01 static gate)"
  - "Makefile — package target forwards PACKAGE_ARGS so CI can pass --skip-build (default empty: plain `make package TAG=...` unchanged)"
affects: [phase-06-attestation-gate, phase-07-release-ops]

# Tech tracking
tech-stack:
  added: []  # no language packages; first-party Apple tools (codesign/notarytool/stapler/ditto/security) + actions/attest-build-provenance@v4 (already pinned-style)
  patterns:
    - "CI signing helper isolation: sign_and_notarize.sh encapsulates keychain + ditto + notarytool --wait + staple so release-publish.yml stays readable; it runs build_*.sh (single source of signing truth) and is the only place the App Store Connect key is decoded"
    - "Pitfall-4 ordering enforced by step sequence: sign+notarize+STAPLE the .app dirs -> THEN `make package PACKAGE_ARGS=--skip-build` zips the already-stapled bundles (no rebuild, no staple strip) -> THEN attest the zip"
    - "D-08 secret hygiene: all 7 credentials passed env-by-name (${{ secrets.* }}); helper uses set -euo pipefail (never set -x), require_env prints only the variable NAME, secrets decode to $RUNNER_TEMP files; an if:always() step deletes the keychain + decoded cert/key even on failure"
    - "shellcheck SC1091 resolution: -P SCRIPTDIR makes shellcheck resolve the runtime-computed `$SCRIPT_DIR/lib/common.sh` source relative to each script's own dir, so the new gate is green (exit 0) without editing the concern scripts"
    - "--skip-build doubles as the clean-worktree bypass: signing/stapling intentionally mutates the allowlisted bundle bytes (Mach-O, Info.plist, _CodeSignature/CodeResources); --skip-build skips both check_clean_worktree calls AND the rebuild in one flag"

key-files:
  created:
    - packaging/scripts/sign_and_notarize.sh
  modified:
    - .github/workflows/release-publish.yml
    - .github/workflows/ci.yml
    - Makefile

key-decisions:
  - "Makefile package target forwards $(PACKAGE_ARGS) (default empty) rather than hardcoding --skip-build: keeps `make package TAG=...` byte-identical for dev/local, while CI opts into --skip-build. The make target structurally could not forward the flag the plan requires (Rule 3 fix)."
  - "Keychain teardown lives in release-publish.yml's if:always() step, not in sign_and_notarize.sh, so cleanup runs even when the helper fails mid-notarization (Pattern 3 + T-01-19)."
  - "Did NOT edit release-please.yml (D-09 hard constraint). The publish job's permissions (id-token/attestations: write) are declared on the CALLED workflow (release-publish.yml); whether the reusable workflow actually inherits/mints the OIDC token is RESEARCH Assumption A4 — flagged for the human dry-run, NOT claimed verified."

metrics:
  duration_min: 7
  tasks_completed: 2  # of 3 (Task 3 is a blocking-human checkpoint deferred to human verification)
  files_changed: 4
  completed: 2026-05-30
---

# Phase 1 Plan 6: CI Sign + Notarize + Staple + Attest Summary

CI is now the sole producer of trustworthy release binaries: an ephemeral-keychain Developer ID import, bottom-up hardened-runtime signing (via the plan-03 build scripts), `notarytool submit --wait` with App Store Connect API-key auth, `stapler staple` of the `.app` directories before packaging, and a `actions/attest-build-provenance@v4` SLSA attestation on the release zip — with the keychain torn down in an always-run step and zero secret values committed. The decomposed `setup_*.sh` + `lib/common.sh` are now covered by the CI `bash -n` loops and a new `shellcheck -x -P SCRIPTDIR` gate (BUILD-01). This completes the autonomously-buildable scope of BUILD-02 (notarize+staple) and BUILD-04 (attestation); the end-to-end proof (real notarization, clean-machine Gatekeeper, `gh attestation verify`, A4 OIDC inheritance) is the deferred human checkpoint below.

## What Was Built

### Task 1 — `sign_and_notarize.sh` + release-publish.yml wiring (commit `f0e9eb2`)
- **`packaging/scripts/sign_and_notarize.sh`** (new, `set -euo pipefail`, executable):
  - **Keychain import (Pattern 3):** decode `YULU_CODESIGN_P12_BASE64` → `$RUNNER_TEMP/cert.p12`; `security create-keychain` / `set-keychain-settings -lut 21600` (no auto-lock during the notarization wait) / `unlock-keychain` / `import -T /usr/bin/codesign` / `set-key-partition-list -S apple-tool:,apple:,codesign:` (avoids `errSecInternalComponent`) / prepend to the user keychain search list.
  - **Build + sign:** runs `build_audio_daemon.sh` + `build_status_agent.sh` (they read `YULU_CODESIGN_IDENTITY` and sign bottom-up with `-o runtime --entitlements --timestamp` — plan 03).
  - **Notarize + staple (Pattern 2 / Pitfall 4):** per bundle — `ditto -c -k --keepParent` to a throwaway zip, `xcrun notarytool submit --wait` (`--key`/`--key-id`/`--issuer` from the decoded `.p8` + IDs), then `xcrun stapler staple` + `stapler validate` the **`.app` directory** (not the zip). `require_env` guards all 7 secrets and prints only the variable *name* on failure.
- **`.github/workflows/release-publish.yml`:**
  - `permissions:` extended with `id-token: write` + `attestations: write` (kept `contents: write`).
  - New **Sign-and-notarize** step: 7 secrets via `env:` by name (`YULU_CODESIGN_IDENTITY`, `YULU_CODESIGN_P12_BASE64`, `P12_PWD`, `KEYCHAIN_PWD`, `ASC_KEY_P8_BASE64`, `ASC_KEY_ID`, `ASC_ISSUER_ID`), runs `bash packaging/scripts/sign_and_notarize.sh` — placed **before** packaging.
  - **Package** step now runs `make package TAG="$TAG" PACKAGE_ARGS=--skip-build` (no rebuild → staple survives; also bypasses `check_clean_worktree` since signing legitimately dirties allowlisted bundle bytes), then `make checksums`.
  - New **Attest** step after checksums: `actions/attest-build-provenance@v4` with `subject-path: dist/yulu-macos-arm64-${{ inputs.tag }}.zip` (BUILD-04).
  - New **Clean up signing keychain** step, `if: always()`: `security delete-keychain` + `rm -f` the decoded cert/key/notarize-zips (each `|| true` so cleanup never masks the job result).
- **`Makefile`:** `package` target appends `$(PACKAGE_ARGS)` (default empty).

### Task 2 — CI bash -n + shellcheck gates (commit `b184d31`)
- **`ci.yml`** + **`release-publish.yml`** bash -n loops extended to add `packaging/scripts/sign_and_notarize.sh`, `setup_deps.sh`, `setup_audio.sh`, `setup_models.sh`, `setup_capabilities.sh`, `setup_daemons.sh`, `setup_ui.sh`, `lib/common.sh` (existing entries kept).
- **`ci.yml`** new **ShellCheck** step: `shellcheck -x -P SCRIPTDIR` over the six `setup_*.sh`, `setup.sh`, `lib/common.sh`, both `build_*.sh`, and `sign_and_notarize.sh`. `-P SCRIPTDIR` resolves the runtime `$SCRIPT_DIR/lib/common.sh` source so SC1091 does not fail the gate. No existing CI step removed.

## Verification Performed (autonomous / static)

| Check | Result |
|-------|--------|
| `bash -n packaging/scripts/sign_and_notarize.sh` | pass |
| `shellcheck -x` on sign_and_notarize.sh | clean (SC2153 suppressed with a targeted directive — `ASC_KEY_ID`/`ASC_ISSUER_ID` are env-from-secrets, not typos) |
| `shellcheck -x -P SCRIPTDIR` over all gated scripts (the exact new CI gate) | **exit 0, zero warnings** |
| YAML parse of ci.yml + release-publish.yml | both valid; all prior steps (pytest, py_compile, swift build) preserved |
| permissions assert (`id-token==write && attestations==write`) | pass |
| greps: `attest-build-provenance@v4`, `notarytool submit`, `stapler staple`, `security delete-keychain` | all present |
| **D-08 secret-value leak grep** across all 4 modified files | **no matches** (no PEM blocks, no `Developer ID Application: <name>` literal) |
| `set -x` directive scan | none (only explanatory comment mentions) |
| `--skip-build` skips both `check_clean_worktree` calls + the rebuild | confirmed via package.sh AST check |
| Full `pytest -q` | **567 passed, 1 skipped** (identical to pre-plan baseline — no regression) |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Makefile `package` target could not forward `--skip-build`**
- **Found during:** Task 1 (wiring the package step).
- **Issue:** The plan requires `make package` to run with `--skip-build`, but `make package` hardcoded `bash packaging/scripts/package.sh "$(TAG)"` with no arg passthrough — the required flag could not reach package.sh.
- **Fix:** Added `$(PACKAGE_ARGS)` (default empty) to the target; CI passes `PACKAGE_ARGS=--skip-build`. Plain `make package TAG=...` is byte-identical for everyone else.
- **Files modified:** `Makefile`. **Commit:** `f0e9eb2`.

**2. [Rule 3 - Blocking] New shellcheck gate failed (SC1091) on the decomposed scripts**
- **Found during:** Task 2 (running the gate locally before committing).
- **Issue:** `shellcheck -x` exited 1 with SC1091 ("Not following: lib/common.sh") for all six `setup_*.sh` — shellcheck cannot resolve the runtime-computed `$SCRIPT_DIR/lib/common.sh` source path. The gate I was *adding* would have turned CI red on legitimate scripts.
- **Fix:** Added `-P SCRIPTDIR` to the shellcheck invocation — shellcheck's built-in token that resolves the source-search-path relative to each checked file's own directory, CWD-independent. Gate now exits 0 with zero warnings. The concern scripts were NOT edited.
- **Files modified:** `.github/workflows/ci.yml`. **Commit:** `b184d31`.

**3. [shellcheck] SC2153 false positive on `ASC_KEY_ID`**
- **Found during:** Task 1 (shellcheck of sign_and_notarize.sh).
- **Issue:** shellcheck flagged `ASC_KEY_ID` as a possible misspelling of `ASC_KEY_P8` (it cannot see the env-from-secret assignment).
- **Fix:** Added a scoped `# shellcheck disable=SC2153` above the `notarytool submit` call with a comment explaining both are env vars from secrets. Not a code change to behavior.
- **Files modified:** `packaging/scripts/sign_and_notarize.sh`. **Commit:** `f0e9eb2`.

> No architectural (Rule 4) changes. release-please.yml was deliberately NOT touched (D-09).

## A4 Risk Note (flagged, NOT resolved — by design)

`release-publish.yml` is a reusable `workflow_call` invoked by `release-please.yml`, whose `publish` job currently grants only `permissions: contents: write` to the called workflow. The `id-token: write` + `attestations: write` scopes are declared on the **called** job (correct per the plan), but whether GitHub actually mints the OIDC token for the attestation under reusable-workflow permission inheritance — without also widening the caller's `permissions:` block — is **RESEARCH Assumption A4** and can only be proven by a real run. Per D-09 I did not modify release-please.yml. **If the first signed release fails at the Attest step with an OIDC/permissions error**, the minimal follow-up is to add `id-token: write` + `attestations: write` to the `publish` job's `permissions:` in `release-please.yml` (the caller) — a one-line-per-scope change that the human can apply after the dry-run confirms it is needed.

---

## Pending Human Verification / user_setup (Task 3 — blocking-human checkpoint, DEFERRED)

Task 3 is a `checkpoint:human-verify` (`gate="blocking-human"`). It requires a real Apple Developer ID signing run, GitHub Actions secrets that only Lewis can inject, and a clean second Mac — **none of which can be performed in this environment.** All committable CI code/config is done and statically validated. The remaining proof is routed to human verification (the verifier should classify this as `human_needed`, which is correct).

### Step 1 — Inject the 7 GitHub Actions repository secrets (REQUIRED before any signed release)

`GitHub repo → Settings → Secrets and variables → Actions → New repository secret`. Add all seven (never commit them):

| Secret name | What to put in it |
|-------------|-------------------|
| `YULU_CODESIGN_IDENTITY` | The exact `Developer ID Application: <name> (<TeamID>)` string from your Apple Developer account |
| `YULU_CODESIGN_P12_BASE64` | `base64 -i DeveloperIDApplication.p12` of the exported Developer ID Application certificate (`.p12`) |
| `P12_PWD` | The password set when exporting the `.p12` |
| `KEYCHAIN_PWD` | Any strong password for the ephemeral CI keychain (you choose it) |
| `ASC_KEY_P8_BASE64` | `base64 -i AuthKey_XXXX.p8` of the App Store Connect API key (`.p8`, from App Store Connect → Users and Access → Keys) |
| `ASC_KEY_ID` | The Key ID shown next to that API key in App Store Connect |
| `ASC_ISSUER_ID` | The Issuer ID shown on the App Store Connect Keys page |

> macOS base64 has no line wrapping by default; if your platform wraps, use `base64 -w0` (GNU) so the secret is a single line.

### Step 2 — Trigger a release-publish dry-run and confirm CI

1. Cut a pre-release tag via the manual escape hatch (`release.yml` on a `v*.*.*` tag), or merge a Release PR.
2. In the run: the **Sign and notarize bundles** step must reach `status: Accepted` from notarytool, and the **Attest release zip provenance** step must succeed (this is the A4 confirmation — OIDC token minted in the reusable workflow with no permissions error). If Attest fails with an OIDC/permissions error, apply the A4 follow-up above.
3. Confirm the **Clean up signing keychain** step ran (it is `if: always()`).

### Step 3 — Clean-machine Gatekeeper (SC-2) — on a second Mac that never trusted the dev cert

```bash
# download + unzip the published dist/yulu-macos-arm64-<tag>.zip, then:
spctl -a -vvv -t exec Yulu.app          # expect: accepted … source=Notarized Developer ID  (NO Gatekeeper warning, NO xattr strip)
xcrun stapler validate Yulu.app         # expect: The validate action worked!
spctl -a -vvv -t exec StatusAgent.app   # same expectation
xcrun stapler validate StatusAgent.app  # The validate action worked!
```

### Step 4 — Attestation verify (SC-4)

```bash
gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu   # expect: verified provenance against Yulu's CI
```

### Step 5 — Log secret-scan (D-08)

Open the workflow run logs and confirm NO cert/key/identity value appears (they must be masked/absent). The Sign-and-notarize step should show only the descriptive `echo` lines, never a decoded secret.

### Resume signal

Reply `approved` once Steps 2–5 all pass, or report which check failed (notarization rejection, Gatekeeper warning, attestation-verify failure, OIDC-permission error → apply the A4 follow-up, or a leaked secret).

---

## Requirements Status

- **BUILD-02** (sign + notarize + staple): signing was delivered in plan 03; this plan delivers the **notarize + staple half in CI**. Autonomously complete & statically validated; clean-machine Gatekeeper proof (SC-2) is the deferred human step.
- **BUILD-04** (attestation): CI mints `actions/attest-build-provenance@v4` on the release zip. Autonomously complete; `gh attestation verify` proof (SC-4) is the deferred human step.
- **D-06** (notarytool + App Store Connect API key), **D-08** (secrets only in CI, ephemeral keychain torn down), **D-09** (sign+notarize+staple in CI, release-please unchanged): all satisfied in code.
- **BUILD-01** CI gate: decomposed scripts now `bash -n` + `shellcheck` covered.

## Self-Check: PASSED

- Created files exist: `packaging/scripts/sign_and_notarize.sh`, `01-06-SUMMARY.md`.
- Modified files exist: `release-publish.yml`, `ci.yml`, `Makefile`.
- Commits exist: `f0e9eb2` (Task 1), `b184d31` (Task 2).
