import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { askRouter, buildAgentQuestionPrompt } from "../../src/routers/ask.js";
import {
  appendAgentSessionMessage,
  createAgentSession,
  getAgentSession,
  updateAgentSessionNativeSession,
} from "../../src/agentSessionStore.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import {
  CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
  CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
} from "../../src/conversationDataDisclosure.js";
import { CodexConversationError } from "../../src/codexAgentAdapter.js";
import { ClaudeCodeConversationError } from "../../src/claudeCodeAdapter.js";
import { GatewayRequestUnknownOutcomeError } from "../../src/cliProxyApiAdapter.js";

const runAgentCliCommand = vi.hoisted(() => vi.fn());
vi.mock("../../src/agentCliRunner.js", () => ({ runAgentCliCommand }));

const roots: string[] = [];

function context(
  config: Record<string, unknown>,
  injected: {
    localSearch?: ReturnType<typeof vi.fn>;
    xaiRequest?: ReturnType<typeof vi.fn>;
    conversationDisclosure?: boolean;
    codexDisclosure?: boolean;
    codexConverse?: ReturnType<typeof vi.fn>;
    claudeDisclosure?: boolean;
    claudeConverse?: ReturnType<typeof vi.fn>;
    gatewayDisclosure?: boolean;
    gatewayConverse?: ReturnType<typeof vi.fn>;
    uiMutationAuthorized?: boolean;
  } = {},
): AppContext {
  const root = mkdtempSync(join(tmpdir(), "yulu-ask-"));
  roots.push(root);
  const configDir = join(root, "config");
  const moviesDir = join(root, "movies");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(moviesDir, { recursive: true });
  return {
    uiMutationAuthorized: injected.uiMutationAuthorized ?? true,
    config: { read: () => config },
    host: {
      getAgentConnectionDisclosure: (connectionId: string) =>
        (connectionId === "codex"
          ? injected.codexDisclosure === false
          : connectionId === "claude-code"
            ? injected.claudeDisclosure === false
            : connectionId === "cliproxyapi"
              ? injected.gatewayDisclosure === false
            : injected.conversationDisclosure === false)
          ? null : ({
        connectionId,
        capability: "conversation",
        disclosureVersion: connectionId === "codex"
          ? CODEX_CONVERSATION_DISCLOSURE_VERSION
          : connectionId === "claude-code"
            ? CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION
            : connectionId === "cliproxyapi"
              ? CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION
            : XAI_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
        decidedAt: "2026-08-27T00:00:00.000Z",
      }),
    },
    paths: { configDir, moviesDir, scriptDir: "/fake/yulu/scripts" },
    ...(injected.localSearch ? { localSearch: injected.localSearch } : {}),
    ...(injected.xaiRequest ? { xaiText: { request: injected.xaiRequest } } : {}),
    ...(injected.codexConverse || injected.claudeConverse || injected.gatewayConverse ? {
      agentConnections: {
        ...(injected.codexConverse ? { converseCodex: injected.codexConverse } : {}),
        ...(injected.claudeConverse ? { converseClaude: injected.claudeConverse } : {}),
        ...(injected.gatewayConverse ? { converseGateway: injected.gatewayConverse } : {}),
      },
    } : {}),
  } as unknown as AppContext;
}

function session(ctx: AppContext, provider: string, model = "runtime-managed") {
  return createAgentSession(ctx.paths.configDir, {
    purpose: "ask",
    provider,
    model,
    ...(provider === "xai" ? { credentialSource: "oauth" as const } : {}),
    ...(provider === "codex" ? {
      connectionId: "codex",
      credentialSource: "runtime-oauth" as const,
    } : {}),
    ...(provider === "claude-code" ? {
      connectionId: "claude-code",
      credentialSource: "runtime-oauth" as const,
    } : {}),
    ...(provider === "cliproxyapi" ? {
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      disclosureVersion: CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
      credentialSource: "api-key" as const,
      credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
    } : {}),
    title: "Ask",
  });
}

function localHits() {
  return {
    hits: [{
      kind: "meeting_summary",
      stem: "Product_20260824_100000",
      meetingTitle: "Product Review",
      recordedAt: "2026-08-24T10:00:00",
      sourcePath: "/private/meetings/Product_20260824_100000.summary.md",
      score: 1,
      snippet: "[hit]Launch[/hit] decision",
    }],
    telemetry: { hitCount: 1 },
  };
}

afterEach(() => {
  runAgentCliCommand.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned Ask flow", () => {
  it("persists the first Codex thread and resumes only that thread after global selection changes", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const codexConverse = vi.fn()
      .mockResolvedValueOnce({
        answer: "First pinned answer",
        nativeSessionId: "019f0000-0000-7000-8000-000000000135",
        usedFallback: false,
        evidence: { requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol" },
      })
      .mockResolvedValueOnce({
        answer: "Resumed pinned answer",
        nativeSessionId: "019f0000-0000-7000-8000-000000000135",
        usedFallback: false,
        evidence: { requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol" },
      });
    const ctx = context(config, { codexConverse });
    const pinned = session(ctx, "codex", "gpt-5.6-sol");

    const first = await createCaller(askRouter, ctx).ask({ question: "first", sessionId: pinned.id });
    config.intelligence.conversation = { provider: "xai", model: "grok-future" } as never;
    const second = await createCaller(askRouter, ctx).ask({ question: "second", sessionId: pinned.id });

    expect(first).toMatchObject({ ok: true, answer: "First pinned answer", provider: "codex", model: "gpt-5.6-sol" });
    expect(second).toMatchObject({ ok: true, answer: "Resumed pinned answer", provider: "codex", model: "gpt-5.6-sol" });
    expect(codexConverse).toHaveBeenNthCalledWith(1, {
      connectionId: "codex",
      model: "gpt-5.6-sol",
      prompt: expect.stringContaining("first"),
    });
    expect(codexConverse).toHaveBeenNthCalledWith(2, {
      connectionId: "codex",
      model: "gpt-5.6-sol",
      prompt: expect.stringContaining("second"),
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({
      connectionId: "codex",
      model: "gpt-5.6-sol",
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
    });
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("persists the first Claude session and resumes only that session after later selection changes", async () => {
    const config = {
      intelligence: {
        conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const nativeSessionId = "019f0000-0000-7000-8000-000000000136";
    const claudeConverse = vi.fn()
      .mockResolvedValueOnce({
        answer: "First Claude answer",
        nativeSessionId,
        usedFallback: false,
        evidence: { requestedModel: "claude-sonnet-5", actualModel: "claude-sonnet-5", sessionId: nativeSessionId },
      })
      .mockResolvedValueOnce({
        answer: "Resumed Claude answer",
        nativeSessionId,
        usedFallback: false,
        evidence: { requestedModel: "claude-sonnet-5", actualModel: "claude-sonnet-5", sessionId: nativeSessionId },
      });
    const ctx = context(config, { claudeConverse });
    const pinned = session(ctx, "claude-code", "claude-sonnet-5");

    const first = await createCaller(askRouter, ctx).ask({ question: "first", sessionId: pinned.id });
    config.intelligence.conversation = { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } as never;
    const second = await createCaller(askRouter, ctx).ask({ question: "second", sessionId: pinned.id });

    expect(first).toMatchObject({ ok: true, answer: "First Claude answer", provider: "claude-code" });
    expect(second).toMatchObject({ ok: true, answer: "Resumed Claude answer", provider: "claude-code" });
    expect(claudeConverse).toHaveBeenNthCalledWith(1, {
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      prompt: expect.stringContaining("first"),
    });
    expect(claudeConverse).toHaveBeenNthCalledWith(2, {
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      prompt: expect.stringContaining("second"),
      nativeSessionId,
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({
      provider: "claude-code",
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      nativeSessionId,
      runtimeLabel: "Claude Code",
    });
    expect(runAgentCliCommand).not.toHaveBeenCalled();
    expect(ClaudeCodeConversationError).toBeTypeOf("function");
  });

  it("keeps Gateway Conversation on the pinned endpoint and model with bounded tool-free history", async () => {
    const config = {
      intelligence: {
        conversation: {
          provider: "agent",
          connectionId: "cliproxyapi",
          model: "gateway-conversation-exact",
        },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const gatewayConverse = vi.fn()
      .mockResolvedValueOnce({
        answer: "First Gateway answer",
        evidence: {
          adapter: "cliproxyapi",
          transport: "openai-responses-loopback-http",
          runtimeVersion: "cliproxyapi-v0.23.0-rc.1-openai-responses",
          endpoint: "http://127.0.0.1:8317/v1",
          requestedProvider: null,
          requestedModel: "gateway-conversation-exact",
          actualProvider: null,
          actualModel: "gateway-conversation-exact",
          requestId: "gateway-conversation-1",
          sessionId: null,
          terminalStatus: "ready",
          toolsEnabled: false,
          fallbackOccurred: false,
        },
      })
      .mockResolvedValueOnce({
        answer: "Second Gateway answer",
        evidence: {
          adapter: "cliproxyapi",
          transport: "openai-responses-loopback-http",
          runtimeVersion: "cliproxyapi-v0.23.0-rc.1-openai-responses",
          endpoint: "http://127.0.0.1:8317/v1",
          requestedProvider: null,
          requestedModel: "gateway-conversation-exact",
          actualProvider: null,
          actualModel: "gateway-conversation-exact",
          requestId: "gateway-conversation-2",
          sessionId: null,
          terminalStatus: "ready",
          toolsEnabled: false,
          fallbackOccurred: false,
        },
      });
    const localSearch = vi.fn(async () => localHits());
    const ctx = context(config, { gatewayConverse, localSearch });
    const pinned = session(ctx, "cliproxyapi", "gateway-conversation-exact");

    const first = await createCaller(askRouter, ctx).ask({ question: "first", sessionId: pinned.id });
    appendAgentSessionMessage(ctx.paths.configDir, pinned.id, { role: "user", text: "first" });
    appendAgentSessionMessage(ctx.paths.configDir, pinned.id, { role: "assistant", text: first.answer });
    config.intelligence.conversation = {
      provider: "agent",
      connectionId: "codex",
      model: "gpt-5.6-sol",
    } as never;
    const second = await createCaller(askRouter, ctx).ask({ question: "second", sessionId: pinned.id });

    expect(first).toMatchObject({
      ok: true,
      answer: "First Gateway answer",
      provider: "cliproxyapi",
      model: "gateway-conversation-exact",
      sources: [expect.objectContaining({ snippet: "Launch decision" })],
      runtimeEvidence: expect.objectContaining({ toolsEnabled: false, fallbackOccurred: false }),
    });
    expect(second).toMatchObject({ ok: true, answer: "Second Gateway answer" });
    expect(gatewayConverse).toHaveBeenNthCalledWith(1, {
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
      model: "gateway-conversation-exact",
      input: [
        expect.objectContaining({ role: "system", content: expect.stringContaining("Do not use tools") }),
        { role: "user", content: expect.stringContaining("Launch decision") },
      ],
    });
    expect(gatewayConverse).toHaveBeenNthCalledWith(2, {
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
      model: "gateway-conversation-exact",
      input: [
        expect.objectContaining({ role: "system", content: expect.stringContaining("Do not use tools") }),
        { role: "user", content: "first" },
        { role: "assistant", content: "First Gateway answer" },
        { role: "user", content: expect.stringContaining("Launch decision") },
      ],
    });
    expect(localSearch).toHaveBeenCalledTimes(2);
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("blocks Gateway Conversation retry when transport loss leaves no observable execution", async () => {
    const config = {
      intelligence: {
        conversation: {
          provider: "agent",
          connectionId: "cliproxyapi",
          model: "gateway-conversation-exact",
        },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const evidence = {
      adapter: "cliproxyapi",
      transport: "openai-responses-loopback-http",
      runtimeVersion: "cliproxyapi-v0.23.0-rc.1-openai-responses",
      endpoint: "http://127.0.0.1:8317/v1",
      requestedProvider: null,
      requestedModel: "gateway-conversation-exact",
      actualProvider: null,
      actualModel: null,
      requestId: null,
      sessionId: null,
      terminalStatus: "unknown" as const,
      fallbackOccurred: false,
      toolsEnabled: false as const,
    };
    const gatewayConverse = vi.fn().mockRejectedValue(new GatewayRequestUnknownOutcomeError(
      "CLIProxyAPI Gateway request outcome is unknown; do not retry this execution",
      evidence,
    ));
    const ctx = context(config, { gatewayConverse, localSearch: vi.fn(async () => localHits()) });
    const pinned = session(ctx, "cliproxyapi", "gateway-conversation-exact");

    const failed = await createCaller(askRouter, ctx).ask({ question: "uncertain input", sessionId: pinned.id });
    expect(failed).toMatchObject({
      ok: false,
      sessionStatus: "paused",
      runtimeEvidence: { terminalStatus: "unknown", endpoint: "http://127.0.0.1:8317/v1" },
      recovery: { retry: "unavailable_unknown_outcome", newConversation: true },
    });
    const paused = getAgentSession(ctx.paths.configDir, pinned.id);
    expect(paused).toMatchObject({ status: "paused" });
    expect(paused).not.toHaveProperty("retrySnapshot");
    await expect(createCaller(askRouter, ctx).ask({
      question: "uncertain input",
      sessionId: pinned.id,
      retry: true,
    })).resolves.toMatchObject({
      ok: false,
      recovery: { retry: "unavailable_unknown_outcome" },
    });
    expect(gatewayConverse).toHaveBeenCalledOnce();
  });

  it("blocks retry but does not project malformed Gateway Unknown Outcome evidence", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "cliproxyapi", model: "gateway-conversation-exact" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const malformedEvidence = {
      adapter: "cliproxyapi",
      transport: "openai-responses-approved-https",
      runtimeVersion: "malformed-contract",
      endpoint: "https://attacker.example/v1",
      requestedProvider: null,
      requestedModel: "other-model",
      actualProvider: null,
      actualModel: null,
      requestId: null,
      sessionId: null,
      terminalStatus: "unknown" as const,
      fallbackOccurred: false,
      toolsEnabled: false as const,
    };
    const gatewayConverse = vi.fn().mockRejectedValue(new GatewayRequestUnknownOutcomeError(
      "unknown with malformed evidence",
      malformedEvidence,
    ));
    const ctx = context(config, { gatewayConverse, localSearch: vi.fn(async () => localHits()) });
    const pinned = session(ctx, "cliproxyapi", "gateway-conversation-exact");

    const failed = await createCaller(askRouter, ctx).ask({ question: "uncertain malformed", sessionId: pinned.id });
    expect(failed).toMatchObject({
      ok: false,
      recovery: { retry: "unavailable_unknown_outcome" },
    });
    expect(failed).not.toHaveProperty("runtimeEvidence");
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).not.toHaveProperty("retrySnapshot");
    expect(JSON.stringify(failed)).not.toContain("attacker.example");
  });

  it("clears a prior durable Gateway retry snapshot when the retry enters Unknown Outcome", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "cliproxyapi", model: "gateway-conversation-exact" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const evidence = {
      adapter: "cliproxyapi",
      transport: "openai-responses-loopback-http",
      runtimeVersion: "cliproxyapi-v0.23.0-rc.1-openai-responses",
      endpoint: "http://127.0.0.1:8317/v1",
      requestedProvider: null,
      requestedModel: "gateway-conversation-exact",
      actualProvider: null,
      actualModel: null,
      requestId: null,
      sessionId: null,
      terminalStatus: "unknown" as const,
      fallbackOccurred: false,
      toolsEnabled: false as const,
    };
    const gatewayConverse = vi.fn()
      .mockRejectedValueOnce(new Error("known Gateway failure"))
      .mockRejectedValueOnce(new GatewayRequestUnknownOutcomeError("unknown Gateway outcome", evidence));
    const localSearch = vi.fn(async () => localHits());
    const ctx = context(config, { gatewayConverse, localSearch });
    const pinned = session(ctx, "cliproxyapi", "gateway-conversation-exact");

    await createCaller(askRouter, ctx).ask({ question: "retry snapshot", sessionId: pinned.id });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.retrySnapshot?.sources).toHaveLength(1);
    await createCaller(askRouter, ctx).ask({ question: "retry snapshot", sessionId: pinned.id, retry: true });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).not.toHaveProperty("retrySnapshot");
    await expect(createCaller(askRouter, ctx).ask({
      question: "retry snapshot",
      sessionId: pinned.id,
      retry: true,
    })).resolves.toMatchObject({ recovery: { retry: "unavailable_unknown_outcome" } });
    expect(gatewayConverse).toHaveBeenCalledTimes(2);
    expect(localSearch).toHaveBeenCalledOnce();
  });

  it("requires mutation bearer authorization before a Gateway invocation", async () => {
    const gatewayConverse = vi.fn();
    const ctx = context({}, { gatewayConverse, uiMutationAuthorized: false });
    const pinned = session(ctx, "cliproxyapi", "gateway-conversation-exact");

    await expect(createCaller(askRouter, ctx).ask({ question: "paid request", sessionId: pinned.id }))
      .rejects.toThrow("UI mutation bearer required");
    expect(gatewayConverse).not.toHaveBeenCalled();
  });

  it("pauses Codex with the same input snapshot and exact remediation without fallback", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const codexConverse = vi.fn()
      .mockRejectedValueOnce(new Error("Codex authorization expired; run /fake/codex login"))
      .mockResolvedValueOnce({
        answer: "Recovered pinned answer",
        nativeSessionId: "019f0000-0000-7000-8000-000000000135",
        usedFallback: false,
        evidence: { requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol" },
      });
    const ctx = context(config, { codexConverse });
    const pinned = session(ctx, "codex", "gpt-5.6-sol");

    const failed = await createCaller(askRouter, ctx).ask({ question: "same input", sessionId: pinned.id });
    const paused = getAgentSession(ctx.paths.configDir, pinned.id);
    config.intelligence.conversation = { provider: "xai", model: "grok-future" } as never;
    const retried = await createCaller(askRouter, ctx).ask({
      question: "same input",
      sessionId: pinned.id,
      retry: true,
    });

    expect(failed).toMatchObject({
      ok: false,
      provider: "codex",
      model: "gpt-5.6-sol",
      usedFallback: false,
      recovery: {
        retry: "same_snapshot",
        settingsPath: "/agent-connections?connection=codex&capability=conversation",
      },
    });
    expect(failed.llmError).toContain("run /fake/codex login");
    expect(paused).toMatchObject({
      status: "paused",
      provider: "codex",
      connectionId: "codex",
      model: "gpt-5.6-sol",
      retrySnapshot: { question: "same input", sources: [] },
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({ status: "active" });
    expect(retried).toMatchObject({ ok: true, answer: "Recovered pinned answer", sessionStatus: "active" });
    expect(codexConverse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      connectionId: "codex",
      model: "gpt-5.6-sol",
      prompt: expect.stringContaining("same input"),
    }));
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("pins a Codex thread created by an unknown first turn and retries only that thread", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const nativeSessionId = "019f0000-0000-7000-8000-000000000777";
    const codexConverse = vi.fn()
      .mockRejectedValueOnce(new CodexConversationError(
        "Codex conversation outcome is unknown; do not retry automatically",
        {
          nativeSessionId,
          unknownOutcome: true,
          evidence: {
            adapter: "codex",
            transport: "codex-app-server-stdio",
            runtimeVersion: "0.144.4",
            requestedProvider: "openai",
            requestedModel: "gpt-5.6-sol",
            actualProvider: "openai",
            actualModel: "gpt-5.6-sol",
            requestId: "turn-unknown-135",
            sessionId: nativeSessionId,
            terminalStatus: "unknown",
            fallbackOccurred: false,
            cancellationRequested: true,
            cancellationConfirmed: false,
          },
        },
      ))
      .mockResolvedValueOnce({
        answer: "Recovered the same thread",
        nativeSessionId,
        usedFallback: false,
        evidence: { requestedModel: "gpt-5.6-sol", actualModel: "gpt-5.6-sol" },
      });
    const ctx = context(config, { codexConverse });
    const pinned = session(ctx, "codex", "gpt-5.6-sol");

    const failed = await createCaller(askRouter, ctx).ask({ question: "same input", sessionId: pinned.id });
    expect(failed).toMatchObject({
      ok: false,
      sessionStatus: "paused",
      usedFallback: false,
      runtimeEvidence: {
        sessionId: nativeSessionId,
        terminalStatus: "unknown",
        cancellationRequested: true,
        cancellationConfirmed: false,
      },
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({
      status: "paused",
      nativeSessionId,
      retrySnapshot: { question: "same input", sources: [] },
    });

    await expect(createCaller(askRouter, ctx).ask({
      question: "same input",
      sessionId: pinned.id,
      retry: true,
    })).resolves.toMatchObject({ ok: true, answer: "Recovered the same thread" });
    expect(codexConverse).toHaveBeenNthCalledWith(2, expect.objectContaining({ nativeSessionId }));
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("pins a Claude session created by an unknown first turn and retries the same input only on that session", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const nativeSessionId = "019f0000-0000-7000-8000-000000000888";
    const evidence = {
      adapter: "claude-code" as const,
      transport: "claude-code-print-stream-json" as const,
      runtimeVersion: "2.1.169",
      requestedProvider: null,
      requestedModel: "claude-sonnet-5",
      actualProvider: null,
      actualModel: "claude-sonnet-5",
      requestId: "request-unknown-136",
      sessionId: nativeSessionId,
      terminalStatus: "unknown" as const,
      fallbackOccurred: false,
      cancellationRequested: true,
      cancellationConfirmed: false,
    };
    const claudeConverse = vi.fn()
      .mockRejectedValueOnce(new ClaudeCodeConversationError(
        "Claude Code Conversation outcome is unknown; inspect the pinned native session and do not retry automatically",
        { nativeSessionId, evidence, unknownOutcome: true },
      ))
      .mockResolvedValueOnce({
        answer: "Recovered the same Claude session",
        nativeSessionId,
        usedFallback: false,
        evidence: { ...evidence, terminalStatus: "ready" },
      });
    const ctx = context(config, { claudeConverse });
    const pinned = session(ctx, "claude-code", "claude-sonnet-5");

    const failed = await createCaller(askRouter, ctx).ask({ question: "same Claude input", sessionId: pinned.id });
    expect(failed).toMatchObject({
      ok: false,
      sessionStatus: "paused",
      usedFallback: false,
      runtimeEvidence: {
        sessionId: nativeSessionId,
        terminalStatus: "unknown",
        cancellationRequested: true,
        cancellationConfirmed: false,
      },
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({
      status: "paused",
      nativeSessionId,
      retrySnapshot: { question: "same Claude input", sources: [] },
    });

    await expect(createCaller(askRouter, ctx).ask({
      question: "same Claude input",
      sessionId: pinned.id,
      retry: true,
    })).resolves.toMatchObject({ ok: true, answer: "Recovered the same Claude session" });
    expect(claudeConverse).toHaveBeenNthCalledWith(2, expect.objectContaining({
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      nativeSessionId,
    }));
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("blocks retry when an unknown Claude outcome has no observable native session", async () => {
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const claudeConverse = vi.fn().mockRejectedValue(new ClaudeCodeConversationError(
      "Claude Code Conversation outcome is unknown; inspect the pinned native session and do not retry automatically",
      {
        unknownOutcome: true,
        evidence: {
          adapter: "claude-code",
          transport: "claude-code-print-stream-json",
          runtimeVersion: "2.1.169",
          requestedProvider: null,
          requestedModel: "claude-sonnet-5",
          actualProvider: null,
          actualModel: null,
          requestId: null,
          sessionId: null,
          terminalStatus: "unknown",
          fallbackOccurred: false,
          cancellationRequested: false,
          cancellationConfirmed: false,
        },
      },
    ));
    const ctx = context(config, { claudeConverse });
    const pinned = session(ctx, "claude-code", "claude-sonnet-5");

    const failed = await createCaller(askRouter, ctx).ask({ question: "unobservable session", sessionId: pinned.id });
    expect(failed).toMatchObject({
      ok: false,
      recovery: { retry: "unavailable_unknown_outcome", newConversation: true },
      runtimeEvidence: { terminalStatus: "unknown", sessionId: null },
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({ status: "paused" });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.retrySnapshot).toBeUndefined();

    await expect(createCaller(askRouter, ctx).ask({
      question: "unobservable session",
      sessionId: pinned.id,
      retry: true,
    })).resolves.toMatchObject({ ok: false, sessionStatus: "paused" });
    expect(claudeConverse).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing Agent-owned prompt for pinned Agent sessions", () => {
    const prompt = buildAgentQuestionPrompt("上次讨论了什么？", 6);
    expect(prompt).toContain("recording_search");
    expect(prompt).toContain("recording_get");
    expect(prompt).toContain("own read-only connectors");
    expect(prompt).toContain("上次讨论了什么？");
  });

  it("dispatches a pinned Agent session and persists its native session id", async () => {
    const ctx = context({
      intelligence: { conversation: { provider: "agent", model: "runtime-managed" } },
      llm: { enabled: true, command: ["hermes"] },
    });
    const pinned = session(ctx, "hermes");
    updateAgentSessionNativeSession(ctx.paths.configDir, pinned.id, { nativeSessionId: "old-native" });
    runAgentCliCommand.mockResolvedValue({
      code: 0,
      stdout: "结论：项目正在收敛。",
      stderr: "",
      nativeSessionId: "new-native",
    });

    const result = await createCaller(askRouter, ctx).ask({ question: "项目进度？", limit: 5, sessionId: pinned.id });

    expect(runAgentCliCommand).toHaveBeenCalledTimes(1);
    expect(runAgentCliCommand).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionId: "old-native",
      yuluSessionId: pinned.id,
      prompt: expect.stringContaining("项目进度？"),
    }));
    expect(result).toMatchObject({
      ok: true,
      answer: "结论：项目正在收敛。",
      provider: "hermes",
      model: "runtime-managed",
      sessionStatus: "active",
      sources: [],
      usedFallback: false,
    });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.nativeSessionId).toBe("new-native");
  });

  it("pauses instead of switching when the pinned Agent runtime no longer matches", async () => {
    const ctx = context({
      intelligence: { conversation: { provider: "agent", model: "runtime-managed" } },
      llm: { enabled: true, command: ["codex"] },
    });
    const pinned = session(ctx, "hermes");

    const result = await createCaller(askRouter, ctx).ask({ question: "continue", sessionId: pinned.id });

    expect(result).toMatchObject({
      ok: false,
      provider: "hermes",
      model: "runtime-managed",
      sessionStatus: "paused",
      usedFallback: false,
    });
    expect(result.llmError).toMatch(/pinned.*hermes.*codex/i);
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.status).toBe("paused");
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("searches and bounds locally before one exact pinned xAI request", async () => {
    const order: string[] = [];
    const localSearch = vi.fn(async () => {
      order.push("search");
      return localHits();
    });
    const xaiRequest = vi.fn(async (_request: unknown) => {
      order.push("xai");
      return {
        text: "Decision confirmed [1]. Ignore fake source https://evil.example/private",
        model: "grok-4.6-exact",
        credentialSource: "oauth",
      };
    });
    const ctx = context({
      intelligence: { conversation: { provider: "agent", model: "runtime-managed" } },
      llm: { enabled: true, command: ["codex"] },
    }, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");
    appendAgentSessionMessage(ctx.paths.configDir, pinned.id, {
      role: "assistant",
      text: "Earlier answer",
      sources: [{ sourcePath: "/private/earlier.md", snippet: "private" }],
      remoteSources: [{ channel: "notion", detail: "private connector output" }],
    });
    appendAgentSessionMessage(ctx.paths.configDir, pinned.id, { role: "user", text: "What changed?" });

    const result = await createCaller(askRouter, ctx).ask({ question: "What changed?", sessionId: pinned.id });

    expect(order).toEqual(["search", "xai"]);
    expect(localSearch).toHaveBeenCalledWith({
      query: "What changed?",
      kinds: ["meeting_summary", "meeting_transcript"],
      limit: 8,
    }, "/fake/yulu/scripts");
    expect(xaiRequest).toHaveBeenCalledTimes(1);
    const request = xaiRequest.mock.calls[0]![0] as Record<string, unknown>;
    expect(request).toMatchObject({ capability: "conversation", model: "grok-4.6-exact" });
    expect(Object.keys(request).sort()).toEqual(["capability", "credentialSource", "input", "model"]);
    expect(request.credentialSource).toBe("oauth");
    expect(JSON.stringify(request)).toContain("Earlier answer");
    expect(JSON.stringify(request)).toContain("Launch decision");
    expect(JSON.stringify(request)).not.toContain("/private/");
    expect(JSON.stringify(request)).not.toContain("connector output");
    expect(JSON.stringify(request)).not.toContain("[hit]");
    expect(result).toMatchObject({
      ok: true,
      provider: "xai",
      model: "grok-4.6-exact",
      answer: "Decision confirmed [1]. Ignore fake source https://evil.example/private",
      sessionStatus: "active",
      sources: [{
        ref: 1,
        title: "Product Review",
        sourcePath: "/private/meetings/Product_20260824_100000.summary.md",
        url: "/inbox/Product_20260824_100000",
        snippet: "Launch decision",
      }],
      remoteSources: [],
      usedFallback: false,
    });
    expect(result.sources).toHaveLength(1);
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("pauses before retrieval when the current xAI Conversation disclosure is missing", async () => {
    const localSearch = vi.fn();
    const xaiRequest = vi.fn();
    const ctx = context({}, { localSearch, xaiRequest, conversationDisclosure: false });
    const pinned = session(ctx, "xai", "grok-4.6-exact");

    await expect(createCaller(askRouter, ctx).ask({
      question: "What changed?",
      sessionId: pinned.id,
    })).resolves.toMatchObject({
      ok: false,
      sessionStatus: "paused",
      llmError: expect.stringContaining("conversation data path disclosure"),
      recovery: {
        settingsPath: "/agent-connections?connection=direct-xai&capability=conversation",
      },
    });
    expect(localSearch).not.toHaveBeenCalled();
    expect(xaiRequest).not.toHaveBeenCalled();
  });

  it("returns the local empty-evidence response without any xAI request", async () => {
    const localSearch = vi.fn(async () => ({ hits: [], telemetry: { hitCount: 0 } }));
    const xaiRequest = vi.fn();
    const ctx = context({}, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");

    const result = await createCaller(askRouter, ctx).ask({ question: "missing", sessionId: pinned.id });

    expect(result).toMatchObject({
      ok: false,
      answer: "未找到匹配的本地会议片段，本次未向 xAI 发送内容。",
      provider: "xai",
      model: "grok-4.6-exact",
      llmStatus: "empty",
      sessionStatus: "active",
      sources: [],
    });
    expect(localSearch).toHaveBeenCalledTimes(1);
    expect(xaiRequest).not.toHaveBeenCalled();
    expect(runAgentCliCommand).not.toHaveBeenCalled();
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.status).toBe("active");
  });

  it("pauses after a local retrieval failure without making a network request", async () => {
    const localSearch = vi.fn(async () => { throw new Error("local index unavailable"); });
    const xaiRequest = vi.fn();
    const ctx = context({}, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");

    const result = await createCaller(askRouter, ctx).ask({ question: "search failure", sessionId: pinned.id });
    const paused = await createCaller(askRouter, ctx).ask({ question: "do not retry", sessionId: pinned.id });

    expect(result).toMatchObject({
      ok: false,
      provider: "xai",
      model: "grok-4.6-exact",
      sessionStatus: "paused",
      sources: [],
      usedFallback: false,
    });
    expect(result.llmError).toContain("local index unavailable");
    expect(paused).toMatchObject({ sessionStatus: "paused", llmStatus: "paused" });
    expect(localSearch).toHaveBeenCalledTimes(1);
    expect(xaiRequest).not.toHaveBeenCalled();
    expect(runAgentCliCommand).not.toHaveBeenCalled();
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.status).toBe("paused");
  });

  it("pauses after one failed xAI attempt without provider or Agent fallback", async () => {
    const localSearch = vi.fn(async () => localHits());
    const xaiRequest = vi.fn(async () => { throw new Error("xAI conversation request failed (HTTP 403)"); });
    const ctx = context({}, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");

    const result = await createCaller(askRouter, ctx).ask({ question: "denied", sessionId: pinned.id });

    expect(result).toMatchObject({
      ok: false,
      provider: "xai",
      model: "grok-4.6-exact",
      llmStatus: "error",
      sessionStatus: "paused",
      usedFallback: false,
    });
    expect(result.llmError).toContain("xAI conversation request failed (HTTP 403)");
    expect(xaiRequest).toHaveBeenCalledTimes(1);
    expect(runAgentCliCommand).not.toHaveBeenCalled();
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      retrySnapshot: {
        question: "denied",
        sources: [{ snippet: "Launch decision" }],
      },
    });
    expect(result.sources).toMatchObject([{ snippet: "Launch decision" }]);
  });

  it("retries atomically with the persisted local evidence snapshot", async () => {
    const localSearch = vi.fn(async () => localHits());
    let pinnedId = "";
    const xaiRequest = vi.fn()
      .mockRejectedValueOnce(new Error("temporary xAI failure"))
      .mockImplementationOnce(async () => {
        expect(getAgentSession(ctx.paths.configDir, pinnedId)?.status).toBe("paused");
        return { text: "Recovered [1]", model: "grok-4.6-exact", credentialSource: "oauth" };
      });
    const ctx = context({}, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");
    pinnedId = pinned.id;

    const failed = await createCaller(askRouter, ctx).ask({ question: "retry me", sessionId: pinned.id });
    const retried = await createCaller(askRouter, ctx).ask({
      question: "retry me",
      sessionId: pinned.id,
      retry: true,
    });

    expect(failed).toMatchObject({ sessionStatus: "paused", sources: [{ snippet: "Launch decision" }] });
    expect(retried).toMatchObject({
      ok: true,
      answer: "Recovered [1]",
      sessionStatus: "active",
      sources: [{ snippet: "Launch decision" }],
    });
    expect(localSearch).toHaveBeenCalledTimes(1);
    expect(xaiRequest).toHaveBeenCalledTimes(2);
    expect(getAgentSession(ctx.paths.configDir, pinned.id)).toMatchObject({ status: "active" });
    expect(getAgentSession(ctx.paths.configDir, pinned.id)?.retrySnapshot).toBeUndefined();
  });

  it("pauses when xAI returns a different credential identity", async () => {
    const localSearch = vi.fn(async () => localHits());
    const xaiRequest = vi.fn(async () => ({
      text: "wrong credential",
      model: "grok-4.6-exact",
      credentialSource: "api-key",
    }));
    const ctx = context({}, { localSearch, xaiRequest });
    const pinned = session(ctx, "xai", "grok-4.6-exact");

    const result = await createCaller(askRouter, ctx).ask({ question: "identity", sessionId: pinned.id });

    expect(result).toMatchObject({ ok: false, sessionStatus: "paused", usedFallback: false });
    expect(result.llmError).toMatch(/credential.*oauth.*api-key/i);
    expect(xaiRequest).toHaveBeenCalledTimes(1);
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });
});
