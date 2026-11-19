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
   and `transcription.dictation.text_model` (an exact xAI model, default
   `grok-4.6`) replace the dependency on the Conversation selection and the
   retired `cleanup_model`. A dictation-specific disclosure
   (`xai-dictation-text-v1`) says that dictated text is sent to xAI. It still
   runs only with the `xai` audio engine and never falls back.
4. **The Agent Calendar Connector is retired with it**. Interactive
   Agent calendar access existed for the conversation; Calendar Sources are
   unaffected.
5. **Sharing keeps its connector model.** It keeps reading the persisted
   `conversationModel` setting of the selected Agent Connection as its connector
   model. The key is not renamed: it is part of the connection revision that
   existing Test Share receipts are bound to. The model is set when the
   connection is created; Settings no longer edits it.
6. **Native controls lose the voice-chat path.** The `voice_chat`,
   `open_voice_chat` and `open_agent_console` IPC actions, the voice-chat panel,
   the `ask`/`ask-toggle` commands and their CLI wrappers are removed.

## Migration

Nothing is replayed, and no stored conversation is sent anywhere.

- **Config.** Before the schema is read, `intelligence.conversation`,
  `transcription.dictation.voice_chat_scope`,
  `transcription.dictation.cleanup_model`, `status_agent.hotkeys.voice_chat`
  and `agent_console` are written to a mode-`0600`
  `config.legacy-conversation.<stamp>.json` archive beside `config.json` and
  removed from the active file. A config written by an older version loads, and
  writes that reintroduce a retired key are rejected.
- **Dictation**. New values go only into the new keys. When the archived
  Conversation selection exists and `text_provider` does not, `text_provider`
  becomes `xai` if that selection was xAI and `none` otherwise. `text_model`
  takes an explicit `cleanup_model` other than `conversation`, else the model
  the xAI Conversation selection pinned, else the default.
- **Dictation consent**. Once (migration marker
  `dictation-text-disclosure-v1`), if `text_provider` is `xai` and the xAI
  Conversation disclosure was accepted, that receipt is copied into the new
  dictation receipt with its original version `xai-conversation-v1` and
  decision time, so cleanup neither stops nor starts for anyone on upgrade.
  New consent is recorded as `xai-dictation-text-v1`. Removing the xAI
  connection clears the dictation receipt.
- **Sessions**. `agent-sessions.json` is renamed once to a mode-`0600`
  archive in the same directory and never read again. It is not parsed, so a
  damaged file cannot block startup. Application Migration still carries the
  file over from a legacy install.
- **Host SQLite.** No existing table changes. One additive table,
  `dictation_text_disclosures`, holds the dictation receipt. Conversation
  disclosure receipts, readiness history, Unknown-Outcome fences, Optional
  Capability Outcomes, the calendar connector selection, and Hermes/OpenClaw
  connection rows stay as inert rows; reads skip the retired capabilities.
- **Onboarding.** The manifest lists Calendar Source and Sharing. Existing
  completions stand; a user who had only the retired steps left is complete.
- **Legacy StatusAgent retirement.** Application Migration still requires a
  legacy StatusAgent to report `voice_chat_window_visible: false`. The native
  status reply keeps that one constant so a development build can be retired;
  the URL field and the TypeScript projections are removed.
- **Public DMG acceptance.** The fresh-install optional manifest checked by
  `packaging/acceptance` is Calendar Source and Sharing.
- **Rollback.** An Application Update rollback to an earlier version reads the
  same database and ignores the new table. That version finds no Conversation
  selection, Agent Console settings or session file (they are archived), so it
  starts with defaults and an empty history; the archives restore them by hand.

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
- Voice translation keeps using the cleanup model, now stored as
  `text_model`; it already followed the cleanup model selection, so no user's
  translation model changes.
- To change the Sharing connector model, the user removes and re-adds the
  Agent Connection.
- The xAI text client keeps only bounded, non-streaming requests for Summary
  and dictation.
- `yulu doctor` reports a `dictation_text` privacy entry in place of
  `conversation`.
- `llm.*` remains migration input for Agent Connections and for the Python
  capability probes; it no longer selects anything in the Host.
