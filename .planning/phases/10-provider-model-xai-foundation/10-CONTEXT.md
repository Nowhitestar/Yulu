# Phase 10: Provider Model & xAI Foundation — Context

**Gathered:** 2026-08-24
**Status:** Ready for planning
**Source:** User-approved onboarding/provider decisions plus live codebase inspection

<domain>
## Phase Boundary

Phase 10 establishes the capability-specific provider contract and proves xAI as the complete direct path for transcription, summaries, and local-meeting conversation. It does not build the first-run activation journey (Phase 11), supported Agent/gateway connection flows (Phase 12), or calendar/sharing/public-release work (Phase 13).

The implementation must extend the shipped Hono+tRPC+React host, SQLite task store, local Agent session store, local search CLI, xAI OAuth manager, and artifact store. It must not replace those systems or make Hermes mandatory.
</domain>

<decisions>
## Locked Decisions

- **D-01 — Independent capability choices.** Transcription, Summary Provider, and Conversation Provider are separate settings. Changing one never changes either of the others.
- **D-02 — Creation-time identity.** A summary task and conversation session snapshot the resolved provider and model when created. Dispatch reads the snapshot, not the latest setting. Existing work is never silently rebound.
- **D-03 — Explicit failure control.** Provider or model failure pauses the summary task/conversation and presents retry-same-provider, open-provider-settings, and keep-paused choices. Changing settings affects only a new task/session.
- **D-04 — Credential custody.** The existing Yulu-owned xAI device OAuth remains primary and is reused for all three xAI capabilities. A user-entered xAI API key is an explicit fallback. Direct API and gateway secrets are stored by the packaged Keychain helper, never in config, SQLite, URLs, or logs, and are never returned to the browser after submission.
- **D-05 — Runtime-owned OAuth.** Codex, Claude Code, Hermes, and OpenClaw keep ownership of their native OAuth/session credentials. Their supported connection UX and gateway behavior remain Phase 12.
- **D-06 — One xAI connection, three proofs.** Transcription, summary, and conversation expose separate real-request readiness results even though they reuse one xAI credential.
- **D-07 — Transcript-only xAI summary.** xAI summary input contains the selected summary instructions and committed transcript text only. It enables no tools/connectors and the result must pass the existing staged/committed Markdown artifact contract.
- **D-08 — Local retrieval boundary.** For xAI conversation, Yulu searches local meeting summaries/transcripts, applies fixed per-source/count/total bounds, and sends only those excerpts plus the user's question. Source cards are generated from Yulu search hits, not model-invented URLs.
- **D-09 — Stateless xAI calls.** Every xAI text request sets `store:false`, sends no `tools`, and does not use `previous_response_id`, Files, Collections, Web Search, X Search, or write connectors. Conversation history remains in Yulu's existing local session store and is supplied only within a fixed context bound.
- **D-10 — Honest model identity.** xAI requests use the task/session's exact configured model string. There is no automatic model alias substitution or fallback. Agent-owned model choice is labeled `runtime-managed` rather than presented as a Yulu-controlled model.
- **D-11 — Existing design system.** Add one visible “AI Providers” settings category and reuse current settings cards, buttons, status pills, theme tokens, Inter/Fraunces/Geist Mono, lucide-react, tRPC, and Vitest/Playwright. Add no UI kit or runtime dependency.
- **D-12 — Release prerequisite.** The temporary public Grok CLI OAuth client ID in `xaiCredentials.ts` is not acceptable for stable distribution. Execution must receive a Yulu-owned xAI client registration and prove the packaged build uses it; this is an external setup item, not a reason to substitute a different credential silently.
</decisions>

<agent_discretion>
## Agent Discretion

- Exact config key names, SQLite column names, and migration mechanics, provided D-01 through D-04 remain observable and backward compatible.
- Exact excerpt limits and local-history window, provided both have explicit count/per-item/total caps and tests at the trust boundary.
- Exact xAI model default at implementation time, provided the chosen value is confirmed through the official model endpoint/docs and persisted as an exact task/session snapshot.
- Whether the provider-paused state is represented by one generalized state or a backward-compatible extension of `awaiting_agent`, provided no automatic retry or fallback occurs.
</agent_discretion>

<canonical_refs>
## Canonical References

- `.planning/REQUIREMENTS.md` — PRVD-01..05 and XAI-01..04 are the acceptance contract.
- `.planning/ROADMAP.md` — Phase 10 boundary and success criteria; Phase 11–13 deferrals.
- `yulu/spec/adr/008-yulu-owned-xai-oauth.md` — xAI device-flow trust boundary and Keychain custody.
- `yulu/scripts/yulu_ui/src/config.ts` and `settingsRegistry.ts` — atomic config and registered setting patterns.
- `yulu/scripts/yulu_ui/src/hostStore.ts` and `recordingPipeline.ts` — durable summary task state, leases, snapshots, and production artifact flow.
- `yulu/scripts/yulu_ui/src/artifactStore.ts` — staged transcript/summary validation and atomic Markdown commit.
- `yulu/scripts/yulu_ui/src/xaiCredentials.ts`, `xaiAudio.ts`, and `yulu/scripts/xai_keychain.swift` — existing OAuth, real STT probe, trusted URL checks, and secret transport.
- `yulu/scripts/yulu_ui/src/routers/search.ts`, `routers/ask.ts`, and `agentSessionStore.ts` — local retrieval, conversation dispatch, and local history.
- `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx` and `web/src/routes/agent-console.tsx` — UI interaction patterns to extend.
</canonical_refs>

<deferred>
## Deferred

- First-run/new-upgrade/developer activation orchestration and real first recording — Phase 11.
- Codex App Server OAuth, Claude Code OAuth/API-key fallback, Hermes/OpenClaw gateways, and CLIProxyAPI-compatible endpoint setup — Phase 12.
- Calendar, sharing destination onboarding, optional Conversation setup, README/website alignment, npm audit closure, and public latest-stable acceptance — Phase 13.
- xAI Web/X search, Files/Collections, server-side conversation state, citations from xAI tools, and write connectors — future XAI-F01/XAI-F02 work.
- Windows/Linux credential helpers and runtime support — outside v0.6.
</deferred>

---

*Phase: 10-provider-model-xai-foundation*
*Context gathered: 2026-08-24*
