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
      agent: z.string().min(1),
      title: z.string().max(48).optional(),
    }))
    .mutation(({ ctx, input }) => {
      return createAgentSession(ctx.paths.configDir, {
        provider: input.agent,
        model: "runtime-managed",
        title: input.title,
        purpose: "ask",
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
