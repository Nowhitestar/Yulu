import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";
import { publicAgentTask } from "../hostStore.js";

export const agentTasksRouter = router({
  transcriptionHealth: publicProcedure.query(({ ctx }) => ctx.recordingPipeline.transcriptionHealth()),

  list: publicProcedure
    .input(z.object({ limit: z.number().int().positive().max(500).default(100) }).optional())
    .query(({ ctx, input }) => ctx.recordingPipeline.list(input?.limit ?? 100).map(publicAgentTask)),

  get: publicProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) => {
      const task = ctx.recordingPipeline.get(input.id);
      if (!task) throw new TRPCError({ code: "NOT_FOUND", message: `Agent task not found: ${input.id}` });
      return {
        ...publicAgentTask(task),
        artifacts: ctx.host.listArtifacts(task.id),
        notionDelivery: ctx.host.getNotionDelivery(task.id),
        events: ctx.host.listEvents(task.id),
      };
    }),

  retry: uiMutationProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => {
      try { return publicAgentTask(ctx.recordingPipeline.retry(input.id)); }
      catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: (error as Error).message });
      }
    }),

  confirmNotionDelivery: publicProcedure
    .input(z.object({
      id: z.string().uuid(),
      url: z.string().trim().max(2000).optional(),
      pageId: z.string().trim().max(100).optional(),
      detail: z.string().trim().max(2000).optional(),
    }))
    .mutation(({ ctx, input }) => {
      try {
        return publicAgentTask(ctx.recordingPipeline.confirmNotionDelivery(input.id, {
          url: input.url,
          pageId: input.pageId,
          detail: input.detail,
        }));
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: (error as Error).message });
      }
    }),

  abandonNotionDelivery: publicProcedure
    .input(z.object({ id: z.string().uuid(), detail: z.string().trim().max(2000).optional() }))
    .mutation(({ ctx, input }) => {
      try {
        return publicAgentTask(ctx.recordingPipeline.abandonNotionDelivery(input.id, input.detail));
      } catch (error) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: (error as Error).message });
      }
    }),
});
