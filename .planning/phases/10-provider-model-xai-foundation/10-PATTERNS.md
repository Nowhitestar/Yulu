# Phase 10: Existing Pattern Map

**Mapped:** 2026-08-24

| New responsibility | Closest existing analog | Reuse rule | Avoid |
|--------------------|-------------------------|------------|-------|
| Capability setting | `transcription.engine` in `config.ts`, `settingsRegistry.ts`, `TranscriptionSection.tsx` | Add sibling summary/conversation selectors with the same config-update/reload-none path | A second settings store or provider registry framework |
| xAI text request | `XaiAudioClient` in `xaiAudio.ts` | Mirror injected fetch, fixed origin, abort timeout, bounded retry, JSON validation, safe errors | SDK dependency or generic HTTP abstraction |
| Shared xAI auth | `XaiCredentialManager.resolve()` | Preserve exact official Grok CLI client-ID equality plus Yulu's exact reviewed six-scope subset and reuse OAuth refresh/cache; add explicit Keychain API-key fallback at this one boundary | Copying OAuth/device flow per capability or inventing a Yulu client registration |
| Multiple Keychain secrets | `xai_keychain.swift` + `KeychainXaiTokenStore.run()` | Extend the signed helper with a validated slot argument and stdin/stdout transport; retain legacy default slot | Secret in argv/env/config/SQLite or a second helper binary |
| Summary artifact | `ArtifactStore.writeStagedSummary()` → `commitFromWorkspace()` → `HostStore.recordArtifacts()` | Route xAI through the same size/hash/path/atomic commit | Direct ad-hoc file write in automatic pipeline |
| Manual summary | `runAgentSummarize()` branch in `routers/recordings.ts` | Snapshot selection once, then call Agent or xAI and keep existing atomic write/stale marker | A new summary endpoint |
| Durable provider pause | `awaiting_agent`, `awaiting_policy`, lease release, task events in `HostStore` | Generalize the state name/semantics and expose error/provider/model | Automatic retry/fallback or overwriting snapshot in `claimNext` |
| Local meeting retrieval | `runSearchCli()` and normalized `SearchHit` | Reuse summaries/transcripts search, then apply a pure bounding function | New vector DB, xAI Files, or model-owned retrieval |
| Conversation history | `agentSessionStore.ts` | Add provider/model/status fields and bound the request projection | xAI server state or another database |
| Conversation dispatch | `routers/ask.ts` | Branch from the pinned session identity; preserve Agent path and add xAI local-retrieval path | Reading current provider setting on every turn |
| Source display | Agent Console message `sources` and `agentSessionSourceSchema` | Persist/display exact normalized local hits | Trusting citations, paths, or URLs returned by the model |
| Provider settings UI | Settings master/detail, provider status cards, `path-btn`, `provider-state` | Add `llm` as visible “AI Providers”; move/reuse the shared xAI connection card | New component library or onboarding wizard in Phase 10 |
| Test style | Existing Vitest router/store/component tests plus Playwright setup | Extend the closest test file; one live checkpoint for external xAI | Network in unit tests or a second test framework |

## File Ownership by Plan

| Plan | Primary files | Boundary |
|------|---------------|----------|
| 10-01 | `config.ts`, `settingsRegistry.ts`, `hostStore.ts`, `agentSessionStore.ts` | Provider/model selection and immutable durable identity only |
| 10-02 | `xai_keychain.swift`, `xaiCredentials.ts`, new `xaiText.ts`, provider router/context wiring | Credential custody and direct xAI request/probes only |
| 10-03 | `recordingPipeline.ts`, `routers/recordings.ts`, artifact/host integrations | Summary execution, artifact validation, provider pause only |
| 10-04 | `routers/ask.ts`, `routers/search.ts`, `agentSessionStore.ts` | Bounded local retrieval, local history, cited conversation only |
| 10-05 | settings category/section, Transcription section, Agent Console, i18n/CSS and focused tests | User selection, readiness, source and pause controls plus live checkpoint |

File overlap is intentional only where the later plan consumes the earlier schema (`agentSessionStore.ts` in 10-04). Plans 10-03 and 10-04 can execute in parallel after 10-01/10-02 because their production source files do not overlap.
