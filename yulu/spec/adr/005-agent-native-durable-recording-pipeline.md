# ADR-005: Agent-native durable recording pipeline

**Status**: Accepted
**Date**: 2026-07-11
**Supersedes**: [ADR-001](001-resident-stt-daemon.md), [ADR-003](003-realtime-as-daemon-subscriber.md), and the runtime execution decision in [ADR-004](004-prompt-library.md)

## Context

Yulu was accumulating a second copy of capabilities already supplied by the
user's local Agents: speech recognition, meeting summarization, conversation,
and connector execution. That duplication created multiple execution paths,
provider-specific configuration, non-durable handoffs, and failures that were
hard to distinguish from capture failures.

The product is intentionally Agent-native. Its durable value is native macOS
capture plus a trustworthy local control plane, not another AI runtime.

## Decision

Adopt one recording pipeline with the following ownership boundary:

1. **Yulu owns native capture.** `Yulu.app` captures system audio and microphone
   input behind macOS privacy controls. Python scripts are capture-edge adapters:
   they start or stop capture and submit a completed-recording event to the
   loopback Host. If the Host is temporarily unavailable, they atomically spool
   the event for replay.
2. **The Yulu Host owns durable coordination.** It validates recording paths,
   persists tasks and audit events in `host.sqlite`, derives idempotency keys for
   automatic completion events, issues per-attempt leases, and recovers
   interrupted tasks without guessing whether an external side effect succeeded.
3. **Hermes owns the recording intelligence.** Hermes performs speech
   recognition, reads the chosen summary instructions, writes the final summary,
   and uses its own Notion connector when the task explicitly authorizes delivery.
   Recording work remains pinned to Hermes even when another Agent is selected
   for interactive conversation. If Hermes is unavailable, the durable task waits;
   the Host does not fall back to the general Agent.
4. **The selected general Agent owns conversation and its connectors.** Agent
   Console can use Codex, Claude Code, Hermes, OpenClaw, or an explicit command.
   Yulu supplies local recording resources and task tools; it does not implement
   a conversation or connector engine.
5. **Artifacts cross a fixed capability boundary.** The Host stages the Hermes
   transcript in a task-scoped directory, but does not give the artifact session
   a general filesystem tool. A dedicated `yulu_artifact` MCP lets that leased
   task read its transcript, stage one summary, and commit the fixed pair. The Host
   validates the pair, atomically replaces each target, records both metadata rows
   in one database transaction, and advances the task only after both writes. It
   records hashes, sizes, MIME types, provenance, and the audited artifact session.
6. **Notion is a separately authorized side effect.** A task may begin delivery
   only after its artifacts are committed. Before exposing the connector, the
   Host durably enters `sending` and returns a stable delivery key. Hermes includes
   it through its own connector, and the Host records the resulting page URL or
   ID. Repeated delivery updates a Host-verified page directly instead of relying
   on eventually consistent search. A restart during delivery becomes
   `delivery_unverified`; Yulu never silently retries an uncertain external write.
   This recording-artifact delivery is distinct from a Notion action requested in
   an interactive conversation, which belongs to the selected general Agent.
7. **The Host boundary is local and authenticated.** It listens on loopback,
   rejects non-local Host headers, and requires the per-install bearer token for
   completion events, Agent transcription requests, and MCP operations.
8. **Artifact and delivery sessions are isolated.** Authorized Notion delivery
   starts a new native Hermes session with only `yulu_delivery,notion`; it never
   resumes the artifact session that saw the raw transcript. The delivery MCP
   exposes only a Host-record/hash-verified committed summary. Session audit
   rejects extra connectors, multiple writes, unparseable marker searches, create
   after a match, search/create when a verified page is already known, update of a
   different page, or a write result inconsistent with the committed URL/ID.

The primary task flow is:

```text
queued -> running/transcribing -> summarizing -> artifacts_committed
       -> [sending -> delivery_reported] -> completed
```

An unavailable Hermes runtime yields `awaiting_agent`. Deterministic processing
errors yield `failed`. An uncertain Notion outcome yields
`delivery_unverified` and requires human reconciliation.

The policy switches have different scopes. `agent_pipeline.enabled=false` moves
all dispatchable work to `awaiting_policy` and disables manual processing plus
on-demand Hermes transcription. `auto_process_recordings=false` pauses only
automatic intake and automatic tasks; manual reprocessing and dictation remain
available. A user may promote an automatic `awaiting_policy` task to manual work
without creating a second task. Completion events rejected by either policy are
permanently acknowledged rather than retained as an implicit future backlog.

## Rejected alternatives

- **Keep a Yulu-owned inference service.** This duplicates Hermes, expands the
  dependency and failure surface, and makes provider behavior a Yulu concern.
- **Use an in-memory or file-only handoff.** It cannot provide transactional
  claims, leases, state recovery, artifact provenance, or side-effect auditing.
- **Let every conversational Agent run the recording pipeline.** Interactive
  Agent choice should not change the product's speech and recording contract.
  Hermes is the explicit recording capability provider.
- **Let Yulu call Notion directly.** That would duplicate connector credentials,
  OAuth, retry semantics, and capability discovery already owned by the Agent.
- **Commit files independently.** A summary without its matching transcript (or
  the reverse) is not a valid completed task.

## Consequences

**Positive**

- Capture failures, Agent availability, artifact validation, and delivery
  uncertainty have distinct observable states.
- Automatic recording completion is idempotent; concurrent workers cannot own
  the same attempt because commits require the current lease.
- Agent capabilities evolve outside Yulu while Yulu keeps a stable local task,
  permission, artifact, and audit contract.
- The artifact phase has no arbitrary file capability, and the delivery phase has
  neither raw transcript context nor access to mutable staging files.
- Notion credentials and connector configuration remain in Hermes.
- Uncertain Notion writes have explicit human exits: confirm the existing page
  as completed, or abandon/cancel the delivery without replaying the side effect.

**Trade-offs**

- Hermes is now a runtime prerequisite for automatic recording processing and
  voice transcription.
- Speech processing follows Hermes' own provider and privacy policy; users must
  understand that enabling the Agent pipeline may send audio through the
  provider configured in Hermes.
- The Host database and task workspaces become operational state that must stay
  machine-local and be included in diagnostics.

## Migration

On startup or upgrade, Yulu archives and removes retired inference and connector
settings from active configuration, archives actionable legacy handoffs without
executing them, and removes retired LaunchAgents. Archives are retained for audit
and are not active runtime inputs. A preserved recording must be reprocessed
explicitly from the current UI if the user still wants that work.

The prompt catalog remains useful as user-selected instructions. ADR-002 remains
accepted for glossary data; this ADR changes who consumes that context and who
executes the AI work.
