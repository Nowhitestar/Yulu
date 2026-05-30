---
phase: 7
slug: seamless-auto-migration
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 7 — Validation Strategy

> Per-phase validation contract. detect/plan/apply/rollback/recording-guard are fully fixture-testable (a fake v0.5.x ~/.yulu tree + mocked daemon status); only a real end-to-end upgrade of a live v0.5.x install is human/VM.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (detect, plan, apply/rollback, verify, recording-guard) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~120s |

---

## Sampling Rate

- **After every task commit:** `make pytest`
- **After every plan wave:** `make test`
- **Before verify:** full suite green; `yulu migrate --dry-run` on a fixture tree exercised
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_migrate_detect.py` — a fixture v0.5.x `~/.yulu` tree (schema_version absent / old layout) is DETECTED as needing migration; a current install is detected as up-to-date (MIG-01)
- [ ] `tests/test_migrate_apply_rollback.py` — transactional: backup BEFORE apply; a failed verify keeps the backup + `yulu rollback` restores the prior state byte-for-byte; backup PRUNED only after verify passes (MIG-03); no data loss (recordings/transcripts/vocab/prompts preserved)
- [ ] `tests/test_migrate_recording_guard.py` — migration REFUSES to stop a daemon while a recording is active (mock recording_lock active); no `pkill -9` path anywhere (MIG-02)
- [ ] `tests/test_migrate_corrections.py` — in-transit: dead `mlx_python` field removed; hardcoded `~/Movies/Yulu` routed via PathResolver; `schema_version` stamped; `.yulu-install.json` `source` PRESERVED (Phase 6 Pitfall 3) (MIG-01)

---

## Manual-Only Verifications (real v0.5.x install — human/VM, non-blocking unless noted)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| A real v0.5.x `~/.yulu` install upgrades end-to-end with no data loss, no reconfiguration | MIG-01 | Needs a real legacy install + the full daemon stack | On a machine with a v0.5.x `~/.yulu`: run the upgrade → confirm recordings/transcripts/vocab/prompts intact, daemons run, `schema_version` stamped, no reconfiguration prompted |
| Migration refuses to truncate an in-flight recording | MIG-02 | Needs a live recording during upgrade | Start a recording → trigger migration → confirm it refuses to stop the audio daemon until the recording ends (no truncated WAV) |

*detect/plan/apply/rollback/recording-guard/corrections are fully fixture-tested; these 2 are live-install confirmations.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers detect + apply/rollback + recording-guard + corrections
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
