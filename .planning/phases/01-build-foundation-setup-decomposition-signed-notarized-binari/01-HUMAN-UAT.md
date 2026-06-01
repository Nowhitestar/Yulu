---
status: partial
phase: 01-build-foundation-setup-decomposition-signed-notarized-binari
source: [01-VERIFICATION.md]
started: 2026-05-30T05:10:06Z
updated: 2026-05-30T05:10:06Z
---

## Current Test

[awaiting human testing — requires Apple Developer ID secrets injected into GitHub Actions + a clean second Mac. Code deliverables are complete and verified; these are credential-gated end-to-end proofs.]

## Prerequisite — inject 7 GitHub Actions secrets (Lewis only)

Before the CI signing path can run, add these repo secrets (Settings → Secrets and variables → Actions). Values come from your Apple Developer ID — NEVER commit them (D-08):

1. `YULU_CODESIGN_IDENTITY` — `Developer ID Application: <name> (<TEAMID>)`
2. `YULU_CODESIGN_P12_BASE64` — base64 of the Developer ID Application cert `.p12`
3. `P12_PWD` — the `.p12` export password
4. `KEYCHAIN_PWD` — any ephemeral keychain password
5. `ASC_KEY_P8_BASE64` — base64 of the App Store Connect API key `.p8`
6. `ASC_KEY_ID` — the API Key ID
7. `ASC_ISSUER_ID` — the API Issuer ID

## Tests

### 1. SC-2 — Notarized build passes Gatekeeper on a clean second Mac
expected: After a signed release, on a Mac that never trusted the dev cert: `spctl -a -vvv Yulu.app` → `accepted ... source=Notarized Developer ID`; `xcrun stapler validate Yulu.app` → validate worked; app launches with no Gatekeeper prompt and no `xattr` quarantine strip needed
result: [pending]

### 2. SC-4 — Release asset verifies via gh attestation
expected: `gh attestation verify dist/yulu-macos-arm64-vX.Y.Z.zip --repo Nowhitestar/Yulu` → verified provenance against Yulu's CI
result: [pending]

### 3. Release-publish CI dry-run (end-to-end signing path + Assumption A4)
expected: A real release-publish run shows notarytool `Accepted`; the `attest-build-provenance@v4` step succeeds — this confirms RESEARCH Assumption A4 (reusable-workflow OIDC inheritance). **If it fails at the Attest step with an OIDC/permissions error, the fix is one line per scope: add `id-token: write` + `attestations: write` to `release-please.yml`'s publish job.** The `if:always()` keychain-teardown step ran; the run log contains no echoed secret values.
result: [pending]

## Summary

total: 3
passed: 0
issues: 0
pending: 3
skipped: 0
blocked: 0

## Gaps

None — these are credential-gated proofs of complete, verified code, not missing work. Full CI pipeline detail in `01-06-SUMMARY.md`. The signed-zip + checksums path remains a working fallback when `gh`/attestation is absent.
