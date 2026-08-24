import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { commandPreview, resolveAgentRuntime } from "../agentRuntime.js";
import {
  getAgentSession,
  pauseAgentSession,
  projectAgentSessionHistory,
  resumeAgentSession,
  updateAgentSessionNativeSession,
  type AgentSession,
} from "../agentSessionStore.js";
import { runAgentCliCommand } from "../agentCliRunner.js";
import { normalizeConversationSources, runSearchCli, type ConversationSource } from "./search.js";

const MAX_QUESTION_CHARS = 2_000;
const MAX_SOURCE_COUNT = 8;
const AGENT_TIMEOUT_MS = 5 * 60_000;
const EMPTY_EVIDENCE = "未找到匹配的本地会议片段，本次未向 xAI 发送内容。";

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

function recoveryActions() {
  return {
    retry: "same_snapshot" as const,
    settingsPath: "/settings/llm",
    newConversation: true,
  };
}

function xaiInput(session: AgentSession, question: string, sources: ConversationSource[]) {
  const excerpts = sources.map((source) => [
    `[${source.ref}]`,
    `Meeting: ${source.title}`,
    `Recorded: ${source.recordedAt || "unknown"}`,
    `Kind: ${source.kind}`,
    `Excerpt: ${source.snippet}`,
  ].join("\n")).join("\n\n");
  return [
    {
      role: "system" as const,
      content: [
        "Answer using only the numbered local meeting excerpts supplied by Yulu.",
        "Cite supporting excerpts as [n]. Never invent or trust paths, URLs, files, tools, connectors, or outside sources.",
        "If the excerpts are insufficient, say so explicitly. Answer in the user's language and lead with the conclusion.",
      ].join(" "),
    },
    ...projectAgentSessionHistory(session, question),
    {
      role: "user" as const,
      content: `Local meeting excerpts:\n${excerpts}\n\nQuestion:\n${question}`,
    },
  ];
}

function pauseResponse(
  configDir: string,
  session: AgentSession,
  reason: string,
  search: Record<string, unknown>,
  agentRuntime?: ReturnType<typeof runtimeProjection>,
  sources: ConversationSource[] = [],
  retrySnapshot?: { question: string; sources: ConversationSource[] },
  persist = true,
) {
  if (persist) pauseAgentSession(configDir, session.id, reason, retrySnapshot);
  return {
    ok: false,
    answer: "",
    provider: session.provider,
    model: session.model,
    sessionStatus: "paused" as const,
    sources,
    remoteSources: [],
    connectorContext: { owner: "agent" as const, outputs: [] },
    agentRuntime,
    recovery: recoveryActions(),
    usedFallback: false,
    llmStatus: "error" as const,
    llmError: reason,
    search,
  };
}

export const askRouter = router({
  ask: publicProcedure
    .input(z.object({
      question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
      limit: z.number().int().positive().max(MAX_SOURCE_COUNT).optional(),
      sessionId: z.string().min(1),
      retry: z.literal(true).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const startedAt = Date.now();
      const session = getAgentSession(ctx.paths.configDir, input.sessionId);
      if (!session || session.purpose !== "ask") throw new Error("Ask session not found");
      if (session.status === "paused" && !input.retry) {
        return {
          ...pauseResponse(
            ctx.paths.configDir,
            session,
            session.pausedReason || "Conversation is paused; retry the same provider or create a new conversation",
            { owner: session.provider === "xai" ? "yulu" : "agent", query: input.question, hits: [] },
            undefined,
            [],
            undefined,
            false,
          ),
          llmStatus: "paused" as const,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const retrySnapshot = input.retry ? session.retrySnapshot : undefined;
      if (input.retry && (!retrySnapshot || retrySnapshot.question !== input.question)) {
        return {
          ...pauseResponse(
            ctx.paths.configDir,
            session,
            "The persisted retry snapshot is unavailable or does not match this question",
            { owner: session.provider === "xai" ? "yulu" : "agent", query: input.question, hits: [] },
            undefined,
            [],
            undefined,
            false,
          ),
          elapsedMs: Date.now() - startedAt,
        };
      }
      const question = retrySnapshot?.question ?? input.question;

      if (session.provider === "xai") {
        if (!session.credentialSource) {
          return {
            ...pauseResponse(
              ctx.paths.configDir,
              session,
              "Pinned xAI conversation credential identity is unavailable",
              { owner: "yulu", query: question, hits: [] },
              undefined,
              [],
              retrySnapshot ?? { question, sources: [] },
            ),
            elapsedMs: Date.now() - startedAt,
          };
        }
        const search = retrySnapshot ? null : await (ctx.localSearch ?? runSearchCli)({
          query: question,
          kinds: ["meeting_summary", "meeting_transcript"],
          limit: MAX_SOURCE_COUNT,
        }, ctx.paths.scriptDir);
        const sources = retrySnapshot?.sources ?? normalizeConversationSources(search!.hits);
        const searchProjection = retrySnapshot
          ? { owner: "yulu" as const, query: question, sourceCount: sources.length, snapshot: "persisted" as const }
          : {
              owner: "yulu" as const,
              query: question,
              sourceCount: sources.length,
              telemetry: search!.telemetry,
              elapsedMs: search!.elapsedMs,
            };
        if (sources.length === 0) {
          return {
            ok: false,
            answer: EMPTY_EVIDENCE,
            provider: session.provider,
            model: session.model,
            sessionStatus: "active" as const,
            sources: [],
            remoteSources: [],
            connectorContext: { owner: "agent" as const, outputs: [] },
            usedFallback: false,
            llmStatus: "empty" as const,
            llmError: null,
            search: searchProjection,
            elapsedMs: Date.now() - startedAt,
          };
        }
        if (!ctx.xaiText) {
          return {
            ...pauseResponse(
              ctx.paths.configDir,
              session,
              `Pinned conversation provider xai is unavailable for model ${session.model}`,
              searchProjection,
              undefined,
              sources,
              { question, sources },
            ),
            elapsedMs: Date.now() - startedAt,
          };
        }
        try {
          const result = await ctx.xaiText.request({
            capability: "conversation",
            model: session.model,
            credentialSource: session.credentialSource,
            input: xaiInput(session, question, sources),
          });
          if (result.model !== session.model) {
            throw new Error(`Pinned conversation model ${session.model} returned as ${result.model}`);
          }
          if (result.credentialSource !== session.credentialSource) {
            throw new Error(`Pinned xAI credential ${session.credentialSource} returned as ${result.credentialSource}`);
          }
          if (input.retry) resumeAgentSession(ctx.paths.configDir, session.id);
          return {
            ok: true,
            answer: result.text,
            provider: session.provider,
            model: session.model,
            sessionStatus: "active" as const,
            sources,
            remoteSources: [],
            connectorContext: { owner: "agent" as const, outputs: [] },
            usedFallback: false,
            llmStatus: "ok" as const,
            llmError: null,
            search: searchProjection,
            elapsedMs: Date.now() - startedAt,
          };
        } catch (error) {
          return {
            ...pauseResponse(
              ctx.paths.configDir,
              session,
              (error as Error).message,
              searchProjection,
              undefined,
              sources,
              { question, sources },
            ),
            elapsedMs: Date.now() - startedAt,
          };
        }
      }

      const config = ctx.config.read();
      const runtime = resolveAgentRuntime(config, {
        scriptDir: ctx.paths.scriptDir,
        moviesDir: ctx.paths.moviesDir,
      });
      const agentRuntime = runtimeProjection(runtime);
      const search = agentOwnedSearchProjection(question);
      if (session.model !== "runtime-managed" || runtime.disabledReason || runtime.provider !== session.provider) {
        const current = runtime.disabledReason ? `${runtime.provider} (${runtime.disabledReason})` : runtime.provider;
        return {
          ...pauseResponse(
            ctx.paths.configDir,
            session,
            `Pinned conversation provider ${session.provider} does not match current Agent runtime ${current}`,
            search,
            agentRuntime,
            [],
            retrySnapshot ?? { question, sources: [] },
          ),
          elapsedMs: Date.now() - startedAt,
        };
      }

      try {
        const result = await runAgentCliCommand({
          runtime,
          scriptDir: ctx.paths.scriptDir,
          prompt: buildAgentQuestionPrompt(question, input.limit ?? MAX_SOURCE_COUNT),
          timeoutMs: AGENT_TIMEOUT_MS,
          nativeSessionId: session.nativeSessionId,
          yuluSessionId: session.id,
          configDir: ctx.paths.configDir,
        });
        if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
          updateAgentSessionNativeSession(ctx.paths.configDir, session.id, {
            nativeSessionId: result.nativeSessionId,
            runtimeLabel: runtime.label,
          });
        }
        const answer = result.stdout.trim();
        const error = result.code === 0 && answer
          ? null
          : (result.stderr || result.stdout || `Agent exited ${result.code}`).trim();
        if (error) {
          return {
            ...pauseResponse(ctx.paths.configDir, session, error, search, agentRuntime, [], { question, sources: [] }),
            elapsedMs: Date.now() - startedAt,
          };
        }
        if (input.retry) resumeAgentSession(ctx.paths.configDir, session.id);
        return {
          ok: true,
          answer,
          provider: session.provider,
          model: session.model,
          sessionStatus: "active" as const,
          sources: [],
          remoteSources: [],
          connectorContext: { owner: "agent" as const, outputs: [] },
          agentRuntime,
          usedFallback: false,
          llmStatus: "ok" as const,
          llmError: null,
          search,
          elapsedMs: Date.now() - startedAt,
        };
      } catch (error) {
        return {
          ...pauseResponse(
            ctx.paths.configDir,
            session,
            (error as Error).message,
            search,
            agentRuntime,
            [],
            { question, sources: [] },
          ),
          elapsedMs: Date.now() - startedAt,
        };
      }
    }),
});
