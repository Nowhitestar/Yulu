import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { commandPreview, resolveAgentRuntime } from "../agentRuntime.js";
import { getAgentSession, updateAgentSessionNativeSession } from "../agentSessionStore.js";
import { runAgentCliCommand } from "../agentCliRunner.js";

const MAX_QUESTION_CHARS = 2_000;
const MAX_SOURCE_COUNT = 12;
const AGENT_TIMEOUT_MS = 5 * 60_000;

export function buildAgentQuestionPrompt(question: string, sourceLimit: number): string {
  return [
    "You are the selected local Agent powering Yulu's conversation experience.",
    "Yulu is only the deterministic recording/artifact coordinator; you own retrieval, reasoning, conversation, and connector use.",
    "",
    "Instructions:",
    "- Answer in the user's language and lead with the conclusion.",
    `- When meeting evidence is relevant, use Yulu MCP tools such as recording_search and recording_get yourself (up to ${sourceLimit} useful sources).`,
    "- Use your own read-only connectors when external Notion, Zulip, or Calendar context is relevant.",
    "- Do not create, edit, send, or delete external content in this read-only question flow.",
    "- Cite the meeting title/date or connector URL next to claims that depend on retrieved evidence.",
    "- If evidence is insufficient, say so explicitly; never fabricate a Yulu search result or connector response.",
    "- Do not call legacy Yulu chat, transcription, summarization, or summary-send executors.",
    "",
    "User question:",
    question,
  ].join("\n");
}

function runtimeProjection(runtime: ReturnType<typeof resolveAgentRuntime>) {
  return {
    provider: runtime.provider,
    label: runtime.label,
    source: runtime.source,
    commandPreview: commandPreview(runtime),
    cwd: runtime.cwd,
    status: runtime.disabledReason ? "disabled" as const : "ready" as const,
  };
}

function agentOwnedSearchProjection(question: string) {
  return {
    owner: "agent" as const,
    query: question,
    hits: [],
    telemetry: { coordinatorRetrieval: false },
  };
}

export const askRouter = router({
  ask: publicProcedure
    .input(z.object({
      question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
      limit: z.number().int().positive().max(MAX_SOURCE_COUNT).optional(),
      sessionId: z.string().min(1).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const startedAt = Date.now();
      const config = ctx.config.read();
      const runtime = resolveAgentRuntime(config, {
        scriptDir: ctx.paths.scriptDir,
        moviesDir: ctx.paths.moviesDir,
      });
      const agentRuntime = runtimeProjection(runtime);
      const search = agentOwnedSearchProjection(input.question);
      if (runtime.disabledReason) {
        return {
          ok: false,
          answer: "",
          sources: [],
          remoteSources: [],
          connectorContext: { owner: "agent" as const, outputs: [] },
          agentRuntime,
          usedFallback: false,
          llmStatus: "not_configured" as const,
          llmError: runtime.disabledReason,
          search,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const session = input.sessionId ? getAgentSession(ctx.paths.configDir, input.sessionId) : null;
      const result = await runAgentCliCommand({
        runtime,
        scriptDir: ctx.paths.scriptDir,
        prompt: buildAgentQuestionPrompt(input.question, input.limit ?? 8),
        timeoutMs: AGENT_TIMEOUT_MS,
        nativeSessionId: session?.nativeSessionId,
        yuluSessionId: session?.id,
        configDir: session ? ctx.paths.configDir : undefined,
      });
      if (session && result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
        updateAgentSessionNativeSession(ctx.paths.configDir, session.id, {
          nativeSessionId: result.nativeSessionId,
          runtimeLabel: runtime.label,
        });
      }
      const answer = result.stdout.trim();
      const error = result.code === 0 && answer
        ? null
        : (result.stderr || result.stdout || `Agent exited ${result.code}`).trim();
      return {
        ok: error === null,
        answer: error === null ? answer : "",
        // Retrieval is Agent-owned, so Yulu never invents a parallel source
        // projection from an un-audited local pre-search.
        sources: [],
        remoteSources: [],
        connectorContext: { owner: "agent" as const, outputs: [] },
        agentRuntime,
        usedFallback: false,
        llmStatus: error === null ? "ok" as const : "error" as const,
        llmError: error,
        search,
        elapsedMs: Date.now() - startedAt,
      };
    }),
});
