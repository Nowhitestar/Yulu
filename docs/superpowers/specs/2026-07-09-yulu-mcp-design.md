# Spec: Yulu HTTP MCP

> Status: approved design, awaiting implementation plan
> Date: 2026-07-09
> Scope: Add a token-protected MCP endpoint to the existing Yulu UI service and auto-register it with detected local agents.

## 1. User Outcome

Yulu should install as a first-class MCP server for the local agents the user
already trusts: Codex, Claude Code, OpenClaw, and Hermes. After install, any
detected agent can operate Yulu through MCP: inspect recordings, read transcripts
and summaries, search meeting history, trigger re-transcription or re-summary,
and maintain lightweight metadata, prompts, and glossary terms.

Yulu remains the local capture and storage layer. The selected agent remains the
reasoning and connector layer.

Terminology: the original request said "Open Cloud"; this spec treats that as
the existing Yulu-supported `OpenClaw` agent.

## 2. Decisions

- Use the existing `yulu_ui` service and mount MCP at
  `http://127.0.0.1:7777/mcp`.
- Use Streamable HTTP MCP through the official TypeScript SDK.
- Add no second MCP daemon and no second HTTP port.
- Add token auth for `/mcp`; localhost binding alone is not enough.
- During install/update, automatically register Yulu MCP only with agents whose
  CLIs are detected on the host.
- Missing agents are skipped silently except for a summary line.
- Registration failures warn but do not fail core Yulu install.
- Keep one Yulu MCP behavior surface. Agent-specific code is limited to install
  adapters because each agent has a different MCP registration command.
- Expose audio handles, paths, URLs, and metadata. Do not inline WAV bytes or
  base64 audio in MCP responses.
- Do not expose destructive system operations in v1: no recording delete,
  uninstall, global daemon stop, or broad config mutation.

## 3. Architecture

```text
Codex / Claude Code / OpenClaw / Hermes
        |
        | Streamable HTTP MCP + bearer token
        v
http://127.0.0.1:7777/mcp
        |
        v
yulu_ui MCP adapter
        |
        v
Existing Yulu seams:
- recordings/search/prompts/glossary routers or shared helpers
- audio/status Unix sockets
- agent-queue.json
- prompts.sqlite / vocab.sqlite / search.sqlite
- ~/Movies/Yulu recording artifacts
```

The MCP endpoint lives inside `yulu_ui` because that process already owns the
local HTTP port, runtime paths, config manager, DB handles, launchctl client, job
registry, and pubsub. Adding a second MCP daemon would duplicate lifecycle and
install complexity without a v1 benefit.

Implementation should reuse existing helpers first. Where behavior currently
lives only inside a tRPC router, extract the smallest shared helper needed by
both tRPC and MCP. Do not clone large router logic into MCP.

## 4. Auth And Token

Create or reuse a local token file:

```text
~/.config/yulu/mcp-token.json
```

Shape:

```json
{
  "token": "<random 32+ bytes>",
  "created_at": "2026-07-09T00:00:00Z",
  "endpoint": "http://127.0.0.1:7777/mcp"
}
```

Rules:

- File mode is `0600`.
- `yulu mcp install` reuses an existing token.
- `yulu mcp rotate-token` generates a new token and re-registers detected
  agents.
- `/mcp` accepts `Authorization: Bearer <token>`.
- If an agent cannot store bearer auth directly, its install adapter may use an
  equivalent header such as `X-Yulu-MCP-Token`.
- No token or wrong token returns `401`.

## 5. MCP Resources

Resources are useful for clients that expose MCP resources well. Tools mirror
the same read surface because support varies across agents.

- `yulu://recordings`
  - Recent recordings with stem, title, recordedAt, duration, status,
    transcript/summary flags, and tags.
- `yulu://recordings/{stem}`
  - Full recording detail: metadata, audio path/url, transcript, summary,
    realtime transcript, and speaker data.
- `yulu://recordings/{stem}/transcript`
- `yulu://recordings/{stem}/summary`
- `yulu://search?q=...`
- `yulu://prompts`
- `yulu://glossary`
- `yulu://queue`
- `yulu://health`

Audio resources return `wavPath`, `audioFile`, protected local `audioUrl`,
duration, size, and mtimes. They do not return inline WAV bytes.

## 6. MCP Tools

### Recording Control

- `recording_status`
- `recording_start(title?)`
- `recording_stop`

### Recording Reads And Search

- `recordings_list(limit?, since?)`
- `recording_get(stem)`
- `recording_search(query, since?, kinds?, limit?)`

### Lightweight Recording Mutation

- `recording_rename(stem, title)`
- `recording_set_tags(stem, tags)`
- `speaker_rename(stem, speakerId, displayName)`
- `speaker_merge(stem, fromSpeakerId, toSpeakerId)`
- `speaker_assign_segment(stem, segmentIndex, speakerId)`

### Processing

- `recording_transcribe(stem, diarizationNumSpeakers?, transcriptionModel?)`
- `recording_summarize(stem, promptId?)`
- `summary_send(stem, channel)`

`summary_send` delegates to the selected agent connector path, matching Agent
Console behavior. Yulu does not store or manage Notion/Zulip credentials.

### Prompts

- `prompts_list(category?)`
- `prompt_get(id)`
- `prompt_create(slug, name, category, content, isAutoRun?)`
- `prompt_update(id, fields...)`
- `prompt_delete(id)`

### Glossary

- `glossary_list`
- `glossary_add(term, canonical?, scope?, notes?)`
- `glossary_update(id, fields...)`
- `glossary_delete(id)`

### Queue And Health

- `queue_list`
- `queue_retry(id)`
- `queue_cancel(id)`
- `queue_clear_stale`
- `health_check`

## 7. Explicit v1 Non-Goals

- No `recording_delete`.
- No daemon stop/restart tools.
- No uninstall tools.
- No broad `config_update` tool.
- No inline audio binary/base64 reads.
- No remote MCP access.
- No per-agent Yulu business logic forks.

If audio bytes are needed later, add a deliberately named tool with explicit
range/size caps and audit-friendly semantics, such as `recording_audio_read`.

## 8. Agent Registration

Add a provisioning module for MCP installation and status:

```text
yulu/scripts/provision/mcp.py
```

Add CLI entry points:

- `yulu mcp status`
- `yulu mcp install`
- `yulu mcp install --agent codex --agent claude`
- `yulu mcp remove --agent ...`
- `yulu mcp rotate-token`
- `yulu mcp test`

The install/update tail runs:

```bash
yulu mcp install --detected-only --non-fatal
```

Adapter behavior:

- Codex: use `codex mcp add yulu --url http://127.0.0.1:7777/mcp ...`.
- Claude Code: use `claude mcp add --transport http --scope user yulu ...`.
- Hermes: use `hermes mcp add yulu --url http://127.0.0.1:7777/mcp ...`.
- OpenClaw: use `openclaw mcp set yulu '<json config>'`.

Every adapter uses argv lists, never shell strings. Each adapter should have a
status/test path that reads back the configured MCP where the agent supports it.

## 9. Internal Modules

Node:

- `yulu_ui/src/mcp/server.ts`
  - Creates the MCP server, registers tools/resources, and attaches to Hono.
- `yulu_ui/src/mcp/auth.ts`
  - Reads and validates the token.
- `yulu_ui/src/mcp/tools.ts`
  - Tool schemas and handlers.
- `yulu_ui/src/mcp/resources.ts`
  - `yulu://...` resource routing.
- `yulu_ui/src/recordingsCore.ts`
  - Minimal shared helper extracted from `routers/recordings.ts` only if needed.

Python/shell:

- `yulu/scripts/provision/mcp.py`
  - Token generation, agent detection, registration, removal, and smoke tests.
- `yulu/scripts/provision/cli.py`
  - Adds `mcp` subcommands.
- `yulu/scripts/yulu`
  - Dispatches `yulu mcp ...`.
- `setup.sh`, update flow, and `uninstall.sh`
  - Install/update registration and uninstall cleanup prompt.

## 10. Testing

Node tests:

- `/mcp` without a token returns `401`.
- `/mcp` with a wrong token returns `401`.
- `/mcp` with the correct token can initialize and list tools.
- `recordings_list` and `recording_get` read fixture metadata correctly.
- `yulu://recordings/{stem}/summary` returns the expected summary.
- Tool list does not include dangerous v1 exclusions.
- Recording detail returns audio path/url/metadata, not WAV bytes.
- Typecheck and build pass.

Python/provision tests:

- First run creates token file with mode `0600`.
- Existing token is reused.
- Rotation changes the token.
- `--detected-only` skips missing CLIs.
- Agent registration commands are argv lists and match current CLI contracts.
- Registration failure with `--non-fatal` returns success with a warning.
- OpenClaw JSON config is valid and correctly escaped.

Manual smoke:

- `yulu mcp status`
- Authenticated `/mcp` initialize/list-tools request.
- `codex mcp get yulu`
- `claude mcp get yulu`
- `hermes mcp test yulu`
- `openclaw mcp show yulu --json`
- In at least one agent session:
  - list the five latest recordings,
  - search a keyword,
  - read one meeting summary,
  - trigger re-summary for one recording.

## 11. Done Criteria

- Existing Yulu UI keeps working on `127.0.0.1:7777`.
- `/mcp` is mounted on the same service and requires token auth.
- Installed local agents that are detected during install/update get a `yulu`
  MCP registration.
- Missing agents are skipped.
- Registration failures are non-fatal to core install.
- MCP can read meetings, search, trigger transcription/summary, edit lightweight
  metadata, and manage prompts/glossary/queue.
- MCP cannot delete recordings, uninstall Yulu, stop global services, mutate
  broad config, or inline WAV bytes.
- No Yulu business logic is forked per agent.

## 12. References

- MCP Streamable HTTP transport:
  https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- MCP TypeScript SDK:
  https://github.com/modelcontextprotocol/typescript-sdk
