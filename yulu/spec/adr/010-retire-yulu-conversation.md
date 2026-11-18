# ADR-010: Retire Yulu-owned conversation

**Status**: Accepted
**Date**: 2026-11-18
**Supersedes**: decision 4 of [ADR-005](005-agent-native-durable-recording-pipeline.md)
(the general Agent owns conversation through Agent Console) and the conversation
scope of [ADR-009](009-grok-cli-compatible-xai-oauth.md) (one credential "may
serve … local-meeting conversation"). ADR-008 carries no conversation decision.
In `docs/adr/` it also replaces the Conversation paragraph of 0004, Conversation
as an Optional Capability in 0006 and 0011, interactive Agent calendar access in
0009, and the Agent Console and voice-chat mentions in 0025 and 0027.

## Context

The web UI no longer has an Agent Console, a voice-chat window, or an "ask the
assistant" shortcut. Other Agents reach meetings through Yulu's authenticated
MCP endpoint, where the user's own Agent already owns the conversation, its
history, and its connectors. A Yulu-hosted chat duplicated that.

The Host still carried the whole capability with no surface: Conversation
Providers and probes, a session store, the `ask` pipeline, Hermes/OpenClaw
conversation-only adapters, onboarding steps, and the voice-chat transport in
Python and Swift. Two live features had also grown onto it:

- Dictation cleanup and voice translation send dictated text to xAI only when
  `intelligence.conversation` selects xAI and the xAI Conversation disclosure
  was accepted. That disclosure describes meeting excerpts, not dictated text.
- Sharing runs its Codex/Claude Code connector with the model stored as the
  connection's `conversationModel`.

## Decision

1. **Yulu has no conversation capability.** Agent Connections provide Summary
   only; transcription stays with the audio engine (ADR-007). Questions about
   meetings are asked in the user's own Agent over Yulu MCP. Conversation
   Providers, sessions, probes, Unknown-Outcome fences, disclosures, the
   voice-chat endpoint, and the Agent Console API are removed.
2. **Hermes and OpenClaw are MCP clients, not Agent Connections.** Their
   conversation-only adapters are removed and discovery stops offering them.
   `yulu mcp` and the MCP settings still register Yulu with them.
3. **Dictation text gets its own explicit selection and disclosure**.
   `transcription.dictation.text_provider` (`none` | `xai`, default `none`)
   and an explicit `cleanup_model` replace the dependency on the Conversation
   selection. A dictation-specific disclosure says that dictated text is sent to
   xAI. It still runs only with the `xai` audio engine and never falls back.
4. **The Agent Calendar Connector is retired with it**. Interactive
   Agent calendar access existed for the conversation; Calendar Sources are
   unaffected.
5. **Sharing is unchanged.** It keeps reading the persisted `conversationModel`
   setting of the selected Agent Connection as its connector model. The key is
   not renamed: it is part of the connection revision that existing Test Share
   receipts are bound to.
6. **Native controls lose the voice-chat path.** The `voice_chat`,
   `open_voice_chat` and `open_agent_console` IPC actions, the voice-chat panel,
   the `ask`/`ask-toggle` commands and their CLI wrappers are removed.

## Migration

Nothing is replayed, and no stored conversation is sent anywhere.

- **Config.** Before the schema is read, `intelligence.conversation`,
  `transcription.dictation.voice_chat_scope`, `status_agent.hotkeys.voice_chat`
  and `agent_console` are written to a mode-`0600` archive beside `config.json`
  and removed from the active file. A config written by an older version loads.
- **Dictation**. If the archived Conversation selection was xAI,
  `text_provider` becomes `xai` and a `cleanup_model` of `conversation` becomes
  the model that was pinned; otherwise `text_provider` is `none`. An accepted
  xAI Conversation disclosure keeps counting for those migrated users, so
  cleanup neither stops nor starts for anyone on upgrade. New consent is
  recorded as the dictation disclosure.
- **Sessions**. `agent-sessions.json` is renamed once to a mode-`0600`
  archive in the same directory and never read again. It is not parsed, so a
  damaged file cannot block startup. Application Migration still carries the
  file over from a legacy install.
- **Host SQLite.** No schema change. Conversation disclosure receipts, readiness
  history, Unknown-Outcome fences, Optional Capability Outcomes, the calendar
  connector selection, and Hermes/OpenClaw connection rows stay as inert rows.
- **Onboarding.** The manifest lists Calendar Source and Sharing. Existing
  completions stand; a user who had only the retired steps left is complete.
- **Legacy StatusAgent retirement.** Application Migration still requires a
  legacy StatusAgent to report `voice_chat_window_visible: false`. The native
  status reply keeps that one constant so a development build can be retired;
  the URL field and the TypeScript projections are removed.

## Rejected alternatives

- **Keep the Host capability dormant.** Unreachable code still owns probes,
  consent receipts and startup recovery, and keeps a second chat engine in the
  tree that CLAUDE.md forbids adding.
- **Delete conversation history.** It is the user's data; an archive costs
  nothing and matches how retired settings are handled.
- **Rebuild SQLite tables to drop `conversation`.** It changes a schema that
  Application Update rollback must still read, to remove rows nothing reads.
- **Let dictation cleanup follow the xAI audio consent.** It would start
  sending dictated text to the xAI text model for users who never enabled it.

## Consequences

- One fewer provider selection, disclosure, probe and recovery path; the Host
  no longer starts or resumes Agent chat sessions.
- Dictation cleanup is selectable again from Voice settings and its consent
  names what is actually sent.
- A user who relied on Agent Console must use an Agent with Yulu MCP. Earlier
  conversations are readable only from the archive file.
- `llm.*` remains migration input for Agent Connections and for the Python
  capability probes; it no longer selects anything in the Host.
