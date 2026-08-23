<!-- GSD:project-start source:PROJECT.md -->
## Project

**Yulu (语录)** is an Agent-native macOS meeting recorder. It captures system
audio and microphone input through one native TCC identity, persists each
completed recording as durable local work, and keeps audio transcription
separate from the selected summary and conversation Agents.

### Responsibility boundary

- `Yulu.app` owns native capture and macOS privacy permissions.
- The local Yulu Host owns path validation, durable tasks, idempotency, leases,
  recovery, artifact commits, authorization, and audit.
- The explicitly selected Yulu audio engine owns realtime captions, final
  transcripts, and dictation. `local` is the default; `xai` connects directly
  to xAI using Yulu-owned OAuth stored in macOS Keychain.
- Hermes owns automatic summary generation and explicitly authorized Notion
  delivery. It is not an audio execution dependency.
- The Agent selected in Agent Console owns interactive conversation and its own
  connectors.
- Python is capture/scheduling/desktop glue. It is not an AI runtime.

Do not add automatic fallback between audio engines, another summary worker,
chat engine, connector executor, or file-only work queue to Yulu. The accepted
decisions are [`ADR-005`](yulu/spec/adr/005-agent-native-durable-recording-pipeline.md),
[`ADR-007`](yulu/spec/adr/007-explicit-audio-transcription-engines.md), and
[`ADR-008`](yulu/spec/adr/008-yulu-owned-xai-oauth.md).

### Constraints

- **Platform:** macOS 13+ is the shipped capture platform.
- **Privacy:** raw capture is local; `local` transcription stays on-device and
  the explicitly selected `xai` engine uploads audio directly to xAI. Agent
  summary processing follows Hermes' provider configuration.
- **Durability:** task completion requires Host state and committed artifacts,
  not Agent prose or the presence of one sidecar file.
- **Side effects:** Notion requires per-task opt-in and Host authorization;
  uncertain delivery is never blindly replayed.
- **Compatibility:** upgrade code archives retired settings, imports resolvable
  historical work, and unloads retired services.
<!-- GSD:project-end -->

<!-- GSD:stack-start source:codebase/STACK.md -->
## Technology Stack

### Languages and runtimes

- Swift 5: `audio_daemon.swift`, window/status/menu-bar helpers.
- TypeScript 5.6: loopback Host, durable coordinator, MCP, tRPC, and React UI.
- Python 3.8+: capture edge, meeting/calendar scheduling, dictation transport,
  installer, diagnostics, and CLI helpers.
- Bash: setup, lifecycle, packaging, and the `yulu` command dispatcher.
- Node.js 20.19+, 22.12+, or 24: Host and web UI; use the checked-in npm lockfile.

### Main dependencies

- macOS ScreenCaptureKit and AVFoundation for native capture.
- Hono, tRPC, Zod, WebSocket, and `better-sqlite3` for the Host.
- React, React Router, TanStack Query, Vite, and wavesurfer.js for the UI.
- Hermes CLI for automatic recording summaries and authorized Notion delivery.
- `sherpa-onnx` Paraformer for the Yulu-managed local audio engine.
- `ffmpeg`/`sox` for audio inspection and transport preparation, including xAI
  batch-upload compression.
- Optional `gog`/`cloudflared` only for Yulu-owned calendar scheduling.

Yulu installs and manages only its local speech runtime. Connector credentials
and OAuth state belong to the Agent, not this repository or `config.json`;
Yulu's separate xAI audio OAuth grant is stored in macOS Keychain.

### Configuration and state

- Active config: `~/.config/yulu/config.json`.
- Current schema reference: `yulu/scripts/config.example.json` and
  `docs/configuration.md`.
- Durable task source of truth: `~/.config/yulu/host.sqlite`.
- Recording content: `~/Movies/Yulu/` by default.
- Private task staging: `~/.config/yulu/agent-tasks/`.
- Completion-event recovery inbox: `~/.config/yulu/recording-events/`.
- Local bearer token: `~/.config/yulu/mcp-token.json`; never print it.

Relevant config sections are `audio`, `transcription` (engine, language, and
dictation context), `agent_pipeline`, `llm`,
`agent_console`, `status_agent`,
`calendars`, `meeting_detection`, and `ui`.

### Build and verification

```bash
python3 -m pytest -q
cd yulu/scripts/yulu_ui
npm test
npm run typecheck
npm run build
```

After product changes, synchronize and verify the installed runtime:

```bash
make dev-install
python3 yulu/scripts/doctor.py --json
curl -fsS http://127.0.0.1:7777/healthz
```

Do not infer live behavior from checkout tests alone.
<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->
## Conventions

### Change discipline

- Preserve the Agent-native ownership boundary above.
- Keep one recording pipeline and one artifact commit boundary.
- Make task state transitions explicit and test them at their durable seam.
- Treat automatic completion as idempotent; manual reprocessing is an explicit
  new attempt.
- Never edit user config, Host SQLite, recordings, tokens, or credentials in
  repository tests.

### Host and TypeScript

- `hostStore.ts` owns durable task, event, lease, artifact, and delivery state.
- `recordingPipeline.ts` owns admission, claims, selected-engine transcription,
  state transitions, summary dispatch, and recovery.
- `artifactStore.ts` commits the transcript independently, then validates and
  replaces the final summary sidecar.
- `agentGateway.ts` is the Hermes summary/delivery boundary and audits required
  Host tool calls.
- Only the current lease may report progress, commit, authorize delivery, report
  delivery, or complete a task.
- Keep MCP and tRPC schemas validated with Zod. Do not expose lease tokens in
  public task reads or persisted event details.

### Python and Swift

- Python controls capture, submits/spools completion events, and handles local
  desktop workflow. New inference or connector behavior does not belong there.
- Completion spools and other state files use private permissions, temp files,
  flush/fsync where required, and atomic rename.
- Swift `Yulu.app` remains the only microphone/system-audio TCC identity.
- Do not replace the native capture arm with a cross-platform Python recorder.

### Configuration

- Credentials are never stored in `config.json`.
- `agent_pipeline.auto_send_notion=true` is real side-effect authorization.
- `llm.agent.provider` selects the general Agent only; audio uses the separate
  explicit `transcription.engine`, while automatic summaries remain Hermes-backed.
- Retired inference and Yulu-owned connector fields are archived with mode
  `0600` and removed from active config. Never reintroduce them.
- Use atomic config writes and preserve unknown forward-compatible keys unless
  they belong to a retired runtime.

### Errors and observability

- Separate native capture, Host reachability, Hermes availability, artifact
  commit, and Notion delivery in diagnostics.
- A Host restart during a possible external write yields
  `delivery_unverified`, not an automatic retry.
- `/healthz` proves only that the loopback Host is listening.
- Doctor checks are read-only and should return structured error data instead of
  throwing through the report.
<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->
## Architecture

### Recording flow

```text
calendar / window / menu / CLI / MCP
                 |
                 v
Yulu.app native capture -> local WAV
                 |
                 v
Python completion adapter -> authenticated loopback Host
                 |                         |
                 |                         +-> host.sqlite task + lease + audit
                 | Host unavailable
                 +-> atomic event spool ---+
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
                                           +-> Host commits summary
                                           +-> optional authorized Hermes Notion

Agent Console -> selected general Agent -> that Agent's connectors
```

### Runtime components

| Component | Responsibility |
|---|---|
| `Yulu.app` / `audio_daemon.swift` | ScreenCaptureKit + AVFoundation capture; start/stop/status over `audio_daemon.sock` |
| `record_audio.py` / `meeting_daemon.py` | Capture control and authenticated completion delivery/spooling |
| `yulu_ui/src/server.ts` | Loopback Host, tRPC, WebSocket, UI, and authenticated MCP |
| `hostStore.ts` | Durable task, event, lease, artifact, and delivery records |
| `audioTranscription.ts` | Explicit local/xAI realtime, final, and dictation selection without fallback |
| `xaiAudio.ts` / `xaiCredentials.ts` / `xai_keychain.swift` | Direct xAI STT plus Yulu-owned device OAuth and Keychain storage |
| `recordingPipeline.ts` | Validation, idempotency, claims, transcript commit, summary dispatch, recovery |
| `agentGateway.ts` | Hermes summary/delivery workflow and required-tool audit |
| `artifactStore.ts` | Task staging and independent transcript/summary commits |
| `recordingEventInbox.ts` | Replay completion events after Host downtime |
| `agentRuntime.ts` | Separate Hermes recording resolution and general-Agent resolution |
| prompt/glossary/search stores | Local context and discovery; no AI execution |

### Installed services

| launchd label | Purpose |
|---|---|
| `com.yulu.audiodaemon` | Native audio capture |
| `com.yulu.statusagent` | Menu bar, recording status, and global shortcuts |
| `com.yulu.ui` | Local Host and web UI |
| `com.yulu.detector` | Meeting-window detection |
| `com.yulu.scheduler` | Local schedule actions |
| `com.yulu.calendar` | Optional calendar synchronization |

There is no active STT or Agent-queue LaunchAgent.

### Durable and security invariants

1. Completed recordings are real absolute WAV paths within the configured
   recording root and follow the recording stem contract.
2. Only the current attempt lease can mutate a task.
3. The selected Yulu audio engine produces the transcript, which the Host commits
   before Hermes summary work. Hermes never performs production transcription.
4. Hermes stages the summary through Host tools; Notion can begin only after the
   summary is committed and the task opted in.
5. A Notion result must include a page URL or ID and the stable
   `yulu-<task-id>` marker through the Hermes connector workflow.
6. The Host binds to loopback, validates Host headers and recording roots, and
   requires a constant-time-checked bearer token for mutating/Agent/MCP paths.
7. Runtime databases, task workspaces, sockets, tokens, and event spools remain
   machine-local.

### Task states

```text
queued -> running -> transcript_committed -> artifacts_committed -> completed
   |          |                |                       |
   |          |                +-> awaiting_agent      +-> sending -> delivery_reported -> completed
   |          +-> failed
   +-> awaiting_agent

possible external-write uncertainty -> delivery_unverified
```

### ADR status

- ADR-005 remains the durable task and Agent workflow decision.
- ADR-007 supersedes the audio ownership and fallback decisions in ADR-005 and ADR-006.
- ADR-002 remains relevant for glossary data; the selected audio engine consumes that context.
- Historical ADR bodies remain history and must not be treated as active
  implementation instructions.

### Anti-patterns

- Adding another audio engine or automatic engine fallback outside ADR-007.
- Using a JSON/file queue as active task ownership.
- Running summary or connector code from Python capture paths.
- Letting the general conversational Agent silently replace Hermes for
  recording work.
- Writing final transcript/summary files outside the Host commit contract.
- Calling Notion without task opt-in, Host begin authorization, and Host result
  commit.
- Retrying `delivery_unverified` work before reconciling the destination.
<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->
## Project Skills

The user-facing Yulu Agent contract is [`skills/yulu/SKILL.md`](skills/yulu/SKILL.md).
The internal architecture/developer guide is [`yulu/SKILL.md`](yulu/SKILL.md).
<!-- GSD:skills-end -->

## Agent skills

### Issue tracker

Issues and specs are tracked in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the five default triage labels. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context domain model. See `docs/agents/domain.md`.

<!-- GSD:workflow-start source:GSD defaults -->
## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:
- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->
## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
