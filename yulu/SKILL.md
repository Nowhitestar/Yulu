---
name: yulu
description: "Yulu (语录) — native macOS recording with a durable local Host, explicit audio engines, and Agent-owned summaries, conversation, and connectors."
metadata:
  internal: true
  notice: "Internal architecture and developer guidance. The user-facing skill installed into Agents lives at skills/yulu/SKILL.md."
---

# Yulu internal skill

Yulu is an Agent-native macOS recorder. Preserve its responsibility boundary:

- Yulu owns native capture, permissions, durable tasks, idempotency, leases,
  artifact commit, authorization, recovery, and audit.
- Yulu's explicitly selected local/xAI audio engine owns realtime captions,
  final transcription, and dictation, with no automatic fallback.
- Yulu owns xAI device OAuth and stores its grant in macOS Keychain.
- The recording Agent owns summaries and explicitly authorized Notion delivery.
- The selected general Agent owns interactive conversation and its connectors.
- Python is capture and local workflow glue, not an AI runtime.

The authoritative runtime decisions are [`ADR-005`](spec/adr/005-agent-native-durable-recording-pipeline.md),
[`ADR-007`](spec/adr/007-explicit-audio-transcription-engines.md), and
[`ADR-008`](spec/adr/008-yulu-owned-xai-oauth.md).

## Product flow

```text
calendar / window / menu / CLI / MCP
                 |
                 v
Yulu.app -> native system audio + microphone -> local WAV
                 |
                 v
Python completion adapter -> Yulu Host -> durable task + lease
                                       |
                                       v
                           selected Yulu audio engine
                                       |
                                       v
                           Host commits transcript
                                       |
                                       v
                           Hermes summary workflow
                                       |
                                       v
                              Host commits summary
                                       |
                                       +-> optional Hermes Notion delivery

Agent Console -> selected general Agent -> that Agent's connectors
```

If the Host is unavailable after capture, the completion event is atomically
spooled and replayed. Do not add a fallback AI path to the capture process.

## Invariants

1. `Yulu.app` is the macOS capture and TCC identity.
2. Completed recordings must be absolute WAV paths inside the configured
   recordings root and match `<title>_YYYYMMDD_HHMMSS.wav`.
3. Automatic completion is idempotent. Replaying the same event must resolve to
   the same durable task.
4. Only the current task lease may advance progress or commit.
5. The Host commits the selected-engine transcript before summary work, then
   commits the Agent-produced summary from Host-controlled task artifacts.
6. Notion requires a task-level opt-in and a Host authorization after artifacts
   are committed.
7. An uncertain external delivery becomes `delivery_unverified`; never assume
   failure and retry blindly.
8. Hermes remains the automatic summary/delivery provider even when Agent Console
   selects another Agent for conversation.
9. Missing Hermes pauses summary work after transcript commit; the general Agent
   is never an implicit summary fallback.
10. Agent and connector credentials never belong in Yulu config or source.
11. Runtime databases, bearer tokens, task workspaces, sockets, and event spools
    stay machine-local.

## Runtime ownership

| Concern | Owner | Source of truth |
|---|---|---|
| Capture and live readiness | Native app | `audio_daemon.sock` and capture state |
| Completion handoff | Python capture edge | Authenticated Host request or `recording-events/` spool |
| Task state and audit | Host | `~/.config/yulu/host.sqlite` |
| Recording speech | selected Yulu audio engine | local model or direct xAI STT plus Host transcript artifact |
| Recording summary | Hermes | Hermes session plus Host-committed summary artifact |
| Artifact integrity | Host | artifact records, hashes, provenance, and final sidecars |
| Notion side effect | Hermes connector + Host authorization/audit | Notion delivery record keyed by task |
| Interactive conversation | selected general Agent | Agent Console session store and native Agent session |
| Search, prompts, glossary | Yulu local data | local SQLite and recording sidecars |

## Prefer MCP for Agent actions

The Host exposes an authenticated local MCP endpoint. Agents should prefer its
tools over shelling into internal scripts.

Important tools:

| Tool | Use |
|---|---|
| `recording_status` | Read live native capture state |
| `recording_start` | Start native capture with an optional title |
| `recording_stop` | Stop capture and enqueue the durable recording task |
| `recordings_list` / `recording_get` | Read recording metadata and artifacts |
| `recording_task_get` | Read durable task state and phase |
| `recording_task_progress` | Report semantic progress for the leased task |
| `recording_task_transcript_read` | Read only the current leased task's transcript through the Host |
| `recording_task_summary_stage` | Submit the final Markdown summary through the Host |
| `recording_artifact_commit` | Atomically commit the Host-controlled transcript and summary |
| `recording_begin_notion_delivery` | Request explicit side-effect authorization |
| `recording_committed_summary_read` | Read only the Host-verified summary in a fresh delivery phase |
| `recording_commit_notion_delivery` | Record the actual Notion page result |
| `recording_search` | Search local transcripts and summaries |
| prompt and glossary tools | Read or manage local Agent context |
| `health_check` | Read Host/runtime health |

The local endpoint is bearer-authenticated. Agents should use installed MCP
registration, not read or print `mcp-token.json`.

## Task workflow for Hermes

For a leased recording task:

1. Yulu's explicitly selected audio engine creates and durably commits the transcript.
2. In the Hermes artifact session, call `recording_task_transcript_read`; do not use filesystem tools.
3. Apply the snapshotted summary instructions, then call `recording_task_summary_stage`
   with the complete Markdown summary.
4. Call `recording_artifact_commit` with the current task ID and lease.
5. If the task does not authorize Notion, do not contact any external connector.
6. If authorized, start a fresh delivery session. Call
   `recording_begin_notion_delivery`, then `recording_committed_summary_read`, use
   Hermes' own Notion connector with the returned idempotency marker, and finally
   call `recording_commit_notion_delivery` with a page URL or ID. If begin returns
   a verified existing page, update it directly without search or create. Only a
   new delivery may use one exact-marker search and create after an explicitly
   empty result. The delivery session must never request or receive the raw transcript.
7. Report concise status. Agent prose does not replace the Host commits.

Never ask Yulu for speech-provider or Notion credentials. Never invoke a second
Yulu AI path from inside the Agent workflow.

## User-facing commands

```bash
# Capture
yulu record start "Meeting title"
yulu record status
yulu record stop

# Runtime health
yulu status
yulu doctor --json
curl -fsS http://127.0.0.1:7777/healthz

# Agent integration
yulu mcp status
yulu mcp test
yulu skill install --agent codex

# Dictation and voice chat
yulu dictate warm --json
yulu dictate once --no-paste --no-copy --json
yulu status-agent hotkeys

# Local knowledge
yulu search "query" --since 7d
yulu prompts list
yulu vocab list --json

# Lifecycle
yulu start
yulu stop
yulu restart
yulu logs ui
yulu where
```

`yulu record stop` completes capture and hands work to the Host. Do not instruct
users to run a separate speech or summary command.

## Configuration contract

Active config: `~/.config/yulu/config.json`.

Relevant sections:

- `audio`: native capture preferences and recording root;
- `agent_pipeline`: durable processing, automatic enqueue, explicit Notion
  opt-in, and destination hint;
- `transcription.engine`: explicit local/xAI selection; xAI OAuth is managed
  separately in Settings and is never a config field;
- `transcription.language` and `transcription.dictation`: language, prompt,
  context, timeout, and deadline preferences;
- `llm.agent.provider` / `llm.command`: general Agent Console runtime;
- `agent_console`: capability display and non-secret destination hints;
- `status_agent`: menu-bar and global shortcut preferences;
- `calendars` / `meeting_detection`: when to offer native recording;
- `ui.theme`: presentation.

The Host archives and removes retired inference and Yulu-owned external-delivery
settings. Never reintroduce archived runtime keys into the active config.
For recording delivery, `agent_pipeline.notion_destination` is authoritative;
Agent Console destination projections are display hints, not a second trigger.

See [`docs/configuration.md`](../docs/configuration.md).

## Task states

| State | Meaning |
|---|---|
| `queued` | Durable task waiting for a claim |
| `awaiting_agent` | Selected audio engine or summary Agent unavailable; no current lease |
| `running` | Current leased attempt is transcribing or summarizing |
| `transcript_committed` | Final transcript is durable; summary may still be pending |
| `artifacts_committed` | Transcript and summary are both committed |
| `sending` | Host authorized the Hermes Notion side effect |
| `delivery_reported` | Hermes reported a Notion page URL or ID |
| `completed` | Required audit passed |
| `failed` | Deterministic failure |
| `delivery_unverified` | External outcome uncertain; reconcile manually |
| `cancelled` | Intentionally ended |

Do not edit task state directly in SQLite.

## Code map

| Path | Responsibility |
|---|---|
| `scripts/Yulu.app/`, `audio_daemon.swift` | Signed native capture identity and implementation |
| `scripts/record_audio.py` | Capture start/stop/status adapter |
| `scripts/meeting_daemon.py` | Meeting workflow and completion-event submission/spooling |
| `scripts/dictate.py` | Mic capture, Host transcription transport, and clipboard/paste edge |
| `scripts/yulu_ui/src/server.ts` | Loopback Host, APIs, MCP dispatch, and UI server |
| `scripts/yulu_ui/src/hostStore.ts` | Durable task, lease, artifact, delivery, and event state |
| `scripts/yulu_ui/src/recordingPipeline.ts` | Admission, idempotency, claim, dispatch, and recovery |
| `scripts/yulu_ui/src/audioTranscription.ts` | Explicit local/xAI audio-engine selection with no fallback |
| `scripts/yulu_ui/src/xaiAudio.ts` | Direct xAI REST transcription and native realtime STT transport |
| `scripts/yulu_ui/src/xaiCredentials.ts` | Yulu-owned xAI device OAuth, refresh, and Keychain boundary |
| `scripts/xai_keychain.swift` | Signed macOS Keychain storage helper for xAI OAuth |
| `scripts/yulu_ui/src/agentGateway.ts` | Hermes summary/delivery workflow boundary plus tool-call audit |
| `scripts/yulu_ui/src/artifactStore.ts` | Task workspace and atomic artifact commit |
| `scripts/yulu_ui/src/recordingEventInbox.ts` | Replay capture-completion events after Host downtime |
| `scripts/yulu_ui/src/agentRuntime.ts` | Hermes recording resolution and separate general-Agent resolution |
| `scripts/yulu_ui/src/mcp.ts` | Authenticated Agent tools and resources |
| `scripts/doctor.py` | Read-only installed/source/runtime diagnosis |
| `scripts/config.example.json` | Current non-secret configuration example |

## Installation and local development

Stable installation:

Download `yulu-macos-arm64-vX.Y.Z.dmg` from
[GitHub Releases](https://github.com/Nowhitestar/Yulu/releases), open it, and
drag `Yulu.app` into `/Applications`.

Development checkout:

```bash
git clone https://github.com/Nowhitestar/Yulu.git
cd Yulu
bash yulu/scripts/setup.sh --dev
```

After source changes, synchronize the installed runtime before live acceptance:

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

Do not infer installed behavior from checkout tests alone.

## Permissions

| Component | Permission | Purpose |
|---|---|---|
| `Yulu.app` | Microphone | Local microphone capture |
| `Yulu.app` | Screen & System Audio Recording | ScreenCaptureKit system audio |
| window scanner | Accessibility | Meeting/call window detection |

Use `yulu repair-permissions` for the supported repair flow. The Host and Python
scripts cannot bypass macOS privacy controls.

## Troubleshooting order

1. **Capture:** `yulu status` and the native socket response.
2. **Host:** `/healthz`, the installed `com.yulu.ui.plist`, the port-7777
   listener, and `yulu logs ui`. Never use `launchctl print` for diagnosis
   because its service document can contain credential-bearing environment fields.
3. **Durability:** `yulu doctor --json` → `host_tasks` and the task state/error.
4. **Hermes:** Agent capability in doctor and Hermes visibility on the stable
   LaunchAgent PATH.
5. **Artifacts:** both committed sidecars plus Host artifact records.
6. **Notion:** task opt-in, delivery record, and destination reconciliation.

Keep these layers separate. A healthy capture does not prove Hermes succeeded;
a Notion page does not prove the Host recorded a safe completion.

See [`docs/operations.md`](../docs/operations.md) for exact checks.

## 中文摘要

Yulu 的产品边界是：macOS 原生录音 + 本地可信 Host。Yulu 明确选择本地或 xAI
音频引擎，统一负责实时字幕、最终转写和听写，不做自动回退；Yulu 自己管理 xAI
OAuth 并保存到 macOS 钥匙串。录音 Agent 负责纪要和明确授权的 Notion 投递；Agent
Console 选择的通用 Agent 负责对话和自己的连接器；Python 只做录音边缘控制和
Host 事件投递。不要在 Yulu 内新增第二套对话或连接器执行路径。
