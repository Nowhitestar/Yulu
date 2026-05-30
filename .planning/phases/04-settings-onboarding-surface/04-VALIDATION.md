---
phase: 4
slug: settings-onboarding-surface
status: planned
nyquist_compliant: true
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
| P1-T1 list_models() | 04-01 | 1 | SET-04 | T-04-01 | Path-bounded model listing (fixed roots, resolve-dedupe, no traversal) | pytest | `cd yulu/scripts && python3 -m pytest tests/test_list_models.py -x` | `tests/test_list_models.py` | ⬜ pending |
| P1-T2 capabilities router | 04-01 | 1 | SET-01, SET-04 | T-04-EX, T-04-DOS | Shells doctor.py only (never user cmd); typed error not throw; spawn timeout | vitest | `cd yulu/scripts/yulu_ui && npx vitest run tests/routers/capabilities.test.ts` | `tests/routers/capabilities.test.ts` | ⬜ pending |
| P2-T1 CapabilitiesSection | 04-02 | 2 | SET-02 | T-04-XSS | Report strings rendered as escaped text; graceful error degrade | vitest | `cd yulu/scripts/yulu_ui && npx vitest run tests/web/CapabilitiesSection.test.tsx` | `tests/web/CapabilitiesSection.test.tsx` | ⬜ pending |
| P2-T2 settings wiring | 04-02 | 2 | SET-01 | — | Section slotted; bundle builds; no other section altered | vitest+build | `cd yulu/scripts/yulu_ui && npx vitest run tests/web/routes.test.tsx && npm run build` | `web/src/routes/settings.tsx` | ⬜ pending |
| P3-T1 RESTART_MAP | 04-03 | 2 | TRANS-01, TRANS-02 | T-04-KEY | mode/cloud_command → sttdaemon restart; NO key field added | vitest | `cd yulu/scripts/yulu_ui && npx vitest run tests/config.test.ts` | `src/config.ts` | ⬜ pending |
| P3-T2 TranscriptionSection | 04-03 | 2 | TRANS-01, TRANS-02, SET-04 | T-04-KEY, T-04-MODEL | Cloud = command not key (no password/api-key input); model from detected list | vitest | `cd yulu/scripts/yulu_ui && npx vitest run tests/web/TranscriptionSection.test.tsx` | `tests/web/TranscriptionSection.test.tsx` | ⬜ pending |
| P4-T1 Onboarding | 04-04 | 2 | SET-03 | T-04-FORCE | Skippable without completing; never reappears; dismissal persisted | vitest | `cd yulu/scripts/yulu_ui && npx vitest run tests/web/Onboarding.test.tsx` | `tests/web/Onboarding.test.tsx` | ⬜ pending |
| P4-T2 root mount | 04-04 | 2 | SET-03 | T-04-FLAG | Self-gating overlay mounted; routes still mount; bundle builds | vitest+build | `cd yulu/scripts/yulu_ui && npx vitest run tests/web/routes.test.tsx && npm run build` | `web/src/routes/root.tsx` | ⬜ pending |

---

## Wave 0 Requirements

- [x] `capabilities` tRPC router test — `host_capabilities` query shells `doctor.py --json` and returns the report section; error path returns a typed error not a throw (SET-01) → **04-01 Task 2** (`tests/routers/capabilities.test.ts`)
- [x] `CapabilitiesSection` render test — renders provenance label ("reused from your PATH" vs "Yulu-managed"), resolved path, tri-state badge from a mocked report (SET-02) → **04-02 Task 1** (`tests/web/CapabilitiesSection.test.tsx`)
- [x] `TranscriptionSection` test — mode radios (local/cloud-fallback/cloud-priority) persist via config mutation; model selector lists detected models; cloud-command field present, NO cloud-key field (TRANS-01/02, SET-04) → **04-03 Task 2** (`tests/web/TranscriptionSection.test.tsx`)
- [x] Onboarding test — first-run shows walkthrough reflecting permission status; "skip"/dismiss closes it without completing; `onboarding_dismissed` persists (SET-03) → **04-04 Task 1** (`tests/web/Onboarding.test.tsx`)

*(Wave 0 tests are authored as the first task of each plan — TDD `<behavior>` blocks define expectations before implementation. `wave_0_complete` flips to `true` once these test files exist and run RED.)*

---

## Manual-Only Verifications (optional — browser visual, non-blocking)

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Settings page visually surfaces capabilities + transcription config correctly in a real browser | SET-01/02 | Pixel/layout correctness beyond jsdom | Open `http://127.0.0.1:7777` settings → confirm capabilities list, provenance labels, transcription radios, model selector render and persist |
| Onboarding walkthrough flow feels right and is genuinely skippable | SET-03 | UX feel beyond unit assertions | First run → walkthrough appears with live permission status → click skip → dismissed, does not reappear |

*Most behavior is covered by Vitest + @testing-library/react; these are visual/UX confirmations, NOT blocking.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers tRPC endpoint + CapabilitiesSection + TranscriptionSection + onboarding
- [x] No watch-mode flags (vitest run, not watch)
- [x] Feedback latency < 90s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** planned — Wave 0 test files land as task 1 of each plan during execution.
