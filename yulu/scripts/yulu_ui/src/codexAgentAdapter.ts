export const CODEX_MINIMUM_VERSION = "0.144.0";
const CODEX_PROVIDER = "openai";
const CODEX_TRANSPORT = "codex-app-server-stdio";
const PROBE_PROMPT = "Reply with exactly YULU_CODEX_PROBE_OK and do not use tools.";

export interface CodexRuntimeInspection {
  runtimeVersion: string;
  authorized: boolean;
  models: string[];
}

export interface CodexRuntimeTurnResult {
  answer: string;
  nativeSessionId: string;
  actualProvider: string;
  actualModel: string;
  requestId: string | null;
  fallbackOccurred: boolean;
  toolCalls: string[];
  terminalStatus: "completed" | "failed" | "unknown";
  cancellationRequested?: boolean;
  cancellationConfirmed?: boolean | null;
  failureStage?: "turn_start_rejected";
}

export interface CodexRuntimeClient {
  inspect(input?: { toolFree?: boolean }): Promise<CodexRuntimeInspection>;
  runTurn(input: {
    model: string;
    prompt: string;
    probe: boolean;
    toolFree?: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<CodexRuntimeTurnResult>;
}

export interface CodexRuntimeEvidence {
  adapter: "codex";
  transport: typeof CODEX_TRANSPORT;
  runtimeVersion: string;
  requestedProvider: typeof CODEX_PROVIDER;
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

export type CodexProbeFailureReason =
  | "unsupported_runtime"
  | "authorization_required"
  | "invalid_model"
  | "identity_mismatch"
  | "readiness_failed"
  | "unknown_outcome";

export interface CodexProbeResult {
  status: "ready" | "failed";
  reason: CodexProbeFailureReason | null;
  remediation: string | null;
  evidence?: CodexRuntimeEvidence;
}

export type CodexPreDispatchStage = "initialize" | "thread-start" | "thread-isolation" | "turn-start-write";

export class CodexRuntimePreDispatchError extends Error {
  readonly stage: CodexPreDispatchStage;
  readonly modelRequestSent = false;

  constructor(message: string, stage: CodexPreDispatchStage) {
    super(message);
    this.name = "CodexRuntimePreDispatchError";
    this.stage = stage;
  }
}

export class CodexConversationError extends Error {
  readonly nativeSessionId?: string;
  readonly evidence: CodexRuntimeEvidence;
  readonly unknownOutcome: boolean;

  constructor(
    message: string,
    options: {
      nativeSessionId?: string;
      evidence: CodexRuntimeEvidence;
      unknownOutcome: boolean;
    },
  ) {
    super(message);
    this.name = "CodexConversationError";
    this.nativeSessionId = options.nativeSessionId;
    this.evidence = options.evidence;
    this.unknownOutcome = options.unknownOutcome;
  }
}

const FEATURES = [
  "account/read",
  "model/list",
  "thread/start",
  "thread/resume",
  "turn/start",
  "turn/interrupt",
  "experimentalFeature/list",
  "mcpServerStatus/list",
  "app/list",
  "no-provider-model-fallback",
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

function evidence(
  runtimeVersion: string,
  requestedModel: string,
  result: CodexRuntimeTurnResult,
  terminalStatus: CodexRuntimeEvidence["terminalStatus"],
): CodexRuntimeEvidence {
  return {
    adapter: "codex",
    transport: CODEX_TRANSPORT,
    runtimeVersion,
    requestedProvider: CODEX_PROVIDER,
    requestedModel,
    actualProvider: result.actualProvider || null,
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
  result: CodexRuntimeTurnResult,
  model: string,
  nativeSessionId?: string,
): boolean {
  return result.actualProvider === CODEX_PROVIDER &&
    result.actualModel === model &&
    result.fallbackOccurred === false &&
    Boolean(result.nativeSessionId) &&
    (!nativeSessionId || result.nativeSessionId === nativeSessionId);
}

export class CodexAgentAdapter {
  readonly executable: string;
  private readonly client: CodexRuntimeClient;

  constructor(options: { executable: string; client: CodexRuntimeClient }) {
    this.executable = options.executable;
    this.client = options.client;
  }

  async status(input: { toolFree?: boolean } = {}) {
    const inspected = await this.client.inspect(input);
    const supported = versionAtLeast(inspected.runtimeVersion, CODEX_MINIMUM_VERSION);
    return {
      adapter: "codex" as const,
      transport: CODEX_TRANSPORT,
      runtimeVersion: inspected.runtimeVersion,
      minimumVersion: CODEX_MINIMUM_VERSION,
      supported,
      authorized: inspected.authorized,
      availableModels: [...new Set(inspected.models)].sort(),
      features: [...FEATURES],
      login: {
        command: `${this.executable} login`,
        statusCommand: `${this.executable} login status`,
      },
      remediation: supported
        ? inspected.authorized ? null : `Run ${this.executable} login, then refresh this connection`
        : `Upgrade Codex to ${CODEX_MINIMUM_VERSION} or newer, then refresh this connection`,
    };
  }

  async probe(input: { model: string }): Promise<CodexProbeResult> {
    return this.runProbe(input, "Conversation", false);
  }

  async probeSummary(input: { model: string }): Promise<CodexProbeResult> {
    return this.runProbe(input, "Summary", true);
  }

  private async runProbe(
    input: { model: string },
    capability: "Conversation" | "Summary",
    toolFree: boolean,
  ): Promise<CodexProbeResult> {
    const status = await this.status({ toolFree });
    if (!status.supported) {
      return {
        status: "failed",
        reason: "unsupported_runtime",
        remediation: `Upgrade Codex to ${CODEX_MINIMUM_VERSION} or newer, then test ${capability} again`,
      };
    }
    if (!status.authorized) {
      return {
        status: "failed",
        reason: "authorization_required",
        remediation: `Run ${this.executable} login, then test ${capability} again`,
      };
    }
    if (!status.availableModels.includes(input.model)) {
      return {
        status: "failed",
        reason: "invalid_model",
        remediation: `Select the exact Codex model ${input.model} only after it appears in model/list`,
      };
    }
    let result: CodexRuntimeTurnResult;
    try {
      result = await this.client.runTurn({
        model: input.model,
        prompt: PROBE_PROMPT,
        probe: true,
        ...(toolFree ? { toolFree: true } : {}),
        timeoutMs: 30_000,
      });
    } catch (error) {
      if (error instanceof CodexRuntimePreDispatchError) {
        return {
          status: "failed",
          reason: "readiness_failed",
          remediation: error.message,
        };
      }
      return {
        status: "failed",
        reason: "unknown_outcome",
        remediation: "Codex probe dispatch could not be classified; inspect the runtime before creating a new attempt and do not retry automatically",
      };
    }
    const runtimeEvidence = evidence(
      status.runtimeVersion,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : "failed",
    );
    if (result.failureStage === "turn_start_rejected") {
      return {
        status: "failed",
        reason: "readiness_failed",
        remediation: `Codex app-server rejected ${capability} turn/start with a terminal response; no model result was produced`,
        evidence: runtimeEvidence,
      };
    }
    if (
      result.terminalStatus !== "completed" ||
      result.answer.trim() !== "YULU_CODEX_PROBE_OK" ||
      result.toolCalls.length > 0 ||
      !identityMatches(result, input.model)
    ) {
      return {
        status: "failed",
        reason: result.terminalStatus === "unknown" ? "unknown_outcome" : "identity_mismatch",
        remediation: result.terminalStatus === "unknown"
          ? "Codex probe outcome is unknown; restore this exact connection and inspect the pinned thread before creating a new attempt"
          : `Codex did not prove the exact requested ${capability} identity; restore this connection and model, then test again`,
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

  async summarize(input: {
    model: string;
    instructions: string;
    transcript: string;
  }) {
    const status = await this.status({ toolFree: true });
    if (!status.supported) throw new Error(status.remediation ?? "Codex runtime is unsupported");
    if (!status.authorized) throw new Error(`Run ${this.executable} login, then retry this same Summary input`);
    if (!status.availableModels.includes(input.model)) {
      throw new Error(`Codex model ${input.model} is not available; restore the pinned model, then retry this same Summary input`);
    }
    const result = await this.client.runTurn({
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
    const runtimeEvidence = evidence(
      status.runtimeVersion,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : result.terminalStatus === "failed" ? "failed" : "ready",
    );
    if (result.terminalStatus !== "completed") {
      throw new CodexConversationError(
        result.terminalStatus === "unknown"
          ? "Codex Summary outcome is unknown; do not retry automatically or commit staged output"
          : "Codex Summary failed before a terminal successful result",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: result.terminalStatus === "unknown",
        },
      );
    }
    if (!identityMatches(result, input.model)) {
      throw new Error("Codex Summary returned a different provider, model, or fallback identity");
    }
    if (result.toolCalls.length > 0) {
      throw new Error("Codex Summary attempted a tool call or direct side effect");
    }
    const summary = result.answer.trim();
    if (!summary || summary.includes("\0")) {
      throw new Error("Codex Summary returned empty or invalid output");
    }
    return {
      summary,
      nativeSessionId: result.nativeSessionId,
      evidence: runtimeEvidence,
    };
  }

  async converse(input: {
    model: string;
    prompt: string;
    nativeSessionId?: string;
  }) {
    const status = await this.status();
    if (!status.supported) throw new Error(status.remediation ?? "Codex runtime is unsupported");
    if (!status.authorized) throw new Error(`Run ${this.executable} login, then retry this same conversation input`);
    if (!status.availableModels.includes(input.model)) {
      throw new Error(`Codex model ${input.model} is not available; restore the pinned model, then retry this same input`);
    }
    const result = await this.client.runTurn({
      model: input.model,
      prompt: input.prompt,
      probe: false,
      timeoutMs: 300_000,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
    const runtimeEvidence = evidence(
      status.runtimeVersion,
      input.model,
      result,
      result.terminalStatus === "unknown" ? "unknown" : result.terminalStatus === "failed" ? "failed" : "ready",
    );
    if (result.terminalStatus !== "completed") {
      throw new CodexConversationError(
        result.terminalStatus === "unknown"
          ? "Codex conversation outcome is unknown; inspect the pinned thread and do not retry automatically"
          : "Codex conversation failed; restore the pinned connection and retry this same input explicitly",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: result.terminalStatus === "unknown",
        },
      );
    }
    if (!identityMatches(result, input.model, input.nativeSessionId)) {
      throw new CodexConversationError(
        "Codex returned a different provider, model, or thread; fallback was rejected",
        {
          ...(result.nativeSessionId ? { nativeSessionId: result.nativeSessionId } : {}),
          evidence: runtimeEvidence,
          unknownOutcome: false,
        },
      );
    }
    const answer = result.answer.trim();
    if (!answer) {
      throw new CodexConversationError(
        "Codex returned no Conversation answer; retry this same input explicitly",
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
