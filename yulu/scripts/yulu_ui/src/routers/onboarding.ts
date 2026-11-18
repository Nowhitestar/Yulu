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
  "calendar-source",
  "sharing",
]);

function notTested(detail: string): OnboardingCapabilityReadiness {
  return { state: "not_tested", detail };
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

function calendarSourceReadiness(ctx: AppContext): OnboardingCapabilityReadiness {
  if (!ctx.calendarSources) return { state: "unavailable", detail: "Calendar Source settings are unavailable" };
  try {
    const current = ctx.calendarSources.view().readiness;
    return {
      state: current.status === "ready"
        ? "ready"
        : current.status === "failed"
          ? "needs_attention"
          : "not_tested",
      detail: current.detail,
    };
  } catch {
    return { state: "unavailable", detail: "Current Calendar Source readiness is unavailable" };
  }
}

function currentReadiness(ctx: AppContext) {
  return {
    "calendar-source": calendarSourceReadiness(ctx),
    sharing: sharingReadiness(ctx),
  };
}

function status(ctx: AppContext) {
  return {
    ...onboardingHome(ctx.host, CURRENT_ONBOARDING_MANIFEST, currentReadiness(ctx)),
    entry: ctx.host.getOnboardingEntryState(),
  };
}

/**
 * Record Onboarding Completion for a user whose remaining Optional Capability
 * steps were retired (ADR-010). Completion still requires Core Activation and an
 * outcome for every capability in the current manifest; nothing is adopted here.
 */
export function reconcileOnboardingCompletion(ctx: Pick<AppContext, "host">) {
  return ctx.host.recordOnboardingCompletionIfSatisfied(CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
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
  adoptCalendarSource: uiMutationProcedure.mutation(async ({ ctx }) => {
    if (!ctx.calendarSources) throw new Error("Calendar Source settings are unavailable");
    const proof = await ctx.calendarSources.adoptionEvidence();
    const outcome = ctx.host.recordOptionalCapabilityOutcome({
      onboardingVersion: CURRENT_ONBOARDING_MANIFEST.version,
      capability: "calendar-source",
      contractVersion: CURRENT_ONBOARDING_MANIFEST.optionalCapabilities.find(
        (capability) => capability.id === "calendar-source",
      )!.contractVersion,
      outcome: "adopted",
      evidence: proof,
    }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    return { outcome, proof };
  }),
  adoptSharing: uiMutationProcedure.mutation(({ ctx }) => {
    if (!ctx.sharing) throw new Error("Sharing configuration is unavailable");
    const proof = ctx.sharing.adoptionEvidence();
    const outcome = ctx.host.recordOptionalCapabilityOutcome({
      onboardingVersion: CURRENT_ONBOARDING_MANIFEST.version,
      capability: "sharing",
      contractVersion: CURRENT_ONBOARDING_MANIFEST.optionalCapabilities.find(
        (capability) => capability.id === "sharing",
      )!.contractVersion,
      outcome: "adopted",
      evidence: proof,
    }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    return { outcome, proof };
  }),
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
