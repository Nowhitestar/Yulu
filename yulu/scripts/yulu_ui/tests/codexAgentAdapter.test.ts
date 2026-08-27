import { describe, expect, it, vi } from "vitest";
import {
  CODEX_MINIMUM_VERSION,
  CodexAgentAdapter,
  CodexConversationError,
  type CodexRuntimeClient,
} from "../src/codexAgentAdapter.js";

function client(overrides: Partial<CodexRuntimeClient> = {}): CodexRuntimeClient {
  return {
    inspect: vi.fn(async () => ({
      runtimeVersion: "0.144.4",
      authorized: true,
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

  it("fails closed for an unsupported runtime version before any model request", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({ runtimeVersion: "0.143.9", authorized: true, models: ["gpt-5.6-sol"] })),
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
