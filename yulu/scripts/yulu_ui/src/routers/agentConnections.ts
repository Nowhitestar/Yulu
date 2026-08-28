import { z } from "zod";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

function center(ctx: AppContext) {
  if (!ctx.agentConnections) throw new Error("Agent Connection Center is unavailable");
  return ctx.agentConnections;
}

const capability = z.enum(["transcription", "summary", "conversation"]);

export const agentConnectionsRouter = router({
  view: publicProcedure.query(({ ctx }) => center(ctx).view()),
  summaryActivation: publicProcedure.query(({ ctx }) => center(ctx).summaryActivation()),
  refreshCandidates: uiMutationProcedure.mutation(({ ctx }) => center(ctx).refreshCandidates()),
  confirmCandidate: uiMutationProcedure
    .input(z.object({
      candidateId: z.string().min(1).max(200),
      model: z.string().trim().min(1).max(128),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).confirmCandidate(input)),
  select: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      capability,
      model: z.string().trim().min(1).max(128).optional(),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).select(input)),
  selectCredentialSource: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      credentialSource: z.enum(["oauth", "api-key"]),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).selectCredentialSource(input)),
  probe: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      capability,
      model: z.string().trim().min(1).max(128).optional(),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).probe(input)),
  acceptDisclosure: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      capability,
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).acceptDisclosure(input)),
  declineDisclosure: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      capability: z.enum(["summary", "conversation"]),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).declineDisclosure(input)),
  authorize: uiMutationProcedure.mutation(({ ctx }) => center(ctx).authorize()),
  cancelAuthorization: uiMutationProcedure.mutation(({ ctx }) => center(ctx).cancelAuthorization()),
  logoutOAuth: uiMutationProcedure.mutation(({ ctx }) => center(ctx).logoutOAuth()),
  setApiKey: uiMutationProcedure
    .input(z.object({ apiKey: z.string().trim().min(1).max(4_096) }).strict())
    .mutation(({ ctx, input }) => center(ctx).setApiKey(input.apiKey)),
  clearApiKey: uiMutationProcedure.mutation(({ ctx }) => center(ctx).clearApiKey()),
  deletionImpact: uiMutationProcedure
    .input(z.object({ connectionId: z.string().min(1).max(200) }).strict())
    .mutation(({ ctx, input }) => center(ctx).deletionImpact(input)),
  remove: uiMutationProcedure
    .input(z.object({
      connectionId: z.string().min(1).max(200),
      confirmed: z.literal(true),
    }).strict())
    .mutation(({ ctx, input }) => center(ctx).remove(input)),
  restoreDirectXai: uiMutationProcedure.mutation(({ ctx }) => center(ctx).restoreDirectXai()),
});
