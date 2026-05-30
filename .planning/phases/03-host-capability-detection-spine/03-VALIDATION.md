---
phase: 3
slug: host-capability-detection-spine
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-05-30
---

# Phase 3 — Validation Strategy

> Per-phase validation contract. Per-task map populated after planning (3 plans, 3 waves). Phase 3 is largely unit-testable (probes mock subprocess/PATH/filesystem) — minimal human verification.

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
| P01-T1 | 03-01 | 1 | DETECT-01 | — | Versioned tri-state schema; no boolean status drives a skip-install (D-08) | unit | `python3 -m pytest tests/test_capabilities_report.py -x -q` | `yulu/scripts/capabilities/report.py`, `tests/test_capabilities_report.py` | ⬜ pending |
| P01-T2 | 03-01 | 1 | DETECT-02, DETECT-03, DETECT-04 | T-03-01, T-03-02, T-03-03 | login-shell PATH (list-form `-lc`), daemon-interpreter import probe, llm.command resolved-NOT-executed, model scan path-bounded | unit (mocked subprocess/fs) | `python3 -m pytest tests/test_host_capability_probes.py -x -q` | `yulu/scripts/capabilities/probes.py`, `tests/test_host_capability_probes.py` | ⬜ pending |
| P02-T1 | 03-02 | 2 | DETECT-05 | T-03-05 | Provider delegates to Plan-01 probes (no new exec surface); ABC carries no agent vocab (pure addition) | unit | `python3 -m pytest tests/test_capability_provider.py -x -q` | `yulu/scripts/capabilities/provider.py`, `tests/test_capability_provider.py` | ⬜ pending |
| P03-T1 | 03-03 | 3 | DETECT-01, DETECT-03, DETECT-05 | T-03-01, T-03-07 | host_capabilities additive + never-raises/hangs; llm.command resolved-not-executed end-to-end; §5d runtime-root fix | unit + CLI e2e | `python3 -m pytest tests/test_doctor_host_capabilities.py tests/test_doctor.py -x -q` | `yulu/scripts/doctor.py`, `tests/test_doctor_host_capabilities.py` | ⬜ pending |

**Nyquist coverage:** every task carries an `<automated>` verify; no 3 consecutive tasks without one. Wave 0 test files (below) are created by the same tasks that consume them (RED → GREEN within the task).

---

## Wave 0 Requirements

- [ ] `tests/test_capabilities_report.py` — `HostCapabilityReport` schema: `schema_version` present, every entry has provenance ∈ {host-path,yulu-managed,agent-config,absent} + tri-state status ∈ {usable,present-but-unverified,absent}; assert NO boolean status field anywhere (DETECT-01) — **owned by Plan 03-01 Task 1**
- [ ] `tests/test_host_capability_probes.py` — login-shell PATH resolution finds a binary on the login PATH (mock `$SHELL -lc`), importability probe uses the daemon python3 (mock subprocess), `absent` returned cleanly when missing (DETECT-02/04) — **owned by Plan 03-01 Task 2**
- [ ] `tests/test_capability_provider.py` — `CapabilityProvider` ABC has no unimplemented abstractmethod in `ClaudeCodeProvider`; provider contributes `agent-config` provenance; a second (stub) provider could implement the same ABC (DETECT-05 / Phase 8 readiness) — **owned by Plan 03-02 Task 1**
- [ ] `tests/test_doctor_host_capabilities.py` — `doctor.py --json` emits a valid `host_capabilities` section covering claude/whisper-cli/mlx-whisper/llm.command/models/recording-dir without breaking the existing report shape (DETECT-03); uses runtime_root not source_root (§5d) — **owned by Plan 03-03 Task 1**

---

## Manual-Only Verifications (optional — accuracy on real heterogeneous hosts)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Detection is accurate on a host where a binary is on the login PATH but NOT launchd's PATH | DETECT-02 | Hard to fully reproduce launchd's minimal PATH in CI | On a real install: put `whisper-cli` only on the login PATH; run `yulu doctor` → confirm it reports `usable` relative to the consumer, not a false `absent` |
| A green `usable` mlx-whisper actually transcribes (no silent first-recording failure) | DETECT-04 | Needs a real first-recording on a host with mlx-whisper in the daemon python3 | Install mlx-whisper in the daemon's python3; `yulu doctor` shows `usable`; record → transcription succeeds first try |

*Most Phase 3 behavior is automatable via mocked probes — these two are accuracy confirmations, NOT blocking (per planning_context: optional human-verify).*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers schema + probes + provider + doctor integration
- [x] No watch-mode flags
- [x] Feedback latency < 120s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned (per-task map populated; Wave 0 test files created during execution within their owning tasks)
