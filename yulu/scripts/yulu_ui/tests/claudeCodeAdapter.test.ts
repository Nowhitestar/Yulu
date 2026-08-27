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
  "probe-bounds",
  "tools/none",
  "probe-isolation",
  "fallback-model/opt-in",
];

function client(overrides: Partial<ClaudeCodeRuntimeClient> = {}): ClaudeCodeRuntimeClient {
  return {
    inspect: vi.fn(async () => ({
      runtimeVersion: "2.1.169",
      authorized: true,
      authorizationMethod: "claude.ai",
      apiProvider: "firstParty",
      features: [...SUPPORTED_FEATURES],
    })),
    runConversation: vi.fn(async (input) => ({
      answer: input.probe ? "YULU_CLAUDE_PROBE_OK" : "Pinned answer",
      nativeSessionId: input.nativeSessionId ?? "019f0000-0000-7000-8000-000000000136",
      actualModel: input.model,
      requestId: "request-136",
      fallbackOccurred: false,
      toolCalls: [],
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

  it.each(["verbose", "probe-bounds", "probe-isolation", "fallback-model/opt-in"])(
    "fails closed when the runtime does not prove required feature %s",
    async (missingFeature) => {
      const runConversation = vi.fn();
      const runtime = client({
        inspect: vi.fn(async () => ({
          runtimeVersion: "2.1.169",
          authorized: true,
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
