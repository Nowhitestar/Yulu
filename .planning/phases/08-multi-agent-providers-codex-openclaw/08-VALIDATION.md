---
phase: 8
slug: multi-agent-providers-codex-openclaw
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 8 — Validation Strategy

> Per-phase validation contract. FULLY automatable — pure addition of two providers against the locked Phase-3 contract; no human verification needed.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (capabilities/provider tests + doctor aggregation) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~120s |

---

## Sampling Rate

- **After every task commit:** `make pytest`
- **After every plan wave:** `make test`
- **Before verify:** full suite green; `yulu doctor --json` shows three agents' entries
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_multi_agent_providers.py` — `CodexProvider` + `OpenClawProvider` satisfy the `CapabilityProvider` ABC (no unimplemented abstractmethod); each contributes `agent-config` provenance when its CLI is present, `absent` when not; each issues NO new subprocess (delegates to probes); never raises (AGENT-01/02)
- [ ] `default_providers()` returns all THREE providers (ClaudeCode + Codex + OpenClaw); doctor's `host_capabilities` fold aggregates all three WITHOUT key collision and WITHOUT schema_version change (success criterion 3)

---

## Manual-Only Verifications

*None — this phase is fully automatable. Two provider subclasses mirroring the proven ClaudeCodeProvider against a locked interface; mocked-CLI probes cover present/absent for each agent, and the doctor aggregation is asserted in-process.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers the two new providers + three-agent aggregation
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
