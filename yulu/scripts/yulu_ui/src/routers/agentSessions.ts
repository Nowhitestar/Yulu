import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  agentSessionMessageInputSchema,
  archiveAgentSession,
  appendAgentSessionMessage,
  createAgentSession,
  deleteAgentSession,
  getAgentSession,
  listAgentSessions,
  pinAgentSession,
  renameAgentSession,
  summarizeAgentSession,
} from "../agentSessionStore.js";
import { resolveAgentRuntime } from "../agentRuntime.js";
import { hasCurrentXaiConversationDisclosure } from "../conversationDataDisclosure.js";
import {
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  hasCurrentAgentConversationDisclosure,
} from "../conversationDataDisclosure.js";

export const agentSessionsRouter = router({
  list: publicProcedure
    .input(z.object({ agent: z.string().optional() }).optional())
    .query(({ ctx, input }) => {
      return {
        sessions: listAgentSessions(ctx.paths.configDir, { agent: input?.agent, purpose: "ask" })
          .map((session) => summarizeAgentSession(session)),
      };
    }),

  get: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .query(({ ctx, input }) => {
      return getAgentSession(ctx.paths.configDir, input.id);
    }),

  create: publicProcedure
    .input(z.object({
      agent: z.string().min(1).optional(),
      title: z.string().max(48).optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const config = ctx.config.read();
      const selection = config.intelligence.conversation;
      if (selection.provider === "xai") {
        if (!hasCurrentXaiConversationDisclosure(ctx.host)) {
          throw new Error("Accept the current xAI conversation data path disclosure in Agent Connection Center");
        }
        const connection = await ctx.xaiCredentials?.status();
        if (!connection?.connected || !connection.source) {
          throw new Error("Connect xAI before starting an xAI conversation");
        }
        return createAgentSession(ctx.paths.configDir, {
          provider: "xai",
          model: selection.model,
          credentialSource: connection.source,
          title: input.title,
          purpose: "ask",
        });
      }
      if (selection.provider === "agent" && "connectionId" in selection && selection.connectionId) {
        const connection = ctx.host.listAgentConnectionRecords().find((record) =>
          record.id === selection.connectionId &&
          record.kind === "supported-agent" &&
          record.adapter === "codex"
        );
        if (!connection) {
          throw new Error(`Pinned Codex connection ${selection.connectionId} is unavailable in Agent Connection Center`);
        }
        if (!hasCurrentAgentConversationDisclosure(
          ctx.host,
          connection.id,
          CODEX_CONVERSATION_DISCLOSURE_VERSION,
        )) {
          throw new Error("Accept the current Codex Conversation data path disclosure in Agent Connection Center");
        }
        if (!ctx.agentConnections) {
          throw new Error("Test this exact Codex Conversation model before starting a new conversation");
        }
        await ctx.agentConnections.assertCodexConversationReady({
          connectionId: connection.id,
          model: selection.model,
        });
        return createAgentSession(ctx.paths.configDir, {
          provider: "codex",
          connectionId: connection.id,
          model: selection.model,
          credentialSource: "runtime-oauth",
          title: input.title,
          purpose: "ask",
          runtimeLabel: connection.label,
        });
      }
      const runtime = resolveAgentRuntime(config, {
        scriptDir: ctx.paths.scriptDir,
        moviesDir: ctx.paths.moviesDir,
      });
      return createAgentSession(ctx.paths.configDir, {
        provider: runtime.provider,
        model: "runtime-managed",
        title: input.title,
        purpose: "ask",
        runtimeLabel: runtime.label,
      });
    }),

  append: publicProcedure
    .input(z.object({
      sessionId: z.string().min(1),
      message: agentSessionMessageInputSchema,
    }))
    .mutation(({ ctx, input }) => {
      return appendAgentSessionMessage(ctx.paths.configDir, input.sessionId, input.message);
    }),

  rename: publicProcedure
    .input(z.object({
      id: z.string().min(1),
      title: z.string().trim().min(1).max(48),
    }))
    .mutation(({ ctx, input }) => {
      return renameAgentSession(ctx.paths.configDir, input.id, input.title);
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      return deleteAgentSession(ctx.paths.configDir, input.id);
    }),

  pin: publicProcedure
    .input(z.object({ id: z.string().min(1), pinned: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return pinAgentSession(ctx.paths.configDir, input.id, input.pinned);
    }),

  archive: publicProcedure
    .input(z.object({ id: z.string().min(1), archived: z.boolean() }))
    .mutation(({ ctx, input }) => {
      return archiveAgentSession(ctx.paths.configDir, input.id, input.archived);
    }),
});
