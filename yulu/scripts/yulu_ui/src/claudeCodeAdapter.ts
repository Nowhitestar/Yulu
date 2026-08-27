export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.169";
const CLAUDE_CODE_TRANSPORT = "claude-code-print-stream-json";
const PROBE_PROMPT = "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.";

export interface ClaudeCodeRuntimeInspection {
  runtimeVersion: string;
  authorized: boolean;
  authorizationMethod: string | null;
  apiProvider: string | null;
  features: string[];
}

export interface ClaudeCodeRuntimeConversationResult {
  answer: string;
  nativeSessionId: string;
  actualModel: string;
  requestId: string | null;
  fallbackOccurred: boolean;
  toolCalls: string[];
  terminalStatus: "completed" | "failed" | "unknown";
  cancellationRequested?: boolean;
  cancellationConfirmed?: boolean | null;
}

export interface ClaudeCodeRuntimeClient {
  inspect(): Promise<ClaudeCodeRuntimeInspection>;
  runConversation(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ClaudeCodeRuntimeConversationResult>;
}

export interface ClaudeCodeRuntimeEvidence {
  adapter: "claude-code";
  transport: typeof CLAUDE_CODE_TRANSPORT;
  runtimeVersion: string;
  requestedProvider: null;
  requestedModel: string;
  actualProvider: string | null;
  actualModel: string | null;
  requestId: string | null;
  sessionId: string | null;
  terminalStatus: "ready" | "failed" | "unknown";
  fallbackOccurred: boolean;
  cancellationRequested: boolean;
  cancellationConfirmed: boolean | null;
}

export type ClaudeCodeProbeFailureReason =
  | "unsupported_runtime"
  | "authorization_required"
  | "identity_mismatch"
  | "readiness_failed"
  | "unknown_outcome";

export interface ClaudeCodeProbeResult {
  status: "ready" | "failed";
  reason: ClaudeCodeProbeFailureReason | null;
  remediation: string | null;
  evidence?: ClaudeCodeRuntimeEvidence;
}

export class ClaudeCodeConversationError extends Error {
  readonly nativeSessionId?: string;
  readonly evidence: ClaudeCodeRuntimeEvidence;
  readonly unknownOutcome: boolean;

  constructor(
    message: string,
    options: {
      nativeSessionId?: string;
      evidence: ClaudeCodeRuntimeEvidence;
      unknownOutcome: boolean;
    },
  ) {
    super(message);
    this.name = "ClaudeCodeConversationError";
    this.nativeSessionId = options.nativeSessionId;
    this.evidence = options.evidence;
    this.unknownOutcome = options.unknownOutcome;
  }
}

const REQUIRED_FEATURES = [
  "auth/status",
  "safe-mode",
  "print/stream-json",
  "verbose",
  "model",
  "session-id",
  "resume",
  "probe-bounds",
  "tools/none",
  "probe-isolation",
  "fallback-model/opt-in",
] as const;

function versionParts(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value.trim());
  return match ? match.slice(1).map(Number) : null;
}

function versionAtLeast(actual: string, minimum: string): boolean {
  const left = versionParts(actual);
  const right = versionParts(minimum);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left[index]! > right[index]!) return true;
    if (left[index]! < right[index]!) return false;
  }
  return true;
}

function runtimeEvidence(
  runtimeVersion: string,
  requestedModel: string,
  result: ClaudeCodeRuntimeConversationResult,
  terminalStatus: ClaudeCodeRuntimeEvidence["terminalStatus"],
): ClaudeCodeRuntimeEvidence {
  return {
    adapter: "claude-code",
    transport: CLAUDE_CODE_TRANSPORT,
    runtimeVersion,
    requestedProvider: null,
    requestedModel,
    actualProvider: null,
    actualModel: result.actualModel || null,
    requestId: result.requestId,
    sessionId: result.nativeSessionId || null,
    terminalStatus,
    fallbackOccurred: result.fallbackOccurred,
    cancellationRequested: result.cancellationRequested ?? false,
    cancellationConfirmed: result.cancellationConfirmed ?? null,
  };
}

function identityMatches(
  result: ClaudeCodeRuntimeConversationResult,
  model: string,
  nativeSessionId?: string,
): boolean {
  return result.actualModel === model &&
    result.fallbackOccurred === false &&
    Boolean(result.nativeSessionId) &&
    (!nativeSessionId || result.nativeSessionId === nativeSessionId);
}

export class ClaudeCodeAdapter {
  readonly executable: string;
  private readonly client: ClaudeCodeRuntimeClient;

  constructor(options: { executable: string; client: ClaudeCodeRuntimeClient }) {
    this.executable = options.executable;
    this.client = options.client;
  }

  async status() {
    const inspected = await this.client.inspect();
    const supported = versionAtLeast(inspected.runtimeVersion, CLAUDE_CODE_MINIMUM_VERSION) &&
      REQUIRED_FEATURES.every((feature) => inspected.features.includes(feature));
    return {
      adapter: "claude-code" as const,
      transport: CLAUDE_CODE_TRANSPORT,
      runtimeVersion: inspected.runtimeVersion,
      minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
      supported,
      authorized: inspected.authorized,
      authorizationMethod: inspected.authorizationMethod,
      apiProvider: inspected.apiProvider,
      availableModels: [] as string[],
      features: REQUIRED_FEATURES.filter((feature) => inspected.features.includes(feature)),
      login: {
        command: `${this.executable} auth login`,
        statusCommand: `${this.executable} auth status`,
      },
      remediation: supported
        ? inspected.authorized ? null : `Run ${this.executable} auth login, then refresh this connection`
        : `Upgrade Claude Code to ${CLAUDE_CODE_MINIMUM_VERSION} or newer, then refresh this connection`,
    };
  }

  async probe(input: { model: string }): Promise<ClaudeCodeProbeResult> {
    const status = await this.status();
    if (!status.supported) {
      return {
        status: "failed",
        reason: "unsupported_runtime",
        remediation: `Upgrade Claude Code to ${CLAUDE_CODE_MINIMUM_VERSION} or newer, then test Conversation again`,
      };
    }
    if (!status.authorized) {
      return {
        status: "failed",
        reason: "authorization_required",
        remediation: `Run ${this.executable} auth login, then test Conversation again`,
      };
    }
    let result: ClaudeCodeRuntimeConversationResult;
    try {
      result = await this.client.runConversation({
        model: input.model,
        prompt: PROBE_PROMPT,
        probe: true,
        timeoutMs: 30_000,
      });
    } catch {
      return {
        status: "failed",
        reason: "readiness_failed",
        remediation: "Claude Code Conversation probe failed; restore native authorization and the exact model, then test again",
      };
    }
    const evidence = runtimeEvidence(
      status.runtimeVersion,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : "failed",
    );
    if (
      result.terminalStatus !== "completed" ||
      result.answer.trim() !== "YULU_CLAUDE_PROBE_OK" ||
      result.toolCalls.length > 0 ||
      !identityMatches(result, input.model)
    ) {
      return {
        status: "failed",
        reason: result.terminalStatus === "unknown" ? "unknown_outcome" : "identity_mismatch",
        remediation: result.terminalStatus === "unknown"
          ? "Claude Code probe outcome is unknown; inspect the exact native session before creating a new attempt"
          : "Claude Code did not prove the exact requested Conversation runtime, model, and session identity",
        evidence,
      };
    }
    return {
      status: "ready",
      reason: null,
      remediation: null,
      evidence: { ...evidence, terminalStatus: "ready" },
    };
  }

  async converse(input: {
    model: string;
    prompt: string;
    nativeSessionId?: string;
  }) {
    const status = await this.status();
    if (!status.supported) throw new Error(status.remediation ?? "Claude Code runtime is unsupported");
    if (!status.authorized) {
      throw new Error(`Run ${this.executable} auth login, then retry this same Conversation input`);
    }
    const result = await this.client.runConversation({
      model: input.model,
      prompt: input.prompt,
      probe: false,
      timeoutMs: 300_000,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
    const evidence = runtimeEvidence(
      status.runtimeVersion,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : result.terminalStatus === "failed" ? "failed" : "ready",
    );
    if (result.terminalStatus !== "completed") {
      throw new ClaudeCodeConversationError(
        result.terminalStatus === "unknown"
          ? "Claude Code Conversation outcome is unknown; inspect the pinned native session and do not retry automatically"
          : "Claude Code Conversation failed; restore native authorization and retry this same input explicitly",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence,
          unknownOutcome: result.terminalStatus === "unknown",
        },
      );
    }
    if (!identityMatches(result, input.model, input.nativeSessionId)) {
      throw new ClaudeCodeConversationError(
        "Claude Code returned a different provider, model, or native session; fallback was rejected",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence,
          unknownOutcome: false,
        },
      );
    }
    const answer = result.answer.trim();
    if (!answer) {
      throw new ClaudeCodeConversationError(
        "Claude Code returned no Conversation answer; retry this same input explicitly",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence,
          unknownOutcome: false,
        },
      );
    }
    return {
      answer,
      nativeSessionId: result.nativeSessionId,
      usedFallback: false as const,
      evidence,
    };
  }
}
