import type {
  HostStore,
  OnboardingCompletionRequirements,
  OptionalCapabilityOutcome,
} from "./hostStore.js";

export type OnboardingReadinessState = "ready" | "needs_attention" | "not_tested" | "unavailable";
export type OnboardingCapabilityId =
  | "conversation"
  | "calendar-source"
  | "agent-calendar-connector"
  | "sharing";

export interface OnboardingCapabilityReadiness {
  state: OnboardingReadinessState;
  detail: string;
}

export interface OnboardingManifest {
  version: string;
  optionalCapabilities: ReadonlyArray<{
    id: OnboardingCapabilityId;
    contractVersion: string;
    href: string | null;
  }>;
}

export const CURRENT_ONBOARDING_MANIFEST: OnboardingManifest = {
  version: "phase-13-v1",
  optionalCapabilities: [
    {
      id: "conversation",
      contractVersion: "conversation-v1",
      href: "/settings/llm?capability=conversation",
    },
    {
      id: "calendar-source",
      contractVersion: "calendar-source-v1",
      href: "/settings/integrations",
    },
    {
      id: "agent-calendar-connector",
      contractVersion: "agent-calendar-connector-v1",
      href: null,
    },
    {
      id: "sharing",
      contractVersion: "sharing-v1",
      href: "/settings/sharing",
    },
  ],
};

export const CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS: OnboardingCompletionRequirements = {
  version: CURRENT_ONBOARDING_MANIFEST.version,
  optionalCapabilities: CURRENT_ONBOARDING_MANIFEST.optionalCapabilities.map((capability) => ({
    capability: capability.id,
    contractVersion: capability.contractVersion,
  })),
};

function outcomeFor(
  outcomes: OptionalCapabilityOutcome[],
  capability: string,
  contractVersion: string,
): OptionalCapabilityOutcome | null {
  const exact = outcomes.filter((outcome) =>
    outcome.capability === capability && outcome.contractVersion === contractVersion
  );
  return exact.find((outcome) => outcome.outcome === "adopted") ??
    exact.sort((left, right) => right.decidedAt.localeCompare(left.decidedAt))[0] ?? null;
}

export function onboardingHome(
  host: HostStore,
  manifest: OnboardingManifest,
  readiness: Record<string, OnboardingCapabilityReadiness>,
) {
  const evidence = host.getCoreActivationEvidence();
  const outcomes = host.listOptionalCapabilityOutcomes();
  const latestCompletion = host.getLatestOnboardingCompletion();
  const optionalCapabilities = manifest.optionalCapabilities.map((capability) => ({
    ...capability,
    outcome: outcomeFor(outcomes, capability.id, capability.contractVersion),
    readiness: readiness[capability.id] ?? {
      state: "not_tested" as const,
      detail: "Current readiness has not been evaluated",
    },
    isNew: latestCompletion !== null &&
      outcomeFor(outcomes, capability.id, capability.contractVersion) === null,
  }));
  const storedCurrentCompletion = host.getOnboardingCompletion(manifest.version);
  const currentCompletion = evidence !== null && optionalCapabilities.every((capability) =>
      capability.outcome !== null
    )
    ? storedCurrentCompletion
    : null;
  const previousCompletion = currentCompletion ?? host.getLatestOnboardingCompletion(manifest.version);
  const completion = currentCompletion ?? previousCompletion;

  return {
    version: manifest.version,
    coreActivation: {
      evidence,
      completed: evidence !== null,
      href: "/activate",
      journey: host.getActivationJourneyState(),
      attempt: host.getActivationAttempt(),
    },
    optionalCapabilities,
    completion: {
      completed: completion !== null,
      currentVersionCompleted: currentCompletion !== null,
      version: completion?.version ?? null,
      completedAt: completion?.completedAt ?? null,
    },
  };
}
