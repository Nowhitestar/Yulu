import { z } from "zod";
import {
  CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
  CURRENT_ONBOARDING_MANIFEST,
  onboardingHome,
  type OnboardingCapabilityReadiness,
} from "../onboarding.js";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

const optionalCapability = z.enum([
  "conversation",
  "calendar-source",
  "agent-calendar-connector",
  "sharing",
]);

function notTested(detail: string): OnboardingCapabilityReadiness {
  return { state: "not_tested", detail };
}

async function conversationReadiness(ctx: AppContext): Promise<OnboardingCapabilityReadiness> {
  if (!ctx.agentConnections) return { state: "unavailable", detail: "Agent Connection Center is unavailable" };
  try {
    const view = await ctx.agentConnections.view();
    const selection = view.selections.conversation;
    if (!selection.connectionId) return notTested("No Conversation Provider is selected");
    const connection = view.connections.find((candidate) => candidate.id === selection.connectionId);
    const capability = connection?.capabilities.find((candidate) => candidate.capability === "conversation");
    if (!capability || !("currentReadiness" in capability)) {
      return { state: "unavailable", detail: "The selected Conversation capability is unavailable" };
    }
    const current = capability.currentReadiness;
    if (current.model !== selection.model) {
      return notTested(`Conversation model ${selection.model} has not been tested in this Host process`);
    }
    return {
      state: current.status === "ready"
        ? "ready"
        : current.status === "failed"
          ? "needs_attention"
          : "not_tested",
      detail: current.detail,
    };
  } catch {
    return { state: "unavailable", detail: "Current Conversation readiness is unavailable" };
  }
}

function sharingReadiness(ctx: AppContext): OnboardingCapabilityReadiness {
  if (!ctx.sharing) return { state: "unavailable", detail: "Sharing configuration is unavailable" };
  try {
    const current = ctx.sharing.view().sharingReadiness;
    return {
      state: current.status === "ready"
        ? "ready"
        : current.status === "failed" || current.status === "unknown"
          ? "needs_attention"
          : "not_tested",
      detail: current.detail,
    };
  } catch {
    return { state: "unavailable", detail: "Current Sharing readiness is unavailable" };
  }
}

async function currentReadiness(ctx: AppContext) {
  return {
    conversation: await conversationReadiness(ctx),
    "calendar-source": notTested("Open Calendar Source settings to evaluate current readiness"),
    "agent-calendar-connector": notTested("Open the Agent Console to evaluate current Connector Readiness"),
    sharing: sharingReadiness(ctx),
  };
}

async function status(ctx: AppContext) {
  return {
    ...onboardingHome(ctx.host, CURRENT_ONBOARDING_MANIFEST, await currentReadiness(ctx)),
    entry: ctx.host.getOnboardingEntryState(),
  };
}

export const onboardingRouter = router({
  status: publicProcedure.query(({ ctx }) => status(ctx)),
  acknowledgeAutomaticEntry: uiMutationProcedure.mutation(({ ctx }) => {
    const result = ctx.host.acknowledgeAutomaticOnboardingEntry();
    return { acknowledged: result.acknowledged, entry: result.state };
  }),
  deferActivationJourney: uiMutationProcedure.mutation(({ ctx }) => ({
    journey: ctx.host.deferActivationJourney(),
    attempt: ctx.host.getActivationAttempt(),
  })),
  deferOptionalCapability: uiMutationProcedure
    .input(z.object({ capability: optionalCapability }).strict())
    .mutation(({ ctx, input }) => {
      const capability = CURRENT_ONBOARDING_MANIFEST.optionalCapabilities.find(
        (candidate) => candidate.id === input.capability,
      )!;
      return ctx.host.recordOptionalCapabilityOutcome({
        onboardingVersion: CURRENT_ONBOARDING_MANIFEST.version,
        capability: capability.id,
        contractVersion: capability.contractVersion,
        outcome: "deferred",
        evidence: null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }),
});
