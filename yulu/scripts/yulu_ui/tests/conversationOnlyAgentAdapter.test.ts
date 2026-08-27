import { describe, expect, it, vi } from "vitest";
import {
  ConversationOnlyAgentAdapter,
  ConversationOnlyAgentConversationError,
  type ConversationOnlyRuntimeClient,
} from "../src/conversationOnlyAgentAdapter.js";
import {
  ConversationOnlyCliRuntimeClient,
  type CliCommandRunner,
} from "../src/conversationOnlyCliClient.js";

function client(
  adapter: "hermes" | "openclaw",
  overrides: Partial<ConversationOnlyRuntimeClient> = {},
): ConversationOnlyRuntimeClient {
  return {
    inspect: vi.fn(async () => ({
      runtimeVersion: adapter === "hermes" ? "0.20.0" : "2026.5.12",
      authorized: true,
      provider: adapter === "hermes" ? "xai" : "openai-codex",
      model: adapter === "hermes" ? "grok-4.6" : "openai/gpt-5.5",
      features: adapter === "hermes"
        ? ["status", "model", "query", "resume", "session-id", "probe-bounds", "probe-tool-free", "no-fallback"]
        : ["models/status-json", "model", "message", "session-id", "json", "probe-bounds", "infer/model-run-tool-free", "no-fallback"],
    })),
    runConversation: vi.fn(async (input) => ({
      runtimeVersion: adapter === "hermes" ? "0.20.0" : "2026.5.12",
      answer: input.probe
        ? `YULU_${adapter === "hermes" ? "HERMES" : "OPENCLAW"}_PROBE_OK`
        : "Pinned answer",
      nativeSessionId: input.nativeSessionId ?? `${adapter}-native-session-138`,
      actualProvider: adapter === "hermes" ? "xai" : "openai-codex",
      actualModel: input.model,
      requestId: null,
      fallbackOccurred: false,
      terminalStatus: "completed" as const,
    })),
    ...overrides,
  };
}

describe.each(["hermes", "openclaw"] as const)("%s Conversation-only adapter", (kind) => {
  it("reports runtime-owned authorization without reading or projecting secrets", async () => {
    const runtime = client(kind, {
      inspect: vi.fn(async () => ({
        runtimeVersion: kind === "hermes" ? "0.20.0" : "2026.5.12",
        authorized: true,
        provider: kind === "hermes" ? "xai" : "openai-codex",
        model: kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5",
        features: kind === "hermes"
          ? ["status", "model", "query", "resume", "session-id", "probe-bounds", "probe-tool-free", "no-fallback"]
          : ["models/status-json", "model", "message", "session-id", "json", "probe-bounds", "infer/model-run-tool-free", "no-fallback"],
        accessToken: "must-not-leave-runtime",
        accountEmail: "private@example.test",
      })),
    });
    const adapter = new ConversationOnlyAgentAdapter({
      adapter: kind,
      executable: `/fake/${kind}`,
      client: runtime,
    });

    const status = await adapter.status();
    expect(status).toMatchObject({
      adapter: kind,
      supported: true,
      authorized: true,
      credentialSource: "runtime-oauth",
    });
    expect(JSON.stringify(status)).not.toContain("must-not-leave-runtime");
    expect(JSON.stringify(status)).not.toContain("private@example.test");
  });

  it("runs one bounded Conversation probe and returns secret-safe native-session evidence", async () => {
    const runtime = client(kind);
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";

    await expect(adapter.probe({ model })).resolves.toMatchObject({
      status: "ready",
      evidence: {
        adapter: kind,
        requestedModel: model,
        actualModel: model,
        sessionId: `${kind}-native-session-138`,
        terminalStatus: "ready",
        fallbackOccurred: false,
      },
    });
    expect(runtime.runConversation).toHaveBeenCalledWith({
      model,
      prompt: `Reply with exactly YULU_${kind === "hermes" ? "HERMES" : "OPENCLAW"}_PROBE_OK.`,
      probe: true,
      timeoutMs: 30_000,
    });
  });

  it("creates and resumes only the exact native session", async () => {
    const runtime = client(kind);
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";

    const provider = kind === "hermes" ? "xai" : "openai-codex";
    const first = await adapter.converse({ provider, model, prompt: "First" });
    await expect(adapter.converse({
      provider,
      model,
      prompt: "Second",
      nativeSessionId: first.nativeSessionId,
    })).resolves.toMatchObject({ nativeSessionId: first.nativeSessionId, usedFallback: false });
    expect(runtime.runConversation).toHaveBeenLastCalledWith({
      model,
      prompt: "Second",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: first.nativeSessionId,
    });
  });

  it("fails closed when status, model, terminal result, or resumed session is not proven", async () => {
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";
    const runtime = client(kind, {
      runConversation: vi.fn(async () => ({
        runtimeVersion: kind === "hermes" ? "0.20.0" : "2026.5.12",
        answer: "must be rejected",
        nativeSessionId: "different-session",
        actualProvider: null,
        actualModel: null,
        requestId: null,
        fallbackOccurred: null,
        terminalStatus: "completed" as const,
      })),
    });
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });

    await expect(adapter.converse({
      provider: kind === "hermes" ? "xai" : "openai-codex",
      model,
      prompt: "Continue",
      nativeSessionId: "pinned-session",
    })).rejects.toMatchObject({
      name: "ConversationOnlyAgentConversationError",
      unknownOutcome: false,
    });
  });

  it("rejects a same-model result from a different provider", async () => {
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";
    const runtime = client(kind, {
      runConversation: vi.fn(async () => ({
        runtimeVersion: kind === "hermes" ? "0.20.0" : "2026.5.12",
        answer: "same model, wrong provider",
        nativeSessionId: `${kind}-other-provider-138`,
        actualProvider: "other-provider",
        actualModel: model,
        requestId: null,
        fallbackOccurred: false,
        terminalStatus: "completed" as const,
      })),
    });
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });

    await expect(adapter.converse({
      provider: kind === "hermes" ? "xai" : "openai-codex",
      model,
      prompt: "Continue",
    })).rejects.toMatchObject({
      name: "ConversationOnlyAgentConversationError",
      unknownOutcome: false,
    });
  });

  it("preserves Unknown Outcome without enabling an automatic retry", async () => {
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";
    const runtime = client(kind, {
      runConversation: vi.fn(async () => ({
        runtimeVersion: kind === "hermes" ? "0.20.0" : "2026.5.12",
        answer: "",
        nativeSessionId: `${kind}-unknown-138`,
        actualProvider: null,
        actualModel: model,
        requestId: null,
        fallbackOccurred: null,
        terminalStatus: "unknown" as const,
        cancellationRequested: true,
        cancellationConfirmed: false,
      })),
    });
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });

    await expect(adapter.converse({
      provider: kind === "hermes" ? "xai" : "openai-codex",
      model,
      prompt: "First",
    })).rejects.toMatchObject({
      name: "ConversationOnlyAgentConversationError",
      nativeSessionId: `${kind}-unknown-138`,
      unknownOutcome: true,
      evidence: { terminalStatus: "unknown", cancellationRequested: true, cancellationConfirmed: false },
    });
    expect(ConversationOnlyAgentConversationError).toBeTypeOf("function");
  });

  it("rejects provider drift before invoking a paid Conversation", async () => {
    const runtime = client(kind);
    const adapter = new ConversationOnlyAgentAdapter({ adapter: kind, executable: `/fake/${kind}`, client: runtime });
    const model = kind === "hermes" ? "grok-4.6" : "openai/gpt-5.5";

    await expect(adapter.converse({ provider: "different-provider", model, prompt: "Continue" }))
      .rejects.toThrow(/provider.*changed/i);
    expect(runtime.runConversation).not.toHaveBeenCalled();
  });
});

describe("Hermes production client-to-adapter contract", () => {
  it("fails closed when the real Hermes CLI surface cannot prove a tool-free probe", async () => {
    const outputs = [
      "Hermes Agent v0.20.0 (2026.8.3)\n",
      "--model MODEL --query QUERY --resume SESSION_ID --quiet --safe-mode --toolsets SETS\n",
      "Model: grok-4.6\nProvider: xAI Grok OAuth (SuperGrok / Premium+)\n",
      "No fallback models configured.\n",
    ];
    const run: CliCommandRunner = vi.fn(async () => ({
      stdout: outputs.shift() ?? "",
      stderr: "",
      code: 0,
      timedOut: false,
      cancellationRequested: false,
      cancellationConfirmed: null,
    }));
    const runtime = new ConversationOnlyCliRuntimeClient({
      adapter: "hermes",
      executable: "/fake/hermes",
      cwd: "/movies",
      run,
    });
    const adapter = new ConversationOnlyAgentAdapter({
      adapter: "hermes",
      executable: "/fake/hermes",
      client: runtime,
    });

    await expect(adapter.status()).resolves.toMatchObject({
      supported: false,
      authorized: true,
      remediation: expect.stringMatching(/tool-free/i),
    });
    await expect(adapter.probe({ model: "grok-4.6" })).resolves.toMatchObject({
      status: "failed",
      reason: "unsupported_runtime",
      remediation: expect.stringMatching(/tool-free/i),
    });
    expect(run).toHaveBeenCalledTimes(8);
    expect(run).not.toHaveBeenCalledWith(expect.arrayContaining(["--query"]), expect.anything(), expect.anything());
  });
});
