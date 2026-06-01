---
phase: 6
slug: agent-orchestrated-provisioning-decoupled-skill-install
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 6 — Validation Strategy

> Per-phase validation contract. Both spike failure paths (kill-at-step-N resume, tampered-asset rejection) are fully pytest-simulatable; only a real `gh attestation verify` of a published zip + the signer-workflow strictness need human/CI.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (registry, resume ledger, attest gate, skill install) + `bash -n`/shellcheck (yulu CLI subcommands) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~120s |

---

## Sampling Rate

- **After every task commit:** `make pytest`
- **After every plan wave:** `make test`
- **Before verify:** full suite green; `yulu provision --list` + `yulu skill install --help` exercised
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_provision_registry.py` — Step `check()`/`apply()` → `StepResult{ok|skipped|error}`; wraps `setup_*.sh` via subprocess (mocked); `check()` already-done → `apply()` returns `skipped`, no re-do (PROV-01)
- [ ] `tests/test_provision_resume.py` — **kill-at-step-N**: simulate a ledger with step N `running` (interrupted) → resume redoes only N+ , never re-runs `ok` steps, never duplicates daemons; atomic write (tempfile+os.replace) like queue_store.py; **preserves `.yulu-install.json` `source` field** (PROV-04)
- [ ] `tests/test_attest_gate.py` — the fallback LADDER: gh-authed verify==0 → pass; **gh exit-4 (unauth) OR gh-absent → SHA-256 checksums floor**; non-4 nonzero on authed gh → corroborate-or-reject; **tampered asset → REJECTED before any apply()** (fail-closed); reuses `release_installer.verify_checksum` (PROV-03)
- [ ] `tests/test_skill_install.py` — `yulu skill install [--agent]` idempotent (re-invoke = update not duplicate); extracted from setup.sh; setup.sh main flow no longer calls install_agent_skill (PROV-05)

---

## Manual / CI-Only Verifications (need a real release asset + gh auth — human/CI)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real `gh attestation verify` of a published release zip passes | PROV-03 | Needs a published GitHub release asset + `gh auth` (verify requires authentication — exit 4 unauth even for public repos) | After a signed release: `gh auth login`; `gh attestation verify dist/yulu-...zip --repo Nowhitestar/Yulu` → exit 0 |
| The `--signer-workflow`/`--signer-repo` strictness is correct for the reusable workflow (A1/Q2) | PROV-03 | The exact signer-identity flag for a reusable release-publish.yml can only be confirmed against a real attestation | Confirm the verify command pins the correct signer workflow/repo and rejects an attestation from a different workflow |

*The two spike failure paths (kill-at-step-N resume, tampered-asset rejection) are fully simulated in pytest — these two are the real-asset confirmations only.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers registry + resume + attest/tamper + skill install
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
