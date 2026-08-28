import { describe, expect, it, vi } from "vitest";
import {
  CODEX_MINIMUM_VERSION,
  CodexAgentAdapter,
  CodexConversationError,
  CodexRuntimePreDispatchError,
  type CodexRuntimeClient,
} from "../src/codexAgentAdapter.js";

function client(overrides: Partial<CodexRuntimeClient> = {}): CodexRuntimeClient {
  return {
    inspect: vi.fn(async () => ({
      runtimeVersion: "0.144.4",
      authorized: true,
      authorizationClass: "chatgpt" as const,
      models: ["gpt-5.6-sol", "gpt-5.6-terra"],
    })),
    runTurn: vi.fn(async (input) => ({
      answer: input.probe ? "YULU_CODEX_PROBE_OK" : "Pinned answer",
      nativeSessionId: input.nativeSessionId ?? "019f0000-0000-7000-8000-000000000135",
      actualProvider: "openai",
      actualModel: input.model,
      requestId: "turn-135",
      fallbackOccurred: false,
      toolCalls: [],
      terminalStatus: "completed" as const,
    })),
    ...overrides,
  };
}

describe("Codex Agent adapter conformance", () => {
  it("reports supported features and only projects non-secret runtime-owned authorization state", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "0.144.4",
        authorized: true,
        authorizationClass: "chatgpt" as const,
        models: ["gpt-5.6-sol"],
        account: { email: "must-not-leave-runtime@example.test", accessToken: "secret-token" },
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.status()).resolves.toEqual({
      adapter: "codex",
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      minimumVersion: CODEX_MINIMUM_VERSION,
      supported: true,
      authorized: true,
      authorizationClass: "chatgpt",
      availableModels: ["gpt-5.6-sol"],
      features: [
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
      ],
      login: {
        command: "/fake/codex login",
        statusCommand: "/fake/codex login status",
      },
      remediation: null,
    });
    expect(JSON.stringify(await adapter.status())).not.toContain("secret-token");
    expect(JSON.stringify(await adapter.status())).not.toContain("must-not-leave-runtime");
  });

  it("rejects API-key authorization before any model request and gives exact ChatGPT OAuth remediation", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "0.144.4",
        authorized: false,
        authorizationClass: "api-key" as const,
        models: [],
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.status()).resolves.toMatchObject({
      authorized: false,
      authorizationClass: "api-key",
      remediation: "Codex API-key authorization cannot be used as Runtime-owned OAuth; run /fake/codex login without --with-api-key to complete ChatGPT OAuth, then refresh this connection",
    });
    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toEqual({
      status: "failed",
      reason: "authorization_required",
      remediation: "Codex API-key authorization cannot be used as Runtime-owned OAuth; run /fake/codex login without --with-api-key to complete ChatGPT OAuth, then test Conversation again",
    });
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("fails closed for an unsupported runtime version before any model request", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "0.143.9",
        authorized: true,
        authorizationClass: "chatgpt" as const,
        models: ["gpt-5.6-sol"],
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported_runtime",
      remediation: `Upgrade Codex to ${CODEX_MINIMUM_VERSION} or newer, then test Conversation again`,
    });
    expect(runtime.runTurn).not.toHaveBeenCalled();
  });

  it("runs a bounded tool-free Conversation probe and returns redacted exact Runtime Evidence", async () => {
    const runtime = client();
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toEqual({
      status: "ready",
      reason: null,
      remediation: null,
      evidence: {
        adapter: "codex",
        transport: "codex-app-server-stdio",
        runtimeVersion: "0.144.4",
        authorizationClass: "chatgpt",
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-sol",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: "turn-135",
        sessionId: "019f0000-0000-7000-8000-000000000135",
        terminalStatus: "ready",
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    });
    expect(runtime.runTurn).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK and do not use tools.",
      probe: true,
      timeoutMs: 30_000,
    });
  });

  it("uses the same exact-model tool-free adapter for Summary probes", async () => {
    const runtime = client();
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probeSummary({ model: "gpt-5.6-sol" })).resolves.toMatchObject({
      status: "ready",
      evidence: {
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-sol",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        fallbackOccurred: false,
        terminalStatus: "ready",
      },
    });
    expect(runtime.runTurn).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK and do not use tools.",
      probe: true,
      toolFree: true,
      timeoutMs: 30_000,
    });
  });

  it("reports a typed pre-dispatch failure without claiming a model request was sent", async () => {
    const runtime = client({
      runTurn: vi.fn(async () => {
        throw new CodexRuntimePreDispatchError(
          "Codex tool-free isolation failed before turn/start; no model request was sent",
          "thread-isolation",
        );
      }),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toEqual({
      status: "failed",
      reason: "readiness_failed",
      remediation: "Codex tool-free isolation failed before turn/start; no model request was sent",
    });
  });

  it("treats an unclassified runtime exception as Unknown Outcome and forbids automatic retry", async () => {
    const runtime = client({
      runTurn: vi.fn(async () => {
        throw new Error("transport lost");
      }),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toMatchObject({
      status: "failed",
      reason: "unknown_outcome",
      remediation: "Codex probe dispatch could not be classified; inspect the runtime before creating a new attempt and do not retry automatically",
      evidence: {
        adapter: "codex",
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-sol",
        actualProvider: null,
        actualModel: null,
        requestId: null,
        sessionId: null,
        terminalStatus: "unknown",
        fallbackOccurred: true,
      },
    });
  });

  it("summarizes from only selected instructions and committed transcript in a fresh tool-free session", async () => {
    const runTurn = vi.fn(async (input: Parameters<CodexRuntimeClient["runTurn"]>[0]) => ({
      answer: "# Decisions\n\nShip the safe path.",
      nativeSessionId: "019f0000-0000-7000-8000-000000000139",
      actualProvider: "openai",
      actualModel: input.model,
      requestId: "turn-139",
      fallbackOccurred: false,
      toolCalls: [],
      terminalStatus: "completed" as const,
    }));
    const runtime = client({
      runTurn,
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.summarize({
      model: "gpt-5.6-sol",
      instructions: "Summarize decisions and owners.",
      transcript: "Alice: Ship the safe path.",
    })).resolves.toMatchObject({
      summary: "# Decisions\n\nShip the safe path.",
      nativeSessionId: "019f0000-0000-7000-8000-000000000139",
      evidence: {
        requestedProvider: "openai",
        requestedModel: "gpt-5.6-sol",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        terminalStatus: "ready",
        fallbackOccurred: false,
      },
    });
    expect(runtime.runTurn).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      prompt: [
        "Produce the recording summary from only the selected instructions and committed transcript below.",
        "Return only the Markdown summary. Do not use tools or perform side effects.",
        "",
        "Selected instructions:",
        "Summarize decisions and owners.",
        "",
        "Committed transcript:",
        "Alice: Ship the safe path.",
      ].join("\n"),
      probe: false,
      toolFree: true,
      timeoutMs: 300_000,
    });
    expect(JSON.stringify(runTurn.mock.calls)).not.toContain("/Users/");
    expect(JSON.stringify(runTurn.mock.calls)).not.toContain("credential");
  });

  it.each([
    ["non-terminal failure", { terminalStatus: "failed" as const }, /failed before a terminal successful result/],
    ["unknown outcome", { terminalStatus: "unknown" as const }, /outcome is unknown/],
    ["provider substitution", { actualProvider: "third-party" }, /different provider, model, or fallback identity/],
    ["model substitution", { actualModel: "gpt-5.6-terra" }, /different provider, model, or fallback identity/],
    ["fallback", { fallbackOccurred: true }, /different provider, model, or fallback identity/],
    ["tool call", { toolCalls: ["commandExecution"] }, /tool call or direct side effect/],
    ["empty output", { answer: "   " }, /empty or invalid output/],
    ["invalid output", { answer: "bad\u0000summary" }, /empty or invalid output/],
  ])("fails closed on Summary %s", async (_name, changed, error) => {
    const runtime = client({
      runTurn: vi.fn(async () => ({
        answer: "# Valid summary",
        nativeSessionId: "019f0000-0000-7000-8000-000000000139",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: "turn-139",
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "completed" as const,
        ...changed,
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.summarize({
      model: "gpt-5.6-sol",
      instructions: "Only selected instructions.",
      transcript: "Only committed transcript.",
    })).rejects.toThrow(error);
  });

  it("classifies Summary Unknown Outcome as typed even without a native thread id", async () => {
    const runtime = client({
      runTurn: vi.fn(async () => ({
        answer: "",
        nativeSessionId: "",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: null,
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "unknown" as const,
        cancellationRequested: true,
        cancellationConfirmed: false,
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.summarize({
      model: "gpt-5.6-sol",
      instructions: "Only selected instructions.",
      transcript: "Only committed transcript.",
    })).rejects.toMatchObject({
      name: "CodexConversationError",
      nativeSessionId: undefined,
      unknownOutcome: true,
      evidence: expect.objectContaining({
        sessionId: null,
        terminalStatus: "unknown",
        cancellationRequested: true,
        cancellationConfirmed: false,
      }),
    });
  });

  it.each([
    ["different model", { actualModel: "gpt-5.6-terra" }],
    ["provider substitution", { actualProvider: "third-party" }],
    ["runtime fallback", { fallbackOccurred: true }],
    ["missing thread identity", { nativeSessionId: "" }],
    ["tool use", { toolCalls: ["commandExecution"] }],
  ])("rejects %s without fallback", async (_name, changed) => {
    const runtime = client({
      runTurn: vi.fn(async () => ({
        answer: "YULU_CODEX_PROBE_OK",
        nativeSessionId: "019f0000-0000-7000-8000-000000000135",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: "turn-135",
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "completed" as const,
        ...changed,
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.probe({ model: "gpt-5.6-sol" })).resolves.toMatchObject({
      status: "failed",
      reason: "identity_mismatch",
      remediation: "Codex did not prove the exact requested Conversation identity; restore this connection and model, then test again",
    });
    expect(runtime.runTurn).toHaveBeenCalledTimes(1);
  });

  it("starts or resumes only the exact requested thread through the same production adapter", async () => {
    const runtime = client();
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    const started = await adapter.converse({ model: "gpt-5.6-sol", prompt: "first" });
    const resumed = await adapter.converse({
      model: "gpt-5.6-sol",
      prompt: "second",
      nativeSessionId: started.nativeSessionId,
    });

    expect(started).toMatchObject({
      answer: "Pinned answer",
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
      usedFallback: false,
    });
    expect(resumed.nativeSessionId).toBe(started.nativeSessionId);
    expect(runtime.runTurn).toHaveBeenNthCalledWith(1, {
      model: "gpt-5.6-sol",
      prompt: "first",
      probe: false,
      timeoutMs: 300_000,
    });
    expect(runtime.runTurn).toHaveBeenNthCalledWith(2, {
      model: "gpt-5.6-sol",
      prompt: "second",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: started.nativeSessionId,
    });
  });

  it("preserves the exact native thread and unknown Runtime Evidence when a sent turn is not terminal", async () => {
    const runtime = client({
      runTurn: vi.fn(async () => ({
        answer: "",
        nativeSessionId: "019f0000-0000-7000-8000-000000000777",
        actualProvider: "openai",
        actualModel: "gpt-5.6-sol",
        requestId: "turn-unknown-135",
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "unknown" as const,
        cancellationRequested: true,
        cancellationConfirmed: false,
      })),
    });
    const adapter = new CodexAgentAdapter({ executable: "/fake/codex", client: runtime });

    await expect(adapter.converse({ model: "gpt-5.6-sol", prompt: "first" })).rejects.toMatchObject({
      name: "CodexConversationError",
      nativeSessionId: "019f0000-0000-7000-8000-000000000777",
      unknownOutcome: true,
      evidence: expect.objectContaining({
        sessionId: "019f0000-0000-7000-8000-000000000777",
        terminalStatus: "unknown",
        cancellationRequested: true,
        cancellationConfirmed: false,
      }),
    });
    expect(CodexConversationError).toBeTypeOf("function");
  });
});
