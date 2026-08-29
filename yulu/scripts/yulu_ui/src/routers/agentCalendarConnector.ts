import { z } from "zod";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

function agentCalendarConnector(ctx: AppContext) {
  if (!ctx.agentCalendarConnector) throw new Error("Agent Calendar Connector settings are unavailable");
  return ctx.agentCalendarConnector;
}

export const agentCalendarConnectorRouter = router({
  view: publicProcedure.query(({ ctx }) => agentCalendarConnector(ctx).view()),
  select: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().trim().min(1).max(200),
      connector: z.string().trim().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
    }).strict())
    .mutation(({ ctx, input }) => agentCalendarConnector(ctx).select(input)),
  probe: uiMutationProcedure.mutation(({ ctx }) => agentCalendarConnector(ctx).probe()),
});
