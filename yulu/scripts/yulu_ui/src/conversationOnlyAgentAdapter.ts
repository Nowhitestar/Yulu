export type ConversationOnlyAgentKind = "hermes" | "openclaw";

export const HERMES_MINIMUM_VERSION = "0.20.0";
export const OPENCLAW_MINIMUM_VERSION = "2026.5.12";

const CONTRACTS = {
  hermes: {
    minimumVersion: HERMES_MINIMUM_VERSION,
    transport: "hermes-cli-chat",
    probeToken: "YULU_HERMES_PROBE_OK",
    features: ["status", "model", "query", "resume", "session-id", "probe-bounds", "probe-tool-free", "no-fallback"],
    loginCommand: "model",
    statusCommand: "status",
  },
  openclaw: {
    minimumVersion: OPENCLAW_MINIMUM_VERSION,
    transport: "openclaw-cli-gateway-json",
    probeToken: "YULU_OPENCLAW_PROBE_OK",
    features: ["models/status-json", "model", "message", "session-id", "json", "probe-bounds", "infer/model-run-tool-free", "no-fallback"],
    loginCommand: "configure",
    statusCommand: "models status --json --check",
  },
} as const;

export interface ConversationOnlyRuntimeInspection {
  runtimeVersion: string;
  authorized: boolean;
  provider: string | null;
  model: string | null;
  features: string[];
}

export interface ConversationOnlyRuntimeResult {
  runtimeVersion: string;
  answer: string;
  nativeSessionId: string;
  actualProvider: string | null;
  actualModel: string | null;
  requestId: string | null;
  fallbackOccurred: boolean | null;
  terminalStatus: "completed" | "failed" | "unknown";
  cancellationRequested?: boolean;
  cancellationConfirmed?: boolean | null;
}

export interface ConversationOnlyRuntimeClient {
  inspect(): Promise<ConversationOnlyRuntimeInspection>;
  runConversation(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ConversationOnlyRuntimeResult>;
}

export interface ConversationOnlyRuntimeEvidence {
  adapter: ConversationOnlyAgentKind;
  transport: "hermes-cli-chat" | "openclaw-cli-gateway-json";
  runtimeVersion: string;
  requestedProvider: string | null;
  requestedModel: string;
  actualProvider: string | null;
  actualModel: string | null;
  requestId: string | null;
  sessionId: string | null;
  terminalStatus: "ready" | "failed" | "unknown";
  fallbackOccurred: boolean | null;
  cancellationRequested: boolean;
  cancellationConfirmed: boolean | null;
}

export interface ConversationOnlyProbeResult {
  status: "ready" | "failed";
  reason: "unsupported_runtime" | "authorization_required" | "identity_mismatch" | "readiness_failed" | "unknown_outcome" | null;
  remediation: string | null;
  evidence?: ConversationOnlyRuntimeEvidence;
}

export class ConversationOnlyAgentConversationError extends Error {
  readonly nativeSessionId?: string;
  readonly evidence: ConversationOnlyRuntimeEvidence;
  readonly unknownOutcome: boolean;

  constructor(
    message: string,
    options: {
      nativeSessionId?: string;
      evidence: ConversationOnlyRuntimeEvidence;
      unknownOutcome: boolean;
    },
  ) {
    super(message);
    this.name = "ConversationOnlyAgentConversationError";
    this.nativeSessionId = options.nativeSessionId;
    this.evidence = options.evidence;
    this.unknownOutcome = options.unknownOutcome;
  }
}

function numericVersion(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+ ].*)?$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = numericVersion(actual);
  const right = numericVersion(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

function evidence(
  kind: ConversationOnlyAgentKind,
  provider: string | null,
  model: string,
  result: ConversationOnlyRuntimeResult,
  terminalStatus: ConversationOnlyRuntimeEvidence["terminalStatus"],
): ConversationOnlyRuntimeEvidence {
  return {
    adapter: kind,
    transport: CONTRACTS[kind].transport,
    runtimeVersion: result.runtimeVersion,
    requestedProvider: provider,
    requestedModel: model,
    actualProvider: result.actualProvider,
    actualModel: result.actualModel,
    requestId: result.requestId,
    sessionId: result.nativeSessionId || null,
    terminalStatus,
    fallbackOccurred: result.fallbackOccurred,
    cancellationRequested: result.cancellationRequested ?? false,
    cancellationConfirmed: result.cancellationConfirmed ?? null,
  };
}

function identityMatches(
  result: ConversationOnlyRuntimeResult,
  model: string,
  runtimeVersion: string,
  provider: string | null,
  nativeSessionId?: string,
  requireSession = true,
): boolean {
  return result.runtimeVersion === runtimeVersion &&
    Boolean(provider) &&
    result.actualProvider === provider &&
    result.actualModel === model &&
    result.fallbackOccurred === false &&
    (!requireSession || Boolean(result.nativeSessionId)) &&
    (!nativeSessionId || result.nativeSessionId === nativeSessionId);
}

export class ConversationOnlyAgentAdapter {
  readonly adapter: ConversationOnlyAgentKind;
  readonly executable: string;
  private readonly client: ConversationOnlyRuntimeClient;

  constructor(options: {
    adapter: ConversationOnlyAgentKind;
    executable: string;
    client: ConversationOnlyRuntimeClient;
  }) {
    this.adapter = options.adapter;
    this.executable = options.executable;
    this.client = options.client;
  }

  async status() {
    const contract = CONTRACTS[this.adapter];
    const inspected = await this.client.inspect();
    const supported = versionAtLeast(inspected.runtimeVersion, contract.minimumVersion) &&
      contract.features.every((feature) => inspected.features.includes(feature));
    return {
      adapter: this.adapter,
      transport: contract.transport,
      runtimeVersion: inspected.runtimeVersion,
      minimumVersion: contract.minimumVersion,
      supported,
      authorized: inspected.authorized,
      credentialSource: "runtime-oauth" as const,
      provider: inspected.provider,
      model: inspected.model,
      availableModels: [] as string[],
      features: contract.features.filter((feature) => inspected.features.includes(feature)),
      login: {
        command: `${this.executable} ${contract.loginCommand}`,
        statusCommand: `${this.executable} ${contract.statusCommand}`,
      },
      remediation: supported
        ? inspected.authorized ? null : `Complete ${this.adapter === "hermes" ? "Hermes" : "OpenClaw"} native authorization, then refresh this connection`
        : `Install ${this.adapter === "hermes" ? "Hermes" : "OpenClaw"} ${contract.minimumVersion} or newer with the required tool-free probe and no-fallback features, then refresh this connection`,
    };
  }

  async probe(input: { model: string }): Promise<ConversationOnlyProbeResult> {
    const status = await this.status();
    const label = this.adapter === "hermes" ? "Hermes" : "OpenClaw";
    if (!status.supported) {
      return { status: "failed", reason: "unsupported_runtime", remediation: status.remediation };
    }
    if (!status.authorized) {
      return {
        status: "failed",
        reason: "authorization_required",
        remediation: `Complete ${label} native authorization, then test Conversation again`,
      };
    }
    let result: ConversationOnlyRuntimeResult;
    try {
      result = await this.client.runConversation({
        model: input.model,
        prompt: `Reply with exactly ${CONTRACTS[this.adapter].probeToken}.`,
        probe: true,
        timeoutMs: 30_000,
      });
    } catch {
      return {
        status: "failed",
        reason: "unknown_outcome",
        remediation: `${label} Conversation probe outcome is unknown; inspect the runtime before creating a new attempt and do not retry automatically`,
        evidence: {
          adapter: this.adapter,
          transport: CONTRACTS[this.adapter].transport,
          runtimeVersion: status.runtimeVersion,
          requestedProvider: status.provider,
          requestedModel: input.model,
          actualProvider: null,
          actualModel: null,
          requestId: null,
          sessionId: null,
          terminalStatus: "unknown",
          fallbackOccurred: null,
          cancellationRequested: false,
          cancellationConfirmed: null,
        },
      };
    }
    const runtimeEvidence = evidence(
      this.adapter,
      status.provider,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : "failed",
    );
    if (
      result.terminalStatus !== "completed" ||
      result.answer.trim() !== CONTRACTS[this.adapter].probeToken ||
      !identityMatches(result, input.model, status.runtimeVersion, status.provider, undefined, false)
    ) {
      return {
        status: "failed",
        reason: result.terminalStatus === "unknown" ? "unknown_outcome" : "identity_mismatch",
        remediation: result.terminalStatus === "unknown"
          ? `${label} probe outcome is unknown; inspect the exact native session before creating a new attempt`
          : `${label} did not prove the exact requested Conversation runtime, model, and native session identity`,
        evidence: runtimeEvidence,
      };
    }
    return {
      status: "ready",
      reason: null,
      remediation: null,
      evidence: { ...runtimeEvidence, terminalStatus: "ready" },
    };
  }

  async converse(input: { provider: string; model: string; prompt: string; nativeSessionId?: string }) {
    const status = await this.status();
    const label = this.adapter === "hermes" ? "Hermes" : "OpenClaw";
    if (!status.supported) throw new Error(status.remediation ?? `${label} runtime is unsupported`);
    if (!status.authorized) {
      throw new Error(`Complete ${label} native authorization, then retry this same Conversation input`);
    }
    if (!status.provider || status.provider !== input.provider) {
      throw new Error(`${label} runtime provider changed; restore the pinned provider before retrying this Conversation`);
    }
    const result = await this.client.runConversation({
      model: input.model,
      prompt: input.prompt,
      probe: false,
      timeoutMs: 300_000,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
    const runtimeEvidence = evidence(
      this.adapter,
      input.provider,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : result.terminalStatus === "failed" ? "failed" : "ready",
    );
    if (result.terminalStatus !== "completed") {
      throw new ConversationOnlyAgentConversationError(
        result.terminalStatus === "unknown"
          ? `${label} Conversation outcome is unknown; inspect the pinned native session and do not retry automatically`
          : `${label} Conversation failed; restore the pinned connection and retry this same input explicitly`,
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: result.terminalStatus === "unknown",
        },
      );
    }
    if (!identityMatches(result, input.model, status.runtimeVersion, status.provider, input.nativeSessionId)) {
      throw new ConversationOnlyAgentConversationError(
        `${label} did not prove the exact model or pinned native session; fallback was rejected`,
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: false,
        },
      );
    }
    const answer = result.answer.trim();
    if (!answer) {
      throw new ConversationOnlyAgentConversationError(
        `${label} returned no Conversation answer; retry this same input explicitly`,
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: false,
        },
      );
    }
    return {
      answer,
      nativeSessionId: result.nativeSessionId,
      usedFallback: false as const,
      evidence: runtimeEvidence,
    };
  }
}
