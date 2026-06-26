# Agent Console Capability Boundary

## Current Yulu AI Capabilities

Yulu currently has four AI-adjacent capability groups:

1. Capture and transcription
   - Owned by Yulu.
   - Implemented by local audio capture, `stt_daemon`, `transcribe.py`, and transcript sidecar files.
   - This should not move to the Agent CLI because it is Yulu's local capture/data layer.

2. Summary generation
   - Yulu owns templates and meeting artifacts.
   - Execution is already behind the Agent boundary: `transcribe.py` appends `summary_request` entries, and `agent_queue_worker.py` either runs `llm.command` or leaves work in `agent-queue.json` for an external Agent.
   - The desired Agent Console behavior is to make the selected Agent determine that execution path.

3. Ask Meetings
   - Yulu owns local search/retrieval from transcripts and summaries.
   - The answer is generated through the selected Agent runtime from `resolveAgentRuntime()` and `runLlmCommand()`.
   - As of this task, Ask Meetings sessions are persisted per selected Agent.

4. Terminology and local memory
   - Yulu owns vocabulary, prompts, transcripts, summaries, search index, and Agent sessions.
   - The Agent consumes this context through prompts and local retrieval; Yulu should not implement a second general memory brain.

## Connector Boundary

Connector execution should belong to the selected Agent and its plugins/connectors:

- Notion send/read should be delegated to the selected Agent's Notion capability.
- Zulip send/read should be delegated to the selected Agent's Zulip capability.
- Calendar AI context should be delegated to the selected Agent's calendar connector.
- Yulu may still own native calendar scheduling for local recording reminders because that is an app runtime workflow, not an LLM context workflow.

The legacy Yulu AI integration settings and Python connector implementations still exist for compatibility. Agent Console should treat them as deprecated for the new product path.

## Plugin Model

Agent Console plugin state has two layers:

- Yulu filter: whether the user added the capability to this Console.
- Selected Agent state: whether the underlying Agent actually has that plugin configured.

Therefore:

- If Codex has Zulip configured but Yulu Console has not added Zulip, it is hidden.
- If Yulu Console adds Zulip but Codex does not have it configured, it is visible as "go configure".
- Configure actions should route through the selected Agent boundary, not through Yulu's legacy integration settings.

## Next Migration Step

The remaining architecture gap is action execution:

- `recordings.sendSummary` still needs an Agent capability provider path so share actions run through the selected Agent CLI/plugin instead of Yulu-owned connector code.
- Summary generation should read selected Agent provider config directly from Agent Console state, not from legacy `llm.command` semantics alone.
- Calendar settings in Agent Console should configure the selected Agent connector scope for AI context, while Yulu native scheduler keeps its own local scheduling config.
