---
phase: 4
slug: settings-onboarding-surface
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-05-30
---

# Phase 4 — Validation Strategy

> Per-phase validation contract. Per-task map populated after planning. Mostly automatable via Vitest component/router tests; browser visual is an optional non-blocking confirmation.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest + @testing-library/react + mock-socket (yulu_ui) + pytest (doctor shell) + `tsc` typecheck |
| **Config file** | `yulu_ui/vitest.config.ts`, `Makefile` |
| **Quick run command** | `cd yulu/scripts/yulu_ui && npm test` |
| **Full suite command** | `npm run typecheck && npm test && npm run build` (+ `make pytest`) |
| **Estimated runtime** | ~90s vitest + build |

---

## Sampling Rate

- **After every task commit:** `npm test` (changed area) or `make pytest`
- **After every plan wave:** `npm run typecheck && npm test`
- **Before verify:** typecheck + vitest + `npm run build` all green
- **Max feedback latency:** ~90s

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| _(populated after planning)_ | | | | | | | | | ⬜ pending |

---

## Wave 0 Requirements

- [ ] `capabilities` tRPC router test — `host_capabilities` query shells `doctor.py --json` and returns the report section; error path returns a typed error not a throw (SET-01)
- [ ] `CapabilitiesSection` render test — renders provenance label ("reused from your PATH" vs "Yulu-managed"), resolved path, tri-state badge from a mocked report (SET-02)
- [ ] `TranscriptionSection` test — mode radios (local/cloud-fallback/cloud-priority) persist via config mutation; model selector lists detected models; cloud-command field present, NO cloud-key field (TRANS-01/02, SET-04)
- [ ] Onboarding test — first-run shows walkthrough reflecting permission status; "skip"/dismiss closes it without completing; `onboarding_dismissed` persists (SET-03)

---

## Manual-Only Verifications (optional — browser visual, non-blocking)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Settings page visually surfaces capabilities + transcription config correctly in a real browser | SET-01/02 | Pixel/layout correctness beyond jsdom | Open `http://127.0.0.1:7777` settings → confirm capabilities list, provenance labels, transcription radios, model selector render and persist |
| Onboarding walkthrough flow feels right and is genuinely skippable | SET-03 | UX feel beyond unit assertions | First run → walkthrough appears with live permission status → click skip → dismissed, does not reappear |

*Most behavior is covered by Vitest + @testing-library/react; these are visual/UX confirmations, NOT blocking.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers tRPC endpoint + CapabilitiesSection + TranscriptionSection + onboarding
- [ ] No watch-mode flags (vitest run, not watch)
- [ ] Feedback latency < 90s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
