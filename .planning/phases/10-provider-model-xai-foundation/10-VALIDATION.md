---
phase: 10
slug: provider-model-xai-foundation
status: planned
nyquist_compliant: true
wave_0_complete: false
created: 2026-08-24
---

# Phase 10 — Validation Strategy

> Every autonomous task has a focused runnable gate. Live xAI/Yulu-owned OAuth acceptance is one final blocking checkpoint and cannot be replaced by mocked fetch tests.

## Test Infrastructure

| Property | Value |
|----------|-------|
| Framework | Existing Vitest, React Testing Library, Playwright, TypeScript typecheck, pytest source/package gates |
| Config | `yulu/scripts/yulu_ui/vitest.config.ts`, `playwright.config.ts`, existing root pytest discovery |
| Quick run | `cd yulu/scripts/yulu_ui && npm test -- --run <focused files>` |
| Phase suite | Focused Vitest files from all five plans + `npm run typecheck` + `npm run build` + Keychain source/package pytest |
| Full repository | Existing project-wide pytest and UI test commands before phase verification |

## Sampling Rate

- After each task: run its exact focused test command.
- After each wave: run all tests from that wave plus `npm run typecheck`.
- Before live checkpoint: run the complete Phase 10 suite and `npm run build`.
- Before phase completion: run the repository's full existing automated gate and preserve live checkpoint evidence.
- Unit tests use injected fetch/temporary directories only; no xAI network request occurs outside the explicit live checkpoint.

## Per-Task Verification Map

| Task ID | Wave | Requirement | Secure behavior | Planned verification | Status |
|---------|------|-------------|-----------------|----------------------|--------|
| 10-01-01 | 1 | PRVD-01 | Three settings are independent; no secret-shaped config fields | `tests/config.test.ts`, `tests/settingsRegistry.test.ts` | ⬜ |
| 10-01-02 | 1 | PRVD-02, PRVD-03 | Task provider/model is immutable; claim does not overwrite; failure can pause | `tests/hostStore.test.ts`, `tests/recordingPipeline.test.ts` | ⬜ |
| 10-01-03 | 1 | PRVD-02, XAI-04 | Session provider/model/history/status persists locally and migrates | new focused `tests/agentSessionStore.test.ts` | ⬜ |
| 10-02-01 | 2 | PRVD-04 | Secret slots use Keychain stdin and never config/log/argv/read-back | `tests/xaiCredentials.test.ts`, `tests/test_xai_keychain_source.py`, package source gate | ⬜ |
| 10-02-02 | 2 | XAI-01, PRVD-05 | xAI text calls use exact model, `store:false`, no tools; response/error bounds | new `tests/xaiText.test.ts` | ⬜ |
| 10-02-03 | 2 | XAI-01, PRVD-05 | Separate STT/summary/conversation real-probe endpoints and factual statuses | `tests/routers/xaiAudio.test.ts` plus new provider-router test | ⬜ |
| 10-03-01 | 3 | XAI-02, PRVD-02 | Automatic xAI summary uses transcript-only input and existing artifact commit | `tests/recordingPipeline.test.ts`, `tests/artifactStore.test.ts` | ⬜ |
| 10-03-02 | 3 | XAI-02, PRVD-02 | Manual summary snapshots once and writes current Markdown/stale state | recordings router test | ⬜ |
| 10-03-03 | 3 | PRVD-03 | Summary failure sends no fallback request and enters provider-paused state | pipeline/router tests with call-count assertions | ⬜ |
| 10-04-01 | 3 | XAI-03 | Local hits are normalized and capped before any network call | `tests/routers/search.test.ts`, `tests/routers/ask.test.ts` | ⬜ |
| 10-04-02 | 3 | XAI-03, XAI-04 | xAI request sends bounded excerpts/history with `store:false`, sources remain local | `tests/routers/ask.test.ts`, `tests/xaiText.test.ts` | ⬜ |
| 10-04-03 | 3 | PRVD-02, PRVD-03, XAI-04 | Session remains pinned/local; mismatch/failure pauses, never switches | `tests/agentSessionStore.test.ts`, `tests/routers/ask.test.ts` | ⬜ |
| 10-05-01 | 4 | PRVD-01, XAI-01 | Independent selectors and one shared xAI connection render accessibly | provider/transcription/settings React tests | ⬜ |
| 10-05-02 | 4 | PRVD-03, XAI-03 | Paused summary/conversation actions and local source cards are visible | recording detail and Agent Console React tests | ⬜ |
| 10-05-03 | 4 | all | One Yulu-owned connection passes three live probes, saves summary, answers with sources | blocking human/live-host checkpoint | ⬜ |

## Wave 0 Requirements

- [ ] Add focused xAI text request-shape tests before implementing the client.
- [ ] Extend HostStore/session tests before changing migrations or claim semantics.
- [ ] Add bounded-excerpt and no-network-on-empty-search tests before the xAI ask branch.
- [ ] Add provider UI tests before making `llm` visible in settings.
- [ ] Add a source/package gate that rejects the temporary public Grok CLI client ID in a Phase 10 release candidate.

`wave_0_complete` remains false until these failing tests exist. This is expected before execution.

## Blocking Live Checkpoint — 10-05-03

Preconditions: all autonomous tasks green; packaged build contains a Yulu-owned xAI OAuth client registration; no test API key or OAuth token appears in logs/config/SQLite.

| Check | Evidence required |
|-------|-------------------|
| Shared connection | One authorization identity is shown as connected without exposing a token; logout/reconnect behaves once for all capabilities |
| Three readiness proofs | Timestamp/model/result for real STT probe, real summary probe, and real conversation probe; each can independently be ready/failed |
| Production summary | A test recording's committed transcript and `.summary.md`; artifact DB provenance pins xAI + exact model; captured request proves transcript-only, `store:false`, no tools |
| Local cited conversation | Question spanning at least two indexed meetings; UI source cards point to those local meetings; captured request shows only bounded excerpts/history, `store:false`, no tools/previous response/files |
| Failure control | Make the pinned model invalid once; summary/session pauses and presents actions; no second provider/model request occurs until explicit user action |
| Credential custody | Search config, SQLite, application logs, process argv, and rendered response payloads for the test secret/token; all are absent |

## Sign-Off

- [x] Every PRVD/XAI requirement maps to at least one automated task and the live checkpoint.
- [x] High-severity provider-switch, credential, data-egress, storage/tool, and retry threats have negative tests.
- [x] No autonomous task relies only on a human visual check.
- [x] External OAuth/API behavior is not falsely accepted from mocks alone.
- [ ] Wave 0 tests exist and fail for the intended missing behavior.
- [ ] Live checkpoint approved.

**Approval:** validation design approved; execution pending
