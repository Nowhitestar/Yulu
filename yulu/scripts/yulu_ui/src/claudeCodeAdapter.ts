export const CLAUDE_CODE_MINIMUM_VERSION = "2.1.169";
const CLAUDE_CODE_TRANSPORT = "claude-code-print-stream-json";
const PROBE_PROMPT = "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.";

export interface ClaudeCodeRuntimeInspection {
  runtimeVersion: string;
  authorized: boolean;
  authorizationClass: ClaudeCodeAuthorizationClass;
  authorizationMethod: string | null;
  apiProvider: string | null;
  features: string[];
}

export type ClaudeCodeAuthorizationClass = "claude-subscription" | "api-key" | "unknown" | null;

export interface ClaudeCodeRuntimeConversationResult {
  runtimeVersion: string;
  answer: string;
  nativeSessionId: string;
  actualModel: string;
  requestId: string | null;
  fallbackOccurred: boolean;
  toolCalls: string[];
  isolationProven?: boolean;
  terminalStatus: "completed" | "failed" | "unknown";
  cancellationRequested?: boolean;
  cancellationConfirmed?: boolean | null;
}

export interface ClaudeCodeRuntimeClient {
  inspect(input?: { toolFree?: boolean }): Promise<ClaudeCodeRuntimeInspection>;
  runConversation(input: {
    model: string;
    prompt: string;
    probe: boolean;
    toolFree?: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ClaudeCodeRuntimeConversationResult>;
}

export interface ClaudeCodeRuntimeEvidence {
  adapter: "claude-code";
  transport: typeof CLAUDE_CODE_TRANSPORT;
  runtimeVersion: string;
  authorizationClass: ClaudeCodeAuthorizationClass;
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
  "probe-single-result",
  "tools/none",
  "probe-isolation",
  "fallback-model/opt-in",
] as const;

const REQUIRED_SUMMARY_FEATURES = [
  ...REQUIRED_FEATURES,
  "managed-hooks/none",
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
  authorizationClass: ClaudeCodeAuthorizationClass,
  requestedModel: string,
  result: ClaudeCodeRuntimeConversationResult,
  terminalStatus: ClaudeCodeRuntimeEvidence["terminalStatus"],
): ClaudeCodeRuntimeEvidence {
  return {
    adapter: "claude-code",
    transport: CLAUDE_CODE_TRANSPORT,
    runtimeVersion: result.runtimeVersion,
    authorizationClass,
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

function authorizationRemediation(
  executable: string,
  authorizationClass: ClaudeCodeAuthorizationClass,
  action: string,
): string {
  const login = `run ${executable} auth login and choose a Claude subscription`;
  if (authorizationClass === "api-key") {
    return `Claude Code API-key login cannot be used as Runtime-owned OAuth; ${login}, then ${action}`;
  }
  if (authorizationClass === "unknown") {
    return `Claude Code authorization type is not recognized as a Claude subscription; ${login}, then ${action}`;
  }
  return `Run ${executable} auth login and choose a Claude subscription, then ${action}`;
}

function identityMatches(
  result: ClaudeCodeRuntimeConversationResult,
  model: string,
  runtimeVersion: string,
  nativeSessionId?: string,
): boolean {
  return result.runtimeVersion === runtimeVersion &&
    result.actualModel === model &&
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

  async status(input: { toolFree?: boolean } = {}) {
    const inspected = await this.client.inspect(input);
    const requiredFeatures = input.toolFree ? REQUIRED_SUMMARY_FEATURES : REQUIRED_FEATURES;
    const versionSupported = versionAtLeast(inspected.runtimeVersion, CLAUDE_CODE_MINIMUM_VERSION);
    const missingFeatures = requiredFeatures.filter((feature) => !inspected.features.includes(feature));
    const supported = versionSupported && missingFeatures.length === 0;
    const authorized = inspected.authorized && inspected.authorizationClass === "claude-subscription";
    return {
      adapter: "claude-code" as const,
      transport: CLAUDE_CODE_TRANSPORT,
      runtimeVersion: inspected.runtimeVersion,
      minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
      supported,
      authorized,
      authorizationClass: inspected.authorizationClass,
      authorizationMethod: inspected.authorizationMethod,
      apiProvider: inspected.apiProvider,
      availableModels: [] as string[],
      features: requiredFeatures.filter((feature) => inspected.features.includes(feature)),
      login: {
        command: `${this.executable} auth login`,
        statusCommand: `${this.executable} auth status`,
      },
      remediation: !versionSupported
        ? `Upgrade Claude Code to ${CLAUDE_CODE_MINIMUM_VERSION} or newer, then refresh this connection`
        : input.toolFree && missingFeatures.includes("managed-hooks/none")
          ? "Claude Code cannot currently prove policy-managed hooks are disabled; Summary remains unavailable"
          : missingFeatures.length > 0
            ? `Claude Code ${inspected.runtimeVersion} is missing required Yulu features: ${missingFeatures.join(", ")}`
            : authorized ? null : authorizationRemediation(
              this.executable,
              inspected.authorizationClass,
              "refresh this connection",
            ),
    };
  }

  async probe(input: { model: string }): Promise<ClaudeCodeProbeResult> {
    return this.runProbe(input, "Conversation", false);
  }

  async probeSummary(input: { model: string }): Promise<ClaudeCodeProbeResult> {
    return this.runProbe(input, "Summary", true);
  }

  private async runProbe(
    input: { model: string },
    capability: "Conversation" | "Summary",
    toolFree: boolean,
  ): Promise<ClaudeCodeProbeResult> {
    const status = await this.status({ toolFree });
    if (!status.supported) {
      return {
        status: "failed",
        reason: "unsupported_runtime",
        remediation: status.remediation ??
          `Upgrade Claude Code to ${CLAUDE_CODE_MINIMUM_VERSION} or newer, then test ${capability} again`,
      };
    }
    if (!status.authorized) {
      return {
        status: "failed",
        reason: "authorization_required",
        remediation: authorizationRemediation(
          this.executable,
          status.authorizationClass,
          `test ${capability} again`,
        ),
      };
    }
    let result: ClaudeCodeRuntimeConversationResult;
    try {
      result = await this.client.runConversation({
        model: input.model,
        prompt: PROBE_PROMPT,
        probe: true,
        ...(toolFree ? { toolFree: true } : {}),
        timeoutMs: 30_000,
      });
    } catch {
      return {
        status: "failed",
        reason: "readiness_failed",
        remediation: `Claude Code ${capability} probe failed; restore native authorization and the exact model, then test again`,
      };
    }
    const evidence = runtimeEvidence(
      status.authorizationClass,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : "failed",
    );
    if (
      result.terminalStatus !== "completed" ||
      result.answer.trim() !== "YULU_CLAUDE_PROBE_OK" ||
      result.toolCalls.length > 0 ||
      (toolFree && (result.isolationProven !== true || !result.requestId)) ||
      !identityMatches(result, input.model, status.runtimeVersion)
    ) {
      return {
        status: "failed",
        reason: result.terminalStatus === "unknown" ? "unknown_outcome" : "identity_mismatch",
        remediation: result.terminalStatus === "unknown"
          ? "Claude Code probe outcome is unknown; inspect the exact native session before creating a new attempt"
          : `Claude Code did not prove the exact requested ${capability} runtime, model, and session identity`,
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

  async summarize(input: {
    model: string;
    instructions: string;
    transcript: string;
  }) {
    const status = await this.status({ toolFree: true });
    if (!status.supported) throw new Error(status.remediation ?? "Claude Code runtime is unsupported");
    if (!status.authorized) {
      throw new Error(authorizationRemediation(
        this.executable,
        status.authorizationClass,
        "retry this same Summary input",
      ));
    }
    const result = await this.client.runConversation({
      model: input.model,
      prompt: [
        "Produce the recording summary from only the selected instructions and committed transcript below.",
        "Return only the Markdown summary. Do not use tools or perform side effects.",
        "",
        "Selected instructions:",
        input.instructions,
        "",
        "Committed transcript:",
        input.transcript,
      ].join("\n"),
      probe: false,
      toolFree: true,
      timeoutMs: 300_000,
    });
    const evidence = runtimeEvidence(
      status.authorizationClass,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : result.terminalStatus === "failed" ? "failed" : "ready",
    );
    if (result.terminalStatus !== "completed") {
      throw new ClaudeCodeConversationError(
        result.terminalStatus === "unknown"
          ? "Claude Code Summary entered Unknown Outcome; inspect the native session and do not retry automatically"
          : "Claude Code Summary failed before a terminal successful result",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence,
          unknownOutcome: result.terminalStatus === "unknown",
        },
      );
    }
    if (result.isolationProven !== true) {
      throw new Error("Claude Code Summary did not return tool-free isolation proof");
    }
    if (!result.requestId) {
      throw new Error("Claude Code Summary did not return terminal result identity");
    }
    if (!identityMatches(result, input.model, status.runtimeVersion)) {
      throw new Error("Claude Code Summary returned a different model, session, or fallback identity");
    }
    if (result.toolCalls.length > 0) {
      throw new Error("Claude Code Summary attempted a tool call or direct side effect");
    }
    const summary = result.answer.trim();
    if (!summary || summary.includes("\0")) {
      throw new Error("Claude Code Summary returned empty or invalid output");
    }
    return {
      summary,
      nativeSessionId: result.nativeSessionId,
      evidence,
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
      throw new Error(authorizationRemediation(
        this.executable,
        status.authorizationClass,
        "retry this same Conversation input",
      ));
    }
    const result = await this.client.runConversation({
      model: input.model,
      prompt: input.prompt,
      probe: false,
      timeoutMs: 300_000,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
    const evidence = runtimeEvidence(
      status.authorizationClass,
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
    if (!identityMatches(result, input.model, status.runtimeVersion, input.nativeSessionId)) {
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
