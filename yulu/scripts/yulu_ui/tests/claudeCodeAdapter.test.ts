import { describe, expect, it, vi } from "vitest";
import {
  CLAUDE_CODE_MINIMUM_VERSION,
  ClaudeCodeAdapter,
  ClaudeCodeConversationError,
  type ClaudeCodeRuntimeClient,
} from "../src/claudeCodeAdapter.js";

const SUPPORTED_FEATURES = [
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
];
const SUMMARY_SUPPORTED_FEATURES = [...SUPPORTED_FEATURES, "managed-hooks/none", "provider-identity"];

function client(overrides: Partial<ClaudeCodeRuntimeClient> = {}): ClaudeCodeRuntimeClient {
  return {
    inspect: vi.fn(async () => ({
      runtimeVersion: "2.1.169",
      authorized: true,
      authorizationClass: "claude-subscription" as const,
      authorizationMethod: "claude.ai",
      apiProvider: "firstParty",
      features: [...SUMMARY_SUPPORTED_FEATURES],
    })),
    runConversation: vi.fn(async (input) => ({
      runtimeVersion: "2.1.169",
      answer: input.probe ? "YULU_CLAUDE_PROBE_OK" : "Pinned answer",
      nativeSessionId: input.nativeSessionId ?? "019f0000-0000-7000-8000-000000000136",
      actualModel: input.model,
      actualProvider: input.toolFree ? "firstParty" : null,
      requestId: "request-136",
      fallbackOccurred: false,
      toolCalls: [],
      ...(input.toolFree ? { isolationProven: true } : {}),
      terminalStatus: "completed" as const,
    })),
    ...overrides,
  };
}

describe("Claude Code adapter conformance", () => {
  it("reports the supported runtime and only non-secret native authorization status", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.169",
        authorized: true,
        authorizationClass: "claude-subscription" as const,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        features: [...SUPPORTED_FEATURES],
        email: "must-not-leave-runtime@example.test",
        accessToken: "secret-token",
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status()).resolves.toEqual({
      adapter: "claude-code",
      transport: "claude-code-print-stream-json",
      runtimeVersion: "2.1.169",
      minimumVersion: CLAUDE_CODE_MINIMUM_VERSION,
      supported: true,
      authorized: true,
      authorizationClass: "claude-subscription",
      authorizationMethod: "claude.ai",
      apiProvider: "firstParty",
      availableModels: [],
      features: SUPPORTED_FEATURES,
      login: {
        command: "/fake/claude auth login",
        statusCommand: "/fake/claude auth status",
      },
      remediation: null,
    });
    expect(JSON.stringify(await adapter.status())).not.toContain("secret-token");
    expect(JSON.stringify(await adapter.status())).not.toContain("must-not-leave-runtime");
  });

  it("rejects API-key login before any model request and gives exact Claude subscription remediation", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.228",
        authorized: false,
        authorizationClass: "api-key" as const,
        authorizationMethod: "api_key",
        apiProvider: "firstParty",
        features: [...SUPPORTED_FEATURES],
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status()).resolves.toMatchObject({
      authorized: false,
      authorizationClass: "api-key",
      remediation: "Claude Code API-key login cannot be used as Runtime-owned OAuth; run /fake/claude auth login and choose a Claude subscription, then refresh this connection",
    });
    await expect(adapter.probe({ model: "claude-sonnet-5" })).resolves.toEqual({
      status: "failed",
      reason: "authorization_required",
      remediation: "Claude Code API-key login cannot be used as Runtime-owned OAuth; run /fake/claude auth login and choose a Claude subscription, then test Conversation again",
    });
    expect(runtime.runConversation).not.toHaveBeenCalled();
  });

  it("runs a bounded tool-free Conversation probe and returns exact redacted Runtime Evidence", async () => {
    const runtime = client();
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.probe({ model: "claude-sonnet-5" })).resolves.toEqual({
      status: "ready",
      reason: null,
      remediation: null,
      evidence: {
        adapter: "claude-code",
        transport: "claude-code-print-stream-json",
        runtimeVersion: "2.1.169",
        authorizationClass: "claude-subscription",
        requestedProvider: null,
        requestedModel: "claude-sonnet-5",
        actualProvider: null,
        actualModel: "claude-sonnet-5",
        requestId: "request-136",
        sessionId: "019f0000-0000-7000-8000-000000000136",
        terminalStatus: "ready",
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    });
    expect(runtime.runConversation).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      prompt: "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.",
      probe: true,
      timeoutMs: 30_000,
    });
  });

  it("keeps Summary unavailable when the runtime cannot prove the invocation provider", async () => {
    const runConversation = vi.fn();
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.169",
        authorized: true,
        authorizationClass: "claude-subscription" as const,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        features: SUMMARY_SUPPORTED_FEATURES.filter((feature) => feature !== "provider-identity"),
      })),
      runConversation,
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status({ toolFree: true })).resolves.toMatchObject({
      supported: false,
      remediation: expect.stringContaining("exact provider identity"),
    });
    await expect(adapter.probeSummary({ model: "claude-sonnet-5" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported_runtime",
      remediation: expect.stringContaining("exact provider identity"),
    });
    expect(runConversation).not.toHaveBeenCalled();
  });

  it("declares Summary ready only with exact provider and model evidence", async () => {
    const runtime = client();
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.probeSummary({ model: "claude-sonnet-5" })).resolves.toMatchObject({
      status: "ready",
      evidence: {
        requestedProvider: "firstParty",
        requestedModel: "claude-sonnet-5",
        actualProvider: "firstParty",
        actualModel: "claude-sonnet-5",
        fallbackOccurred: false,
      },
    });
    expect(runtime.runConversation).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      prompt: "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.",
      probe: true,
      toolFree: true,
      timeoutMs: 30_000,
    });
  });

  it("keeps Summary unavailable before model invocation when managed hooks cannot be proven absent", async () => {
    const runConversation = vi.fn();
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.169",
        authorized: true,
        authorizationClass: "claude-subscription" as const,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        features: [...SUPPORTED_FEATURES],
      })),
      runConversation,
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status({ toolFree: true })).resolves.toMatchObject({
      supported: false,
      remediation: expect.stringContaining("policy-managed hooks"),
    });
    await expect(adapter.probeSummary({ model: "claude-sonnet-5" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported_runtime",
      remediation: expect.stringContaining("policy-managed hooks"),
    });
    await expect(adapter.summarize({
      model: "claude-sonnet-5",
      instructions: "Selected instructions.",
      transcript: "Committed transcript.",
    })).rejects.toThrow("policy-managed hooks");
    expect(runConversation).not.toHaveBeenCalled();
  });

  it("supports Claude 2.1.210 Conversation without --max-turns when single-result print is proven", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.210",
        authorized: true,
        authorizationClass: "claude-subscription" as const,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        features: [...SUPPORTED_FEATURES],
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status()).resolves.toMatchObject({
      supported: true,
      runtimeVersion: "2.1.210",
      remediation: null,
    });
  });

  it("reports exact missing features instead of telling a newer runtime to upgrade", async () => {
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion: "2.1.210",
        authorized: true,
        authorizationClass: "claude-subscription" as const,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        features: SUPPORTED_FEATURES.filter((feature) => feature !== "tools/none"),
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.status()).resolves.toMatchObject({
      supported: false,
      remediation: "Claude Code 2.1.210 is missing required Yulu features: tools/none",
    });
  });

  it("summarizes only selected instructions and committed transcript through a fresh tool-free invocation", async () => {
    const runtime = client({
      runConversation: vi.fn(async (input) => ({
        runtimeVersion: "2.1.169",
        answer: "# Safe summary",
        nativeSessionId: "019f0000-0000-7000-8000-000000000140",
        actualModel: input.model,
        actualProvider: "firstParty",
        requestId: "request-140",
        fallbackOccurred: false,
        toolCalls: [],
        isolationProven: true,
        terminalStatus: "completed" as const,
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.summarize({
      model: "claude-sonnet-5",
      instructions: "Use concise bullets.",
      transcript: "Host-read committed transcript.",
    })).resolves.toEqual({
      summary: "# Safe summary",
      nativeSessionId: "019f0000-0000-7000-8000-000000000140",
      evidence: {
        adapter: "claude-code",
        transport: "claude-code-print-stream-json",
        runtimeVersion: "2.1.169",
        authorizationClass: "claude-subscription",
        requestedProvider: "firstParty",
        requestedModel: "claude-sonnet-5",
        actualProvider: "firstParty",
        actualModel: "claude-sonnet-5",
        requestId: "request-140",
        sessionId: "019f0000-0000-7000-8000-000000000140",
        terminalStatus: "ready",
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    });
    expect(runtime.runConversation).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      prompt: [
        "Produce the recording summary from only the selected instructions and committed transcript below.",
        "Return only the Markdown summary. Do not use tools or perform side effects.",
        "",
        "Selected instructions:",
        "Use concise bullets.",
        "",
        "Committed transcript:",
        "Host-read committed transcript.",
      ].join("\n"),
      probe: false,
      toolFree: true,
      timeoutMs: 300_000,
    });
  });

  it.each([
    ["missing isolation proof", { isolationProven: false }, /isolation proof/i],
    ["different invocation version", { runtimeVersion: "2.1.170" }, /model, session, or fallback identity/i],
    ["missing terminal result identity", { requestId: null }, /result identity/i],
    ["tool use", { toolCalls: ["Bash"] }, /tool call/i],
    ["model fallback", { actualModel: "claude-fallback", fallbackOccurred: true }, /fallback identity/i],
    ["invalid output", { answer: "bad\0summary" }, /invalid output/i],
  ])("rejects Summary %s before output can be committed", async (_label, overrides, error) => {
    const runtime = client({
      runConversation: vi.fn(async (input) => ({
        runtimeVersion: "2.1.169",
        answer: "# Summary",
        nativeSessionId: "019f0000-0000-7000-8000-000000000140",
        actualModel: input.model,
        actualProvider: "firstParty",
        requestId: "request-140",
        fallbackOccurred: false,
        toolCalls: [],
        isolationProven: true,
        terminalStatus: "completed" as const,
        ...overrides,
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.summarize({
      model: "claude-sonnet-5",
      instructions: "Selected instructions.",
      transcript: "Committed transcript.",
    })).rejects.toThrow(error);
  });

  it("does not declare Summary ready when the probe lacks isolation or terminal result proof", async () => {
    const runtime = client({
      runConversation: vi.fn(async (input) => ({
        runtimeVersion: "2.1.169",
        answer: "YULU_CLAUDE_PROBE_OK",
        nativeSessionId: "019f0000-0000-7000-8000-000000000140",
        actualModel: input.model,
        actualProvider: "firstParty",
        requestId: null,
        fallbackOccurred: false,
        toolCalls: [],
        isolationProven: false,
        terminalStatus: "completed" as const,
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.probeSummary({ model: "claude-sonnet-5" })).resolves.toMatchObject({
      status: "failed",
      reason: "identity_mismatch",
    });
  });

  it("creates and resumes only the exact pinned Claude session without fallback", async () => {
    const runtime = client();
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.converse({
      model: "claude-sonnet-5",
      prompt: "First turn",
    })).resolves.toMatchObject({
      answer: "Pinned answer",
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
      usedFallback: false,
      evidence: {
        requestedModel: "claude-sonnet-5",
        actualModel: "claude-sonnet-5",
        sessionId: "019f0000-0000-7000-8000-000000000136",
        fallbackOccurred: false,
      },
    });
    await expect(adapter.converse({
      model: "claude-sonnet-5",
      prompt: "Second turn",
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
    })).resolves.toMatchObject({
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
    });
    expect(runtime.runConversation).toHaveBeenNthCalledWith(2, {
      model: "claude-sonnet-5",
      prompt: "Second turn",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
    });
    expect(ClaudeCodeConversationError).toBeTypeOf("function");
  });

  it.each([
    ["unsupported_runtime", "2.1.168", true],
    ["authorization_required", "2.1.169", false],
  ] as const)("does not send a model request when status is %s", async (reason, runtimeVersion, authorized) => {
    const runConversation = vi.fn();
    const runtime = client({
      inspect: vi.fn(async () => ({
        runtimeVersion,
        authorized,
        authorizationClass: authorized ? "claude-subscription" as const : null,
        authorizationMethod: authorized ? "claude.ai" : null,
        apiProvider: authorized ? "firstParty" : null,
        features: [...SUPPORTED_FEATURES],
      })),
      runConversation,
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.probe({ model: "claude-sonnet-5" })).resolves.toMatchObject({
      status: "failed",
      reason,
    });
    expect(runConversation).not.toHaveBeenCalled();
  });

  it.each(["verbose", "probe-single-result", "probe-isolation", "fallback-model/opt-in"])(
    "fails closed when the runtime does not prove required feature %s",
    async (missingFeature) => {
      const runConversation = vi.fn();
      const runtime = client({
        inspect: vi.fn(async () => ({
          runtimeVersion: "2.1.169",
          authorized: true,
          authorizationClass: "claude-subscription" as const,
          authorizationMethod: "claude.ai",
          apiProvider: "firstParty",
          features: SUPPORTED_FEATURES.filter((feature) => feature !== missingFeature),
        })),
        runConversation,
      });
      const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

      await expect(adapter.status()).resolves.toMatchObject({ supported: false });
      await expect(adapter.probe({ model: "claude-sonnet-5" })).resolves.toMatchObject({
        status: "failed",
        reason: "unsupported_runtime",
      });
      expect(runConversation).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["model fallback", { actualModel: "claude-fallback", fallbackOccurred: true }],
    ["missing model identity", { actualModel: "" }],
    ["different resumed session", { nativeSessionId: "019f0000-0000-7000-8000-000000000999" }],
  ])("rejects %s instead of accepting a Conversation fallback", async (_label, overrides) => {
    const runtime = client({
      runConversation: vi.fn(async () => ({
        runtimeVersion: "2.1.169",
        answer: "must be rejected",
        nativeSessionId: "019f0000-0000-7000-8000-000000000136",
        actualModel: "claude-sonnet-5",
        requestId: "request-136",
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "completed" as const,
        ...overrides,
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.converse({
      model: "claude-sonnet-5",
      prompt: "Continue",
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
    })).rejects.toMatchObject({
      name: "ClaudeCodeConversationError",
      unknownOutcome: false,
      evidence: { fallbackOccurred: "fallbackOccurred" in overrides ? overrides.fallbackOccurred : false },
    });
  });

  it("preserves exact evidence and native session when a Conversation outcome is unknown", async () => {
    const nativeSessionId = "019f0000-0000-7000-8000-000000000888";
    const runtime = client({
      runConversation: vi.fn(async () => ({
        runtimeVersion: "2.1.169",
        answer: "",
        nativeSessionId,
        actualModel: "claude-sonnet-5",
        requestId: "request-unknown-136",
        fallbackOccurred: false,
        toolCalls: [],
        terminalStatus: "unknown" as const,
        cancellationRequested: true,
        cancellationConfirmed: false,
      })),
    });
    const adapter = new ClaudeCodeAdapter({ executable: "/fake/claude", client: runtime });

    await expect(adapter.converse({
      model: "claude-sonnet-5",
      prompt: "First turn",
    })).rejects.toMatchObject({
      name: "ClaudeCodeConversationError",
      nativeSessionId,
      unknownOutcome: true,
      evidence: {
        requestedModel: "claude-sonnet-5",
        actualModel: "claude-sonnet-5",
        sessionId: nativeSessionId,
        terminalStatus: "unknown",
        cancellationRequested: true,
        cancellationConfirmed: false,
      },
    });
  });
});
