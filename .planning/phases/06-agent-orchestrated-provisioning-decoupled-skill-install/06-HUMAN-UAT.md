---
status: partial
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
source: [06-VERIFICATION.md]
started: 2026-05-30T07:30:00Z
updated: 2026-05-30T07:30:00Z
---

## Current Test

[awaiting human testing — requires a published signed Yulu release asset + `gh auth`. The attestation gate is fully unit-proven against mocked gh + corrupted fixtures (760 pytest pass); these are the only checks pytest cannot fake. The checksum floor is the non-negotiable fallback regardless.]

## Tests

### 1. Live gh attestation verify of a published signed release zip (PROV-03)
expected: After a signed Phase-1 release exists and `gh auth login` is done — `gh attestation verify dist/yulu-macos-arm64-vX.Y.Z.zip --repo Nowhitestar/Yulu` → exit 0; `yulu provision --all --asset <zip> --checksums <checksums.txt>` passes the gate ("attestation"). With NO gh auth → it falls to the SHA-256 checksum floor (not a rejection). A tampered zip → TamperError before any step runs.
result: [pending]

### 2. --signer-workflow strictness (RESEARCH A1/Q2)
expected: Confirm whether `gh attestation verify` should pin `--signer-workflow .github/workflows/release-publish.yml` (or `--signer-repo`) in addition to `--repo`, so an attestation minted by a DIFFERENT workflow is rejected. Ships today with `--repo` alone (shape-correct); this is a documented one-line argv hardening decided by the live result.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps

None — code-complete; the gh-auth ladder + tamper rejection + checksum floor are all unit-proven with mocks. These 2 are real-asset/real-auth confirmations only. Detail in 06-03-SUMMARY.md "Pending Human Verification".
