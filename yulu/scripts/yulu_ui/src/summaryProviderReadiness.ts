export type SummaryReadinessStatus = "untested" | "testing" | "ready" | "failed";

import type {
  AgentArtifactWorkflowInput,
  AgentWorkflowResult,
  RecordingAgentGateway,
} from "./agentGateway.js";
import type { YuluConfig } from "./config.js";

export type SummaryDisclosureMetadata =
  | { kind: "local" }
  | {
      kind: "external";
      disclosureVersion: string;
      data: "transcript_text";
      destination: string;
    };

export interface SupportedAgentSummaryReadiness {
  capability: "summary";
  provider: string;
  model: string;
  status: SummaryReadinessStatus;
  testedAt: string | null;
  detail: string;
  credentialSource: string | null;
  disclosure: SummaryDisclosureMetadata | null;
  reason?: "missing_credentials" | "invalid_model" | "provider_unavailable" | "readiness_failed" | "readiness_required";
}

export interface SupportedAgentSummaryAdapter {
  current: () => SupportedAgentSummaryReadiness;
  probe: () => Promise<SupportedAgentSummaryReadiness>;
  gateway: (config: YuluConfig) => SupportedAgentSummaryGateway;
}

export interface SupportedAgentSummaryGateway extends RecordingAgentGateway {
  runArtifactWorkflow(
    input: AgentArtifactWorkflowInput,
  ): Promise<AgentWorkflowResult & { summaryIdentity: { provider: string; model: string } }>;
}

export function hasSupportedAgentSummaryIdentity(result: SupportedAgentSummaryReadiness): boolean {
  const provider = result.provider.trim().toLowerCase();
  const model = result.model.trim();
  return result.capability === "summary" && Boolean(provider) && Boolean(model) && model.length <= 128 &&
    !["agent", "auto", "fallback"].includes(provider);
}

export function hasSupportedAgentSummaryReadinessProof(result: SupportedAgentSummaryReadiness): boolean {
  if (result.status !== "ready" || !result.testedAt || !Number.isFinite(Date.parse(result.testedAt))) return false;
  const disclosure = result.disclosure;
  if (!disclosure) return false;
  if (disclosure.kind === "local") return true;
  return Boolean(result.credentialSource?.trim()) && Boolean(disclosure.destination.trim()) &&
    Boolean(disclosure.disclosureVersion.trim());
}
