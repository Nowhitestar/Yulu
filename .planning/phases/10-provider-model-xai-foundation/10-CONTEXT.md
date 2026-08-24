# Phase 10: Provider Model & xAI Foundation — Context

**Gathered:** 2026-08-24
**Status:** Ready for execution
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
- **D-04 — Credential custody.** The existing Yulu-managed, Grok CLI-compatible xAI device OAuth remains primary and is reused for all three xAI capabilities. A user-entered xAI API key is an explicit fallback. Direct API and gateway secrets are stored by the packaged Keychain helper, never in config, SQLite, URLs, or logs, and are never returned to the browser after submission.
- **D-05 — Runtime-owned OAuth.** Codex App Server/CLI keeps ownership of its OAuth session. Yulu may invoke the unmodified Claude Code CLI or let an already-running Claude Code consume the external Agent queue; Claude Code owns native sign-in and token custody. Yulu never embeds Claude.ai login, reads/copies the token, or uses it outside the CLI; direct API/SDK execution requires an Anthropic-supported API/cloud credential. Hermes and OpenClaw keep ownership of their gateway/runtime sessions. Supported connection UX remains Phase 12.
- **D-06 — One xAI connection, three proofs.** Transcription, summary, and conversation expose separate real-request readiness results even though they reuse one xAI credential.
- **D-07 — Transcript-only xAI summary.** xAI summary input contains the selected summary instructions and committed transcript text only. It enables no tools/connectors and the result must pass the existing staged/committed Markdown artifact contract.
- **D-08 — Local retrieval boundary.** For xAI conversation, Yulu searches local meeting summaries/transcripts, applies fixed per-source/count/total bounds, and sends only those excerpts plus the user's question. Source cards are generated from Yulu search hits, not model-invented URLs.
- **D-09 — Stateless xAI calls.** Every xAI text request sets `store:false`, sends no `tools`, and does not use `previous_response_id`, Files, Collections, Web Search, X Search, or write connectors. Conversation history remains in Yulu's existing local session store and is supplied only within a fixed context bound.
- **D-10 — Honest model identity.** xAI requests use the task/session's exact configured model string. There is no automatic model alias substitution or fallback. Agent-owned model choice is labeled `runtime-managed` rather than presented as a Yulu-controlled model.
- **D-11 — Existing design system.** Add one visible “AI Providers” settings category and reuse current settings cards, buttons, status pills, theme tokens, Inter/Fraunces/Geist Mono, lucide-react, tRPC, and Vitest/Playwright. Add no UI kit or runtime dependency.
- **D-12 — Grok CLI OAuth compatibility.** The public Grok CLI OAuth client ID and Yulu's six-scope least-privilege set (`openid profile email offline_access grok-cli:access api:access`) are intentional. Yulu owns the connection lifecycle and Keychain item, not the client registration. Execution pins the client ID exactly to xAI's official Grok Build source and pins Yulu's scopes as a reviewed subset that excludes Grok conversation/workspace resources. Separate real STT/summary/conversation probes establish account/model entitlement. Upstream contract or entitlement failure pauses the capability; API-key use requires an explicit user choice.
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
- `yulu/spec/adr/008-yulu-owned-xai-oauth.md` — historical xAI device-flow trust boundary and Keychain custody.
- `yulu/spec/adr/009-grok-cli-compatible-xai-oauth.md` — current public-client, least-privilege scope, and three-capability decision.
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
- Codex App Server OAuth reuse, unmodified Claude Code CLI/native OAuth plus user-run queue handoff, Anthropic-supported direct API/cloud credentials, Hermes/OpenClaw gateways, and CLIProxyAPI-compatible endpoint setup — Phase 12.
- Calendar, sharing destination onboarding, optional Conversation setup, README/website alignment, npm audit closure, and public latest-stable acceptance — Phase 13.
- xAI Web/X search, Files/Collections, server-side conversation state, citations from xAI tools, and write connectors — future XAI-F01/XAI-F02 work.
- Windows/Linux credential helpers and runtime support — outside v0.6.
</deferred>

---

*Phase: 10-provider-model-xai-foundation*
*Context gathered: 2026-08-24*
