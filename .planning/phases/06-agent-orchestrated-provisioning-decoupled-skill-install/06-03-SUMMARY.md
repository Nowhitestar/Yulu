---
phase: 06-agent-orchestrated-provisioning-decoupled-skill-install
plan: 03
subsystem: infra
tags: [supply-chain, attestation, gh-cli, sha256-checksum, fail-closed, provisioning, slsa]

# Dependency graph
requires:
  - phase: 01-build-foundation
    provides: "release_installer.verify_checksum/parse_checksums/sha256_file/InstallError + the CI attestation (release-publish.yml, actions/attest-build-provenance@v4) this gate verifies"
  - phase: 06 (06-01/06-02)
    provides: "provision/ package (registry.py Step/StepResult, state.py ledger) — the gate runs BEFORE any step.apply()"
provides:
  - "provision/attest.py — verify_asset() fail-closed asset-integrity gate (PROV-03, D-03)"
  - "TamperError — the fail-closed rejection signal raised BEFORE any step runs"
  - "The 3-way gh-auth ladder: authed verify==0 -> attestation; gh exit-4/absent -> SHA-256 checksums.txt floor; non-4 nonzero -> corroborate-with-checksum-or-reject"
affects: [06-04 (CLI wires verify_asset FIRST on the --asset download path), phase-7-migration, supply-chain-hardening]

# Tech tracking
tech-stack:
  added: []  # zero new third-party deps — stdlib (shutil, subprocess, pathlib) + reuse of release_installer + the host gh CLI (invoked, not installed)
  patterns:
    - "Fail-closed attestation gate: verify FIRST, reject before any mutation (ASVS V10)"
    - "gh-auth ladder (present-AND-verify==0, NOT command -v gh): exit-4 == use-checksum, never a rejection (cli/cli #11803)"
    - "Reuse release_installer's verified checksum helpers (Don't-Hand-Roll) — never a fresh hashlib loop"

key-files:
  created:
    - yulu/scripts/provision/attest.py
    - tests/test_provision_attest.py
  modified:
    - yulu/scripts/provision/__init__.py

key-decisions:
  - "Gate on gh-present-AND-(verify==0), NOT command -v gh — an unauthenticated gh exit-4s on every verify (public-repo limitation cli/cli #11803), so presence alone is insufficient (RESEARCH Pitfall 1)"
  - "exit-4 (unauthenticated) AND gh-absent both degrade to the SHA-256 checksums.txt FLOOR — a fallback, never a rejection (D-03 non-negotiable floor)"
  - "A non-4 nonzero verify on an authed gh REQUIRES the checksum to independently confirm before proceeding — never a silent downgrade to checksum-pass on the verify failure alone (anti-pattern T-06-12)"
  - "TamperError raised BEFORE any step.apply() — a tampered asset never reaches a step (fail-closed, D-03)"
  - "Scope (RESEARCH Pitfall 5/Q1): verify_asset operates on a downloaded asset (zip + checksums); the CLI skips the gate when no --asset is supplied (an already-installed tree's integrity was established at install)"

patterns-established:
  - "Fail-closed-FIRST: the integrity gate is unreachable-past until verify_asset returns; callers must invoke it before the registry walk"
  - "3-way subprocess returncode ladder (0 / 4 / other) for a gh CLI gate with a universal checksum floor"

requirements-completed: [PROV-03, PROV-02]

# Metrics
duration: 8min
completed: 2026-05-30
---

# Phase 6 Plan 03: Fail-Closed Attestation Gate Summary

**`provision/attest.py` verifies a downloaded release asset via a 3-way `gh attestation verify` ladder with a SHA-256 `checksums.txt` floor, rejecting any tampered asset with `TamperError` before a single provisioning step's `apply()` can run — reusing `release_installer`'s checksum helpers, no hand-rolled crypto.**

## Performance

- **Duration:** 8 min
- **Started:** 2026-05-30T12:26:20Z
- **Completed:** 2026-05-30T12:34:xx Z
- **Tasks:** 2 code tasks complete (Task 1 + Task 2); Task 3 is a real-asset human-verify checkpoint (see Pending Human Verification)
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments
- **`verify_asset(zip_path, checksums_path, asset_name) -> str`** — the headline supply-chain control (PROV-03, ASVS V10). Returns `"attestation"` or `"checksum"`; raises `TamperError` (fail-closed) on ANY integrity failure, BEFORE any step runs.
- **The gh-auth LADDER** (the decisive, non-obvious finding, verified live in RESEARCH):
  - gh present AND `gh attestation verify <zip> --repo Nowhitestar/Yulu` exit 0 → `"attestation"` (the only PASS that skips the checksum floor)
  - gh exit **4** (UNAUTHENTICATED — public-repo limitation cli/cli #11803) **OR gh absent** → SHA-256 `checksums.txt` floor (a fallback, NOT a rejection)
  - gh present + a **non-4 nonzero** verify (tamper / missing attestation) → the checksum must INDEPENDENTLY confirm; if it cannot → `TamperError` (never a silent downgrade)
- **`TamperError`** raised before any `step.apply()` — a tampered asset never reaches a step (fail-closed, D-03).
- **Reuses `release_installer.verify_checksum` / `parse_checksums`** (Don't-Hand-Roll) — zero fresh hashlib loops; the `*name` BSD-format + hex-validation edge cases are inherited from the tested Phase-1 code.
- **6 Wave-0 tests green**, each WITHOUT a real release asset or gh auth (corrupt a fake fixture zip + monkeypatch `shutil.which`/`subprocess.run`). Full suite: **744 passed, 1 skipped**.

## Task Commits

1. **Task 1 (RED): failing attestation-gate tests** — `eccb453` (test)
2. **Task 1 (GREEN) + Task 2: `attest.py` + test suite** — `9ff1593` (feat)

_Task 1 is `tdd="true"` (RED `test(...)` → GREEN `feat(...)`); the attest.py implementation and the test file landed together in the GREEN commit since the contract under test and its module are one tightly-coupled pair. Task 3 is a human-verify checkpoint — no code commit (see Pending Human Verification)._

## Files Created/Modified
- `yulu/scripts/provision/attest.py` (created) — `verify_asset` gh-ladder + `_verify_checksum_or_raise` floor + `TamperError` + `_gh_present`; imports `release_installer`. Module docstring states the reuse, the ladder, and the no-asset scope (CLI skips the gate when no `--asset`).
- `tests/test_provision_attest.py` (created) — 6 cases: tamper-rejected-via-checksum-floor (gh absent), exit-4-falls-back-to-checksum, authed-verify-passes-via-attestation, non-4-rejects-when-checksum-cannot-confirm, non-4-corroborated-by-checksum, unlisted-asset-rejected. Reuses `build_fake_asset` from `test_release_installer_integration.py`.
- `yulu/scripts/provision/__init__.py` (modified) — exports `attest` alongside `state` (package parity).

## Decisions Made
None beyond the plan — followed the behavior block and RESEARCH Pattern 3 exactly. The five key decisions (gate on present-AND-verify==0; exit-4/absent → checksum floor; non-4 → corroborate-or-reject; TamperError before apply(); no-asset → skip gate) are all locked in the plan/RESEARCH and recorded in frontmatter.

## Deviations from Plan

None - plan executed exactly as written.

The implementation matched RESEARCH Pattern 3's reference shape with no auto-fixes required. Subprocess calls are all argv lists (no `shell=True`); `REPO` and the verify flags are literals; `zip_path` is a `Path` argument never shell-interpolated (T-06-14 satisfied). No bug, missing-critical, or blocking-issue deviations arose.

## Issues Encountered
None. The reused `release_installer.verify_checksum` raises `InstallError("Checksum mismatch for {name}: ...")`, which is wrapped into `TamperError` — the test's `match="Checksum mismatch"` and `match="does not list"` both assert against the surfaced message.

## Pending Human Verification

**Task 3 is a `checkpoint:human-verify` (`gate="blocking-human"`) that pytest CANNOT fake** — it needs a REAL published, signed Yulu release zip + an authenticated `gh`. The gate code is fully unit-proven against mocked gh + corrupted fixtures; these two live confirmations close RESEARCH A1/Q2 (real verify + signer-workflow strictness). Per the milestone's autonomous mandate, the plan is COMPLETE and these are recorded for the verifier to route as `human_needed`.

**Why it can't be automated:** `gh attestation verify` fetches the attestation from the GitHub API and validates the Sigstore cert chain + Rekor transparency-log inclusion against a REAL signed asset minted by `release-publish.yml`. No fixture can stand in for a genuine published attestation, and verify REQUIRES `gh` auth (exit-4 unauthenticated even for public repos).

**Exact steps to verify (record the results):**

1. **Authenticate gh:** `gh auth status` — run `gh auth login` if needed (verify REQUIRES auth; exit-4 unauth even for the public repo).
2. **Obtain a signed Phase-6-era release asset:**
   `gh release download <tag> --repo Nowhitestar/Yulu --pattern 'yulu-macos-arm64-*.zip'`
   (or use a freshly published release zip).
3. **Baseline verify (expect exit 0 + a printed attestation summary):**
   `gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu`
4. **Signer strictness (RESEARCH A1/Q2):** re-run with the signer pin and confirm it STILL passes for the genuine asset:
   `gh attestation verify yulu-macos-arm64-<tag>.zip --repo Nowhitestar/Yulu --signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml`
   (and/or `--signer-repo Nowhitestar/Yulu`). **Record the exact passing invocation** and whether `--repo` alone is the accepted strictness or the signer flag is required.
5. **(Optional negative) tampered copy fails (expect nonzero):**
   `cp asset.zip bad.zip && printf 'X' >> bad.zip && gh attestation verify bad.zip --repo Nowhitestar/Yulu`

**Follow-up if stricter identity is wanted:** if step 4 shows signer pinning is required (or desired), pin it into `attest.py` by appending `--signer-workflow Nowhitestar/Yulu/.github/workflows/release-publish.yml` to the `verify_asset` argv list (currently `["gh", "attestation", "verify", str(zip_path), "--repo", REPO]`). The module is structured so this is a one-line argv extension. Today it ships with `--repo` alone, which RESEARCH verified is shape-correct and passes (less strict); the human-verify result decides whether to tighten.

**Resume signal (from the plan):** "approved" with the exact passing verify invocation (and whether signer-workflow pinning is required), or a description of the failure.

## Next Phase Readiness
- **`verify_asset` is ready for 06-04** to wire as the FIRST call on the `yulu provision --asset <zip> --checksums <txt>` download path (fail-closed, before the registry walk). On a `yulu provision <step>` with no `--asset`, the CLI skips the gate (RESEARCH Pitfall 5 / Q1 — the installed tree's integrity was established at install).
- **The signed-zip + checksums floor is the non-negotiable fallback** and stays intact (D-03) — an unauthenticated/offline user still installs via the checksum path.
- **One open item carried to a potential follow-up:** the real-asset verify + signer-workflow strictness (Pending Human Verification above) — a hardening nuance (verify passes today with `--repo` alone), not a correctness break.

## Self-Check: PASSED

- FOUND: `yulu/scripts/provision/attest.py`
- FOUND: `tests/test_provision_attest.py`
- FOUND: `.planning/phases/06-agent-orchestrated-provisioning-decoupled-skill-install/06-03-SUMMARY.md`
- FOUND commit: `eccb453` (test RED)
- FOUND commit: `9ff1593` (feat GREEN)
- Full pytest suite: 744 passed, 1 skipped.

---
*Phase: 06-agent-orchestrated-provisioning-decoupled-skill-install*
*Completed: 2026-05-30*
