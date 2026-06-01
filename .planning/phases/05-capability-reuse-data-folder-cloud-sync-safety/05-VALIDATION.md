---
phase: 5
slug: capability-reuse-data-folder-cloud-sync-safety
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 5 — Validation Strategy

> Per-phase validation contract. Per-task map populated after planning. Cloud detection + reuse gating are fully mockable (SF_DATALESS + path-prefix); live eviction + folder-pick smoke need a real cloud folder (manual/VM).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | pytest (cloud detection, reuse gating, path resolver, data-dir routing) |
| **Config file** | `tests/conftest.py`, `Makefile` (`make pytest`) |
| **Quick run command** | `make pytest` |
| **Full suite command** | `make test` |
| **Estimated runtime** | ~120s |

---

## Sampling Rate

- **After every task commit:** `make pytest`
- **After every plan wave:** `make test`
- **Before verify:** full suite green; `yulu doctor --json` reuse gate exercised
- **Max feedback latency:** ~120s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `tests/test_cloud_detect.py` — cloud-root detection via path-prefix (iCloud `~/Library/Mobile Documents/`, third-party `~/Library/CloudStorage/`) + `SF_DATALESS` eviction signal (mock `os.stat().st_flags`); NO `os.getxattr` (doesn't exist on macOS) (DATA-03)
- [ ] `tests/test_reuse_gating.py` — setup gates strictly on tri-state `status == "usable"` (mock the Phase-3 report): `usable` → skip install; `present-but-unverified`/`absent` → install (REUSE-01/02)
- [ ] `tests/test_search_corpus_root.py` (+ data-dir routing) — the 3 hardcoded `~/Movies/Yulu` literals (search/indexer.py, voicemail/repo.py, record_audio.py) route through `data_dir()`; runtime files (SQLite/sockets/locks) resolve via `runtime_dir()` (DATA-01/02)
- [ ] extend `tests/test_yulu_platform_macos.py` — `runtime_dir()` is LOCKED machine-local; a config pointing runtime at a synced path is rejected; `data_dir()` is configurable (DATA-02)

---

## Manual-Only Verifications (real cloud folder — human/VM, non-blocking unless noted)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Choosing an iCloud/Drive folder as the data-folder shows the cloud-risk warning | DATA-03 | Needs a real iCloud Drive / Google Drive folder | Settings → pick `~/Library/Mobile Documents/...` or `~/Library/CloudStorage/...` as data-folder → warning appears before accept |
| Data-folder change takes effect across daemons | DATA-01 | Needs running daemons + a real recording | Change data-folder → restart audio daemon → record → file lands in the new folder; status_agent menu reflects it |
| Runtime/state is never evicted/corrupted (the risk we warn about is real) | DATA-02 | Live eviction only happens on a real sync engine | Confirm SQLite/sockets stay in `runtime_dir()` (~/.config/yulu), never in the data-folder; an evicted file in a cloud folder reports `SF_DATALESS` |

*Cloud detection + reuse gating + path routing are fully unit-tested (mocked); these 3 are live-sync confirmations.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers cloud-detect + reuse-gating + data-dir routing + runtime-lock
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
