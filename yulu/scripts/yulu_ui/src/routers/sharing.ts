import { z } from "zod";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

function sharing(ctx: AppContext) {
  if (!ctx.sharing) throw new Error("Sharing configuration is unavailable");
  return ctx.sharing;
}

export const sharingRouter = router({
  view: publicProcedure.query(({ ctx }) => sharing(ctx).view()),
  select: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().trim().min(1).max(200),
      connector: z.enum(["notion", "zulip"]),
    }).strict())
    .mutation(({ ctx, input }) => sharing(ctx).select(input)),
  discover: uiMutationProcedure.mutation(({ ctx }) => sharing(ctx).discover()),
  probe: uiMutationProcedure.mutation(({ ctx }) => sharing(ctx).probe()),
  saveDestination: uiMutationProcedure
    .input(z.object({ destination: z.string().trim().min(1).max(500) }).strict())
    .mutation(({ ctx, input }) => sharing(ctx).saveDestination(input)),
  testShare: uiMutationProcedure
    .input(z.object({
      confirmed: z.literal(true),
      actionId: z.string().uuid(),
      duplicateConfirmed: z.boolean(),
    }).strict())
    .mutation(({ ctx, input }) => sharing(ctx).testShare({
      actionId: input.actionId,
      duplicateConfirmed: input.duplicateConfirmed,
    })),
  reconcileUnknown: uiMutationProcedure
    .input(z.object({
      actionId: z.string().uuid(),
      receiptId: z.string().trim().max(500),
      receiptUrl: z.string().trim().max(2_000),
    }).strict().refine((input) => input.receiptId || input.receiptUrl, {
      message: "Enter an external receipt ID or URL",
    }))
    .mutation(({ ctx, input }) => sharing(ctx).reconcileUnknown(input)),
  abandonUnknown: uiMutationProcedure
    .input(z.object({ actionId: z.string().uuid(), confirmed: z.literal(true) }).strict())
    .mutation(({ ctx, input }) => sharing(ctx).abandonUnknown({ actionId: input.actionId })),
});
