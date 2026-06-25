# Spec: Ask Yulu Agent-Native Search + Chat Entry

> **Status**: v2 Agent-native implementation in progress
> **Date**: 2026-06-24
> **Updated**: 2026-06-25
> **Plane**: YULU-51, YULU-52, YULU-54, YULU-55
> **Parent**: YULU-31

## 1. User Outcome

Yulu's search entry should become the place where a user can either search exact
meeting artifacts or ask a natural-language question across all meeting history.
The answer should cite local meetings it used and, when the user's local Agent is
configured with MCP connectors, let that Agent read Google Calendar, Notion, and
Zulip context directly.

The product boundary is:

```text
Yulu owns scheduling.
Agent owns intelligence.
```

Native Calendar Scheduler is a required Yulu capability by default. Agent CLI
access is for AI context, not for reliable background scheduling.

## 2. GSD Assumptions

- Keep lexical search as the retrieval baseline. Do not block this feature on
  embeddings or a vector extension.
- Reuse the user's local Agent CLI as the live AI runtime. Yulu should not
  implement separate Google/Notion/Zulip readers for Ask.
- Keep lexical search as the local retrieval baseline and context pack. Do not
  block the Agent-native work on embeddings.
- `llm.command = null` means durable agent-queue mode for summaries and live
  Ask may auto-detect a local Agent CLI. Explicit `llm.command` still wins.
- Connector context is read-only. Ask Yulu may instruct the Agent to use its MCP
  connectors, but must not send messages, create Notion pages, mutate calendars,
  or perform any external write.
- Native Calendar Scheduler remains default and Yulu-owned. Current Google/gog
  support is a legacy schedule provider; EventKit/system Calendar is the desired
  default provider slice.
- If no Agent CLI is available, disabled, or fails, return a useful fallback with
  the most relevant local sources. Do not show a blank chat pane.

## 3. Architecture

```text
GlobalSearch Ask mode
  -> tRPC ask.ask mutation
  -> search.cli --json planned local queries
  -> safe source-file excerpts under moviesDir
  -> local connector + native scheduler status from config.json + schedule.json
  -> Agent runtime resolver
       explicit llm.command
       else codex exec --sandbox read-only
       else claude --print
       else fallback
  -> Agent CLI stdin prompt
  -> answer + sources + connectorContext
```

The source-file reader rejects search hits whose `sourcePath` resolves outside
the recordings root. This keeps the UI server from turning arbitrary search
output into arbitrary file reads.

## 4.1 v2 Retrieval Polish

Natural-language questions are not the same thing as lexical search terms. Ask
Yulu must plan several searches from one question:

- the original question, for exact matching when it works,
- Latin/person/product terms such as `Bruce` or `AgentKey`,
- compact CJK topic terms after removing conversational stop phrases,
- short mixed combinations when both English names and Chinese topics appear.

The backend deduplicates sources across these searches before building the LLM
prompt. This makes a question like `bruce 和我主要聊了什么` retrieve the same
Bruce-related meetings that exact search already finds.

Remote Connector history is outside the local UI process by design. The prompt
may tell the selected Agent that it can use its own configured MCP connectors for
read-only Google Calendar, Notion, and Zulip context. Yulu UI must not claim that
it searched remote content itself.

## 4.2 Agent Runtime Bridge

The live Ask path resolves an Agent runtime in this order:

1. Explicit `llm.command`, used as-is. This supports Claude Code, Codex, Gemini,
   Grok, local wrappers, or any other CLI that reads stdin and writes stdout.
2. Auto-detected Codex CLI: `codex exec --sandbox read-only --skip-git-repo-check`.
3. Auto-detected Claude Code CLI: `claude --print --add-dir <moviesDir>`.
4. Source-backed fallback if no runtime is available.

The prompt must:

- name the selected Agent runtime,
- provide local meeting sources and snippets,
- state that remote context comes from Agent MCP connectors when available,
- forbid remote writes,
- state the scheduling boundary: Yulu owns native calendar scheduling.

## 4.3 Native Calendar Scheduler Boundary

Native Calendar Scheduler is not optional product infrastructure. Yulu must keep
the schedule file and reminder/auto-record flow deterministic without depending
on an LLM call.

The current Google Calendar implementation uses `gog` and Keychain. It remains a
legacy native provider for now. The next provider slice should prefer macOS
system Calendar/EventKit so a user who already connected Google to macOS does
not have to grant Yulu separate Google OAuth access.

## 5. UX

The existing GlobalSearch keeps its Search mode. A segmented control adds Ask
mode in the same popover. Ask mode shows:

- a compact submit action aligned with the popover chrome,
- the selected Agent runtime,
- the Native Scheduler provider/status,
- the generated answer,
- read-only Connector badges,
- clickable source rows that deep-link back into the recording reader.

## 5.1 Agent Workspace UI Pass (YULU-55)

Ask mode should read as a compact Agent workspace, not a search result card.
This pass keeps the existing `GlobalSearch` entry point but changes the opened
Ask surface to:

- a conversation thread with the current user question and the Agent answer,
- a left/main column for the conversation and cited meeting sources,
- a right/status rail for Agent runtime, local meeting index, Native Scheduler,
  and Connector availability,
- visible retrieval telemetry (`plannedQueries`, merged hit count, source count)
  so weak local retrieval does not look like "there is no history",
- consistent control heights, icon alignment, and responsive collapse,
- keyboard behavior that keeps `Cmd/Ctrl+K`, `Enter`, arrows, and `Esc`
  predictable across Search and Ask.

The UI must not claim that Yulu directly searched Notion/Zulip/Google. It should
show those as Agent connector context. Calendar scheduling remains a separate
Native Scheduler capability owned by Yulu.

Success criteria for this UI pass:

- Ask mode has an obvious Agent identity and status rail before and after an
  answer is generated.
- Source rows remain clickable and easy to scan.
- The local search seed is visible (`sources`, `planned queries`, merged hits).
- Mobile collapses the status rail below the conversation without clipping.
- Existing Search mode behavior is unchanged.

## 6. Done Criteria

- Search mode still renders exact results and setting jumps.
- Ask mode submits natural-language questions and displays an answer.
- Answer sources are clickable reader deep links.
- Connector context is visible and read-only.
- Agent runtime is visible and distinguishes configured command, auto-detected
  Codex/Claude, disabled, and missing states.
- Native Scheduler status is visible and not confused with Agent Calendar MCP.
- Natural-language questions with names still retrieve exact name matches.
- Fallback is explicit when no LLM is configured or the LLM command fails.
- Router tests, component tests, typecheck, build, dev-install, doctor, and
  browser validation pass.

## 7. Follow-Up Slice

EventKit/system Calendar provider is the next native scheduler provider slice.
It should replace `gog` as the default macOS path, with `gog` retained as legacy
fallback. This is separate from Ask Yulu's Agent MCP access to Google Calendar.
