# Phase 10: Provider Model & xAI Foundation — Research

**Researched:** 2026-08-24
**Confidence:** High for the existing Yulu seams and xAI request/privacy contract; external client registration remains a release prerequisite

## Executive Conclusion

The shortest safe implementation is an extension, not a replacement: preserve the existing local Agent path, add creation-time provider/model snapshots to the task/session records, add one small xAI Responses client beside `XaiAudioClient`, and branch at the two existing execution seams. The existing artifact store, local search CLI, Agent session JSON, OAuth manager, and packaged Keychain helper already cover most of the hard boundaries.

Do not introduce an orchestration framework, vector database, xAI server-side conversation state, or a second credential helper. The missing behavior is concentrated in configuration, durable snapshots, one direct text client, two provider branches, and explicit paused states.

## Official xAI Contract

### Responses and privacy

- xAI's Responses API accepts `POST /v1/responses`; text generation examples explicitly support `store:false`. Yulu must set it on every summary, conversation, and readiness request. Source: [Generate Text](https://docs.x.ai/developers/model-capabilities/text/generate-text) and [Responses REST reference](https://docs.x.ai/developers/rest-api-reference/inference/chat).
- xAI documents default input/output retention and a separate Zero Data Retention program. `store:false` is therefore a request-level requirement, not a claim that the account has ZDR. Source: [Security FAQ](https://docs.x.ai/developers/faq/security).
- Stateful response chaining is unnecessary and conflicts with XAI-04's local-history lock. Yulu should not send `previous_response_id`; it should reconstruct a bounded context from its local store.

### Models and capability proofs

- Available model IDs can be read from the official Models endpoint. Yulu should validate the configured exact model without silently replacing it. Source: [Models REST reference](https://docs.x.ai/developers/rest-api-reference/inference/models).
- `grok-4.6` is an official current text model at planning time, but the implementation must treat the configured value as data and snapshot it. Source: [Grok 4.6](https://docs.x.ai/developers/grok-4-6).
- xAI speech-to-text is already implemented by Yulu through `/v1/stt`; Phase 10 should reuse its credential manager and real WAV probe. Source: [Speech-to-Text REST reference](https://docs.x.ai/developers/rest-api-reference/inference/speech-to-text).

### OAuth and tools

- xAI's CLI documents device authorization (`grok login --device-auth`), consistent with Yulu's existing discovery/device flow. Source: [xAI CLI reference](https://docs.x.ai/build/cli/reference).
- xAI citations are attached to tool-derived sources such as Web/X search. Phase 10 explicitly enables no such tools. Meeting sources must remain Yulu-owned structured records derived from local search. Source: [Citations](https://docs.x.ai/developers/tools/citations).

## Existing Yulu Seams to Reuse

| Need | Existing asset | Phase 10 use |
|------|----------------|--------------|
| Atomic user config | `ConfigManager` + `ConfigSchema` + `settingsRegistry.ts` | Add independent summary/conversation selections; keep transcription selection intact |
| Durable summary work | `HostStore.agent_tasks` + leases/events | Add immutable summary provider/model columns and a provider-paused state; stop overwriting provider during claim |
| Production Markdown | `ArtifactStore.writeStagedSummary`, `commitFromWorkspace`, `HostStore.recordArtifacts` | xAI writes through the same size/hash/path/provenance checks as the Agent path |
| xAI auth | `XaiCredentialManager` + `KeychainXaiTokenStore` | Reuse one OAuth token for STT and text; add explicit API-key fallback without config persistence |
| Native secret custody | `xai_keychain.swift` + packaged signed helper | Extend its argv contract with a validated secret slot; preserve the current no-slot OAuth behavior |
| HTTP pattern | `XaiAudioClient` | Mirror xAI origin validation, AbortController timeout, one bounded retry policy, response validation, and safe error messages |
| Local retrieval | `runSearchCli` | Ask across meeting summaries/transcripts and then cap count, per-excerpt length, and total characters before network use |
| Local history | `agentSessionStore.ts` | Add provider/model/status snapshot; keep messages and sources local; bound network projection |
| Agent execution | `resolveAgentRuntime`, `runAgentCliCommand`, `HermesRecordingGateway` | Preserve current Agent behavior; require current runtime identity to match the snapshot rather than switching |
| Provider UI | settings master/detail, `TranscriptionSection`, Agent Console | Add AI Providers category and paused/readiness actions with current components/tokens |

## Required Behavioral Changes

### 1. Provider resolution happens once

At creation, resolve a selection into a durable identity:

- xAI: `{provider: "xai", model: <exact configured model>}`
- local Agent: `{provider: <resolved runtime provider>, model: "runtime-managed"}`

The stored identity drives dispatch. `HostStore.claimNext(provider)` currently writes `agent_provider = ?` at claim time; that is the root violation of PRVD-02 and must be removed. A changed setting may make old work unavailable, but never eligible for silent rebinding.

### 2. Provider failures are states, not retry loops

The current pipeline retries `AgentUnavailableError` up to three times. A provider/model/auth failure after the transcript is committed must instead release the lease into a durable provider-paused state with the error, provider, model, and three user choices. A same-provider retry retains the snapshot. A different selection starts new work/session; it does not mutate the old snapshot.

### 3. xAI text is one strict client

Add one `XaiTextClient` using built-in `fetch` and existing credentials. It must:

- accept an exact model and bounded text input;
- call the fixed xAI HTTPS origin only;
- send `store:false` and no `tools` field;
- parse a non-empty textual response with explicit maximum sizes;
- return provider/model/request metadata without tokens or prompt bodies;
- expose separate summary and conversation probes that exercise the real request path.

### 4. xAI summary uses the current artifact transaction

Automatic summary:

1. Commit/reload the transcript through `ArtifactStore`.
2. Call xAI with instructions + transcript only.
3. Stage the returned Markdown.
4. Run `commitFromWorkspace` and `recordArtifacts`.
5. Record provider/model/`store:false` provenance.

Manual regeneration uses the same xAI client and the existing atomic `.summary.md` writer/stale-marker flow. Neither path exposes search or connector tools.

### 5. xAI conversation retrieves locally

Use `runSearchCli` first. Normalize and cap the hits before forming the request. The prompt numbers the bounded sources and requires bracket citations. The API response is accompanied by the exact local source projection regardless of model prose; no model-supplied file path or URL becomes a source.

The existing `agent-sessions.json` remains canonical local history. Add the provider/model snapshot and paused status to the session schema. For xAI, construct each request from a bounded tail of local messages plus the current bounded meeting excerpts. For Agent sessions, verify the current resolved runtime provider still matches `session.agent` before execution.

## Threat Model

| ID | Threat | Severity | Required mitigation |
|----|--------|----------|---------------------|
| T-10-01 | Provider/model silently changes between enqueue and execution | High | Immutable task/session snapshot; claim never overwrites it; mismatch pauses |
| T-10-02 | API/gateway secret leaks to config, DB, logs, child argv, or read-back API | High | Keychain stdin transport; config source gates; status-only browser response; redact safe errors |
| T-10-03 | OAuth token sent to an attacker-controlled URL | High | Fixed xAI origin plus existing `.x.ai` HTTPS validation; no configurable token endpoint outside discovery validation |
| T-10-04 | More local meeting data than intended leaves the Mac | High | Local search first; fixed source/count/per-item/total/history caps; request-shape tests; no full file reads for conversation |
| T-10-05 | xAI stores or searches supplied meeting data | High | `store:false`; omit tools/previous response/files/collections; negative request-body tests |
| T-10-06 | Model invents citations or local paths | Medium | Source cards only from normalized Yulu search hits; never accept model-provided source metadata |
| T-10-07 | Failed provider loops, spends money, or silently falls back | High | One explicit attempt per user/dispatcher action; durable pause; retry same snapshot only |
| T-10-08 | Malformed/oversized model output corrupts artifacts or UI | Medium | Response schema and size checks; existing ArtifactStore validation/atomic writes; React text rendering |
| T-10-09 | Public Grok CLI client registration remains in shipped Yulu | High | Replace with Yulu-owned registered client before live acceptance; package-source test rejects temporary client ID |

## Validation Strategy

- Unit/request-shape tests with injected `fetch` prove exact model, OAuth/API-key auth, `store:false`, no tools, response bounds, and safe errors.
- HostStore/session tests prove migration, immutable snapshots, provider mismatch pause, and retry semantics.
- Pipeline/router tests prove xAI writes the real Markdown artifact from transcript-only input and never invokes Agent/search/connector paths.
- Ask tests prove local search precedes network dispatch, excerpts/history are bounded, sources are local projections, and failure pauses the session.
- React tests prove independent selectors, separate readiness badges, secret non-readback, and explicit failure actions.
- A final live checkpoint uses one Yulu-owned xAI OAuth connection to run all three real probes, save one summary through the production path, and answer one local-meeting question with source cards.

## Open External Setup

The code currently embeds a temporary public Grok CLI OAuth client ID. Before Phase 10 can be accepted, a Yulu-owned xAI device client must be registered with the required scopes and its identifier supplied through the release build's established non-secret configuration path. No plan should hide this prerequisite behind the xAI API-key fallback.

