---
phase: 3
slug: host-capability-detection-spine
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 3 — Validation Strategy

> Per-phase validation contract. Per-task map populated after planning. Phase 3 is largely unit-testable (probes mock subprocess/PATH/filesystem) — minimal human verification.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (doctor.py + new `capabilities/` module) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~120s |

---

## Sampling Rate

- **After every task commit:** `make pytest`
- **After every plan wave:** `make test`
- **Before verify:** full suite green + `yulu doctor --json | python3 -m json.tool` valid + `host_capabilities` present
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_capabilities_report.py` — `HostCapabilityReport` schema: `schema_version` present, every entry has provenance ∈ {host-path,yulu-managed,agent-config,absent} + tri-state status ∈ {usable,present-but-unverified,absent}; assert NO boolean status field anywhere (DETECT-01)
- [ ] `tests/test_host_capability_probes.py` — login-shell PATH resolution finds a binary on the login PATH (mock `$SHELL -lc`), importability probe uses the daemon python3 (mock subprocess), `absent` returned cleanly when missing (DETECT-02/04)
- [ ] `tests/test_capability_provider.py` — `CapabilityProvider` ABC has no unimplemented abstractmethod in `ClaudeCodeProvider`; provider contributes `agent-config` provenance; a second (stub) provider could implement the same ABC (DETECT-05 / Phase 8 readiness)
- [ ] `tests/test_doctor_host_capabilities.py` — `doctor.py --json` emits a valid `host_capabilities` section covering claude/whisper-cli/mlx-whisper/llm.command/models/recording-dir without breaking the existing report shape (DETECT-03); uses runtime_root not source_root (§5d)

---

## Manual-Only Verifications (optional — accuracy on real heterogeneous hosts)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Detection is accurate on a host where a binary is on the login PATH but NOT launchd's PATH | DETECT-02 | Hard to fully reproduce launchd's minimal PATH in CI | On a real install: put `whisper-cli` only on the login PATH; run `yulu doctor` → confirm it reports `usable` relative to the consumer, not a false `absent` |
| A green `usable` mlx-whisper actually transcribes (no silent first-recording failure) | DETECT-04 | Needs a real first-recording on a host with mlx-whisper in the daemon python3 | Install mlx-whisper in the daemon's python3; `yulu doctor` shows `usable`; record → transcription succeeds first try |

*Most Phase 3 behavior is automatable via mocked probes — these two are accuracy confirmations, not blocking.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers schema + probes + provider + doctor integration
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
