export type SummaryReadinessStatus = "untested" | "testing" | "ready" | "failed";

export class ClaudeCodeSummaryUnknownOutcomeError extends Error {
  readonly nativeSessionId: string;
  readonly evidence: SummaryCommitRuntimeEvidence;

  constructor(message: string, options: {
    nativeSessionId: string;
    evidence: SummaryCommitRuntimeEvidence;
  }) {
    super(message);
    this.name = "ClaudeCodeSummaryUnknownOutcomeError";
    this.nativeSessionId = options.nativeSessionId;
    this.evidence = options.evidence;
  }
}

import type {
  AgentArtifactWorkflowInput,
  AgentWorkflowResult,
  RecordingAgentGateway,
} from "./agentGateway.js";
import type { YuluConfig } from "./config.js";
import type { SummaryCommitRuntimeEvidence } from "./hostStore.js";

export type SummaryDisclosureMetadata =
  | { kind: "local" }
  | {
      kind: "external";
      disclosureVersion: string;
      data: "transcript_text";
      destination: string;
      connectionId?: string;
    };

export interface SupportedAgentSummaryReadiness {
  capability: "summary";
  provider: string;
  model: string;
  status: SummaryReadinessStatus;
  testedAt: string | null;
  detail: string;
  credentialSource: string | null;
  connectionId?: string | null;
  disclosure: SummaryDisclosureMetadata | null;
  reason?: "missing_credentials" | "invalid_model" | "provider_unavailable" | "readiness_failed" | "readiness_required" | "unknown_outcome";
}

export interface SupportedAgentSummaryAdapter {
  current: (snapshot?: { connectionId: string | null; provider: string; model: string }) => SupportedAgentSummaryReadiness;
  probe: () => Promise<SupportedAgentSummaryReadiness>;
  gateway: (
    config: YuluConfig,
    snapshot?: { connectionId: string | null; provider: string; model: string },
  ) => SupportedAgentSummaryGateway;
}

export interface SupportedAgentSummaryGateway extends RecordingAgentGateway {
  runArtifactWorkflow(
    input: AgentArtifactWorkflowInput,
  ): Promise<AgentWorkflowResult & {
    summaryIdentity: { provider: string; model: string };
    summary?: string;
    runtimeEvidence?: SummaryCommitRuntimeEvidence;
  }>;
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
