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
  resumeAgentSession,
  summarizeAgentSession,
} from "../agentSessionStore.js";
import { resolveAgentRuntime } from "../agentRuntime.js";

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

  resume: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(({ ctx, input }) => {
      return resumeAgentSession(ctx.paths.configDir, input.id);
    }),
});
