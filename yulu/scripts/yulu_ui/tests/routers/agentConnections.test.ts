import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../../src/config.js";
import { HostStore } from "../../src/hostStore.js";
import { AgentConnectionCenter } from "../../src/agentConnections.js";
import { agentConnectionsRouter } from "../../src/routers/agentConnections.js";
import { createCaller } from "../../src/trpc.js";
import { createAgentSession, readAgentSessionStore } from "../../src/agentSessionStore.js";
import { XaiTextUnknownOutcomeError } from "../../src/xaiText.js";
import { CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION } from "../../src/conversationDataDisclosure.js";
import {
  ConversationOnlyAgentAdapter,
  type ConversationOnlyAgentKind,
  type ConversationOnlyProbeResult,
  type ConversationOnlyRuntimeClient,
} from "../../src/conversationOnlyAgentAdapter.js";
import {
  ConversationOnlyCliRuntimeClient,
  type CliCommandRunner,
} from "../../src/conversationOnlyCliClient.js";
import type { NativeAgentAuthorizationTarget } from "../../src/nativeAgentAuthorization.js";

const roots: string[] = [];

function setup(
  config: Record<string, unknown>,
  discovered: Array<{ adapter: "codex" | "claude-code" | "hermes" | "openclaw"; label: string; path: string }> = [],
  options: {
    seedDirectCredentialSource?: "oauth" | "api-key" | false;
    conversationOnlyClient?: ConversationOnlyRuntimeClient;
    nativeAuthorization?: (input: NativeAgentAuthorizationTarget) => Promise<unknown>;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "yulu-agent-connections-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const host = new HostStore(join(root, "host.sqlite"));
  const credentials = {
    status: vi.fn(async () => ({
      connected: true,
      source: "oauth" as "oauth" | "api-key" | null,
      oauthConnected: true,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "xAI OAuth connected",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    })),
    authorize: vi.fn(),
    cancelAuthorization: vi.fn(),
    logout: vi.fn(),
    setApiKey: vi.fn(),
    clearApiKey: vi.fn(),
    setPreferredSource: vi.fn(),
  };
  const audio = { testXai: vi.fn() };
  const text = { request: vi.fn() };
  const discover = vi.fn(() => discovered);
  const nativeAuthorization = vi.fn(
    options.nativeAuthorization ?? (async (_input: NativeAgentAuthorizationTarget) => ({ launched: true as const })),
  );
  const codex = {
    status: vi.fn(async () => ({
      adapter: "codex" as const,
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      minimumVersion: "0.144.0",
      supported: true,
      authorized: true,
      authorizationClass: "chatgpt" as const,
      availableModels: ["gpt-5.6-sol"],
      features: [
        "account/read" as const,
        "model/list" as const,
        "thread/start" as const,
        "thread/resume" as const,
        "turn/start" as const,
        "turn/interrupt" as const,
        "experimentalFeature/list" as const,
        "mcpServerStatus/list" as const,
        "app/list" as const,
        "no-provider-model-fallback" as const,
      ],
      login: { command: "/fake/bin/codex login", statusCommand: "/fake/bin/codex login status" },
      remediation: null,
    })),
    probe: vi.fn(async ({ model }: { model: string }) => ({
      status: "ready" as const,
      reason: null,
      remediation: null,
      evidence: {
        adapter: "codex" as const,
        transport: "codex-app-server-stdio" as const,
        runtimeVersion: "0.144.4",
        authorizationClass: "chatgpt" as const,
        requestedProvider: "openai" as const,
        requestedModel: model,
        actualProvider: "openai",
        actualModel: model,
        requestId: "turn-135",
        sessionId: "thread-probe-135",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    probeSummary: vi.fn(async ({ model }: { model: string }) => ({
      status: "ready" as const,
      reason: null,
      remediation: null,
      evidence: {
        adapter: "codex" as const,
        transport: "codex-app-server-stdio" as const,
        runtimeVersion: "0.144.4",
        authorizationClass: "chatgpt" as const,
        requestedProvider: "openai" as const,
        requestedModel: model,
        actualProvider: "openai",
        actualModel: model,
        requestId: "turn-139",
        sessionId: "thread-probe-139",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    summarize: vi.fn(async ({ model }: { model: string }) => ({
      summary: "# Summary\n\nOnly committed input.",
      nativeSessionId: "thread-summary-139",
      evidence: {
        adapter: "codex" as const,
        transport: "codex-app-server-stdio" as const,
        runtimeVersion: "0.144.4",
        authorizationClass: "chatgpt" as const,
        requestedProvider: "openai" as const,
        requestedModel: model,
        actualProvider: "openai",
        actualModel: model,
        requestId: "turn-summary-139",
        sessionId: "thread-summary-139",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    converse: vi.fn(),
  };
  const codexAdapter = vi.fn(() => codex);
  const claude = {
    status: vi.fn(async () => ({
      adapter: "claude-code" as const,
      transport: "claude-code-print-stream-json",
      runtimeVersion: "2.1.169",
      minimumVersion: "2.1.169",
      supported: true,
      authorized: true,
      authorizationClass: "claude-subscription" as const,
      authorizationMethod: "claude.ai",
      apiProvider: "firstParty",
      availableModels: [],
      features: [
        "auth/status" as const,
        "safe-mode" as const,
        "print/stream-json" as const,
        "verbose" as const,
        "model" as const,
        "session-id" as const,
        "resume" as const,
        "probe-single-result" as const,
        "tools/none" as const,
        "probe-isolation" as const,
        "fallback-model/opt-in" as const,
        "managed-hooks/none" as const,
        "provider-identity" as const,
      ],
      login: { command: "/fake/bin/claude auth login", statusCommand: "/fake/bin/claude auth status" },
      remediation: null,
    })),
    probe: vi.fn(async ({ model }: { model: string }) => ({
      status: "ready" as const,
      reason: null,
      remediation: null,
      evidence: {
        adapter: "claude-code" as const,
        transport: "claude-code-print-stream-json" as const,
        runtimeVersion: "2.1.169",
        authorizationClass: "claude-subscription" as const,
        requestedProvider: null,
        requestedModel: model,
        actualProvider: null,
        actualModel: model,
        requestId: "request-136",
        sessionId: "019f0000-0000-7000-8000-000000000136",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    probeSummary: vi.fn(async ({ model }: { model: string }) => ({
      status: "ready" as const,
      reason: null,
      remediation: null,
      evidence: {
        adapter: "claude-code" as const,
        transport: "claude-code-print-stream-json" as const,
        runtimeVersion: "2.1.169",
        authorizationClass: "claude-subscription" as const,
        requestedProvider: "firstParty",
        requestedModel: model,
        actualProvider: "firstParty",
        actualModel: model,
        requestId: "request-probe-140",
        sessionId: "019f0000-0000-7000-8000-000000000140",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    summarize: vi.fn(async ({ model }: { model: string }) => ({
      summary: "# Claude Summary\n\nOnly committed input.",
      nativeSessionId: "019f0000-0000-7000-8000-000000000141",
      evidence: {
        adapter: "claude-code" as const,
        transport: "claude-code-print-stream-json" as const,
        runtimeVersion: "2.1.169",
        authorizationClass: "claude-subscription" as const,
        requestedProvider: "firstParty",
        requestedModel: model,
        actualProvider: "firstParty",
        actualModel: model,
        requestId: "request-summary-140",
        sessionId: "019f0000-0000-7000-8000-000000000141",
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    converse: vi.fn(),
  };
  const claudeAdapter = vi.fn(() => claude);
  const conversationOnly = {
    status: vi.fn(async (adapter: ConversationOnlyAgentKind) => ({
      adapter,
      transport: adapter === "hermes" ? "hermes-cli-chat" as const : "openclaw-cli-gateway-json" as const,
      runtimeVersion: adapter === "hermes" ? "0.20.0" : "2026.5.12",
      minimumVersion: adapter === "hermes" ? "0.20.0" as const : "2026.5.12" as const,
      supported: true,
      authorized: true,
      credentialSource: "runtime-oauth" as const,
      provider: adapter === "hermes" ? "xai" : "openai-codex",
      model: adapter === "hermes" ? "grok-4.6" : "openai-codex/gpt-5.5",
      availableModels: [],
      features: adapter === "hermes"
        ? ["status" as const, "model" as const, "query" as const, "resume" as const, "session-id" as const, "probe-bounds" as const, "no-fallback" as const]
        : ["models/status-json" as const, "model" as const, "message" as const, "session-id" as const, "json" as const, "probe-bounds" as const, "no-fallback" as const],
      login: {
        command: adapter === "hermes" ? "/fake/bin/hermes model" : "/fake/bin/openclaw configure",
        statusCommand: adapter === "hermes" ? "/fake/bin/hermes status" : "/fake/bin/openclaw models status --json --check",
      },
      remediation: null,
    })),
    probe: vi.fn(async (adapter: ConversationOnlyAgentKind, model: string): Promise<ConversationOnlyProbeResult> => ({
      status: "ready" as const,
      reason: null,
      remediation: null,
      evidence: {
        adapter,
        transport: adapter === "hermes" ? "hermes-cli-chat" as const : "openclaw-cli-gateway-json" as const,
        runtimeVersion: adapter === "hermes" ? "0.20.0" : "2026.5.12",
        requestedProvider: adapter === "hermes" ? "xai" : "openai-codex",
        requestedModel: model,
        actualProvider: adapter === "hermes" ? "xai" : "openai-codex",
        actualModel: model,
        requestId: null,
        sessionId: `${adapter}-probe-138`,
        terminalStatus: "ready" as const,
        fallbackOccurred: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      },
    })),
    converse: vi.fn(),
  };
  const conversationOnlyAdapter = vi.fn((adapter: ConversationOnlyAgentKind, executable: string) =>
    options.conversationOnlyClient
      ? new ConversationOnlyAgentAdapter({ adapter, executable, client: options.conversationOnlyClient })
      : {
          status: () => conversationOnly.status(adapter),
          probe: ({ model }: { model: string }) => conversationOnly.probe(adapter, model),
          converse: conversationOnly.converse,
        }
  );
  const center = new AgentConnectionCenter({
    config: new ConfigManager(configPath),
    host,
    configDir: root,
    credentials,
    audio,
    text,
    discover,
    codexAdapter,
    claudeAdapter,
    conversationOnlyAdapter,
    nativeAuthorization,
  });
  if (options.seedDirectCredentialSource !== false) {
    host.upsertAgentConnectionRecord({
      id: "direct-xai",
      kind: "direct-provider",
      adapter: "direct-xai",
      label: "xAI",
      lifecycle: "available",
      settings: { credentialSource: options.seedDirectCredentialSource ?? "oauth" },
    });
  }
  return {
    center,
    host,
    credentials,
    audio,
    text,
    codex,
    codexAdapter,
    claude,
    claudeAdapter,
    conversationOnly,
    conversationOnlyAdapter,
    configPath,
    root,
    configManager: new ConfigManager(configPath),
    makeCenter: () => new AgentConnectionCenter({
      config: new ConfigManager(configPath),
      host,
      configDir: root,
      credentials,
      audio,
      text,
      discover,
      codexAdapter,
      claudeAdapter,
      conversationOnlyAdapter,
      nativeAuthorization,
    }),
    discover,
    nativeAuthorization,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public Agent Connection Host contract", () => {
  it("projects a crash-recovered fence without readiness history as a public Conversation Unknown Outcome", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.beginAgentConnectionProbe({
      connectionId: "direct-xai",
      adapter: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    });
    setupResult.host.close();

    const restartedHost = new HostStore(join(setupResult.root, "host.sqlite"));
    const restartedCenter = new AgentConnectionCenter({
      config: new ConfigManager(setupResult.configPath),
      host: restartedHost,
      configDir: setupResult.root,
      credentials: setupResult.credentials,
      audio: setupResult.audio,
      text: setupResult.text,
      discover: setupResult.discover,
      codexAdapter: setupResult.codexAdapter,
      claudeAdapter: setupResult.claudeAdapter,
      conversationOnlyAdapter: setupResult.conversationOnlyAdapter,
      nativeAuthorization: setupResult.nativeAuthorization,
    });

    const view = await restartedCenter.view();
    expect(restartedHost.listAgentConnectionReadinessHistory("direct-xai", "conversation"))
      .toEqual([]);
    expect(view.connections.find(({ id }) => id === "direct-xai")?.capabilities
      .find(({ capability }) => capability === "conversation")?.currentReadiness)
      .toMatchObject({
        status: "failed",
        reason: "unknown_outcome",
        model: "grok-conversation-exact",
        testedAt: expect.any(String),
      });
    restartedHost.close();
  });

  it("returns durable exact Conversation adoption evidence without changing Summary authority", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockResolvedValue({
      credentialSource: "oauth",
      model: "grok-conversation-exact",
    });

    await setupResult.center.probe({ connectionId: "direct-xai", capability: "conversation" });
    await expect(setupResult.center.conversationAdoptionEvidence()).resolves.toMatchObject({
      kind: "agent-capability-probe",
      connectionId: "direct-xai",
      adapter: "direct-xai",
      provider: "xai",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
      testedAt: expect.any(String),
      reference: expect.any(String),
      runtimeEvidence: {
        transport: "xai-http",
        requestedProvider: "xai",
        requestedModel: "grok-conversation-exact",
        actualProvider: "xai",
        actualModel: "grok-conversation-exact",
        terminalStatus: "ready",
        fallbackOccurred: false,
      },
    });
    expect(setupResult.configManager.read().intelligence.summary).toEqual({
      provider: "xai",
      model: "grok-summary-exact",
    });
    setupResult.host.close();
  });

  it("rejects adoption while the exact Conversation identity has an unresolved fence", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockResolvedValue({
      credentialSource: "oauth",
      model: "grok-conversation-exact",
    });
    await setupResult.center.probe({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.host.recordAgentConnectionUnknownOutcomeFence({
      connectionId: "direct-xai",
      adapter: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    });

    await expect(setupResult.center.conversationAdoptionEvidence())
      .rejects.toThrow(/unresolved Unknown Outcome/i);
    setupResult.host.close();
  });

  it.each([
    ["codex", "Codex", "gpt-5.6-sol", "chatgpt"],
    ["claude-code", "Claude Code", "claude-sonnet-5", "claude-subscription"],
    ["hermes", "Hermes", "grok-4.6", undefined],
    ["openclaw", "OpenClaw", "openai-codex/gpt-5.5", undefined],
  ] as const)("adopts exact %s Conversation proof without depending on another Agent", async (
    adapter,
    label,
    model,
    authorizationClass,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "agent", connectionId: adapter, model },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path: `/fake/bin/${adapter}` }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: `candidate:${adapter}`, model });
    await caller.acceptDisclosure({ connectionId: adapter, capability: "conversation" });
    await caller.probe({ connectionId: adapter, capability: "conversation", model });

    await expect(setupResult.center.conversationAdoptionEvidence()).resolves.toMatchObject({
      connectionId: adapter,
      adapter,
      provider: adapter,
      model,
      credentialSource: null,
      runtimeEvidence: {
        adapter,
        requestedModel: model,
        actualModel: model,
        terminalStatus: "ready",
        fallbackOccurred: false,
        ...(authorizationClass ? { authorizationClass } : {}),
      },
    });
    expect(setupResult.configManager.read().intelligence.summary).toEqual({
      provider: "xai",
      model: "grok-summary-exact",
    });
    setupResult.host.close();
  });

  it("fences a Conversation probe Unknown Outcome until an explicit new attempt", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockRejectedValueOnce(new XaiTextUnknownOutcomeError({
      capability: "conversation",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
    }));
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await expect(caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).rejects.toThrow(/does not have an Unknown Outcome/i);
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .resolves.toMatchObject({ status: "failed", reason: "unknown_outcome" });
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .rejects.toThrow(/Unknown Outcome.*explicit new attempt/i);
    expect(setupResult.text.request).toHaveBeenCalledTimes(1);

    setupResult.text.request.mockResolvedValueOnce({
      credentialSource: "oauth",
      model: "grok-conversation-exact",
    });
    await expect(caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).resolves.toMatchObject({ status: "ready", model: "grok-conversation-exact" });
    expect(setupResult.text.request).toHaveBeenCalledTimes(2);
    setupResult.host.close();
  });

  it("fails closed when persisting an xAI Conversation Unknown Outcome fails after dispatch", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockRejectedValueOnce(new XaiTextUnknownOutcomeError({
      capability: "conversation",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
    }));
    vi.spyOn(setupResult.host, "recordAgentConnectionReadiness")
      .mockImplementationOnce(() => { throw new Error("simulated durable-write failure"); });

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "conversation",
    })).rejects.toThrow("simulated durable-write failure");
    expect(setupResult.host.getAgentConnectionUnknownOutcomeFence({
      connectionId: "direct-xai",
      adapter: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    })).toMatchObject({ state: "unknown" });
    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "conversation",
    })).rejects.toThrow(/Unknown Outcome.*explicit new attempt/i);
    expect(setupResult.text.request).toHaveBeenCalledTimes(1);
    setupResult.host.close();
  });

  it("fails closed when a Codex post-dispatch status check cannot classify an Unknown Outcome", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    await caller.acceptDisclosure({ connectionId: "codex", capability: "conversation" });
    setupResult.codex.probe.mockResolvedValueOnce({
      status: "failed",
      reason: "unknown_outcome",
      remediation: "Codex probe outcome is unknown",
    } as never);
    setupResult.codex.status.mockRejectedValueOnce(new Error("post-dispatch status unavailable"));

    await expect(caller.probe({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    })).rejects.toThrow("post-dispatch status unavailable");
    expect(setupResult.host.getAgentConnectionUnknownOutcomeFence({
      connectionId: "codex",
      adapter: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    })).toMatchObject({ state: "unknown" });
    await expect(caller.probe({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    })).rejects.toThrow(/Unknown Outcome.*explicit new attempt/i);
    expect(setupResult.codex.probe).toHaveBeenCalledTimes(1);
    setupResult.host.close();
  });

  it.each([
    ["codex", "Codex", "gpt-5.6-sol"],
    ["claude-code", "Claude Code", "claude-sonnet-5"],
    ["hermes", "Hermes", "grok-4.6"],
    ["openclaw", "OpenClaw", "openai-codex/gpt-5.5"],
  ] as const)("durably fences a no-evidence %s Conversation Unknown Outcome across restart", async (
    adapter,
    label,
    model,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "agent", connectionId: adapter, model },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path: `/fake/bin/${adapter}` }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: `candidate:${adapter}`, model });
    await caller.acceptDisclosure({ connectionId: adapter, capability: "conversation" });
    const adapterProbe = adapter === "codex"
      ? setupResult.codex.probe
      : adapter === "claude-code"
        ? setupResult.claude.probe
        : setupResult.conversationOnly.probe;
    adapterProbe.mockResolvedValueOnce({
      status: "failed",
      reason: "unknown_outcome",
      remediation: `${label} transport outcome is unknown`,
    } as never);

    await expect(caller.probe({ connectionId: adapter, capability: "conversation", model }))
      .resolves.toMatchObject({ status: "failed", reason: "unknown_outcome" });
    expect(setupResult.host.listAgentConnectionReadinessHistory(adapter, "conversation")[0])
      .toMatchObject({ reason: "unknown_outcome", runtimeEvidence: { terminalStatus: "unknown" } });
    await expect(caller.probe({ connectionId: adapter, capability: "conversation", model }))
      .rejects.toThrow(/Unknown Outcome.*explicit new attempt/i);

    const restarted = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.makeCenter(),
      uiMutationAuthorized: true,
    } as never);
    await expect(restarted.probe({ connectionId: adapter, capability: "conversation", model }))
      .rejects.toThrow(/Unknown Outcome.*explicit new attempt/i);
    expect(adapterProbe).toHaveBeenCalledTimes(1);
    setupResult.host.close();
  });

  it("preserves a Conversation Unknown fence across deletion without applying it to a new model", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockRejectedValueOnce(new XaiTextUnknownOutcomeError({
      capability: "conversation",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
    }));
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.probe({ connectionId: "direct-xai", capability: "conversation" });
    await caller.remove({ connectionId: "direct-xai", confirmed: true });
    await caller.restoreDirectXai();
    await caller.select({
      connectionId: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-new",
    });
    await caller.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockResolvedValueOnce({
      credentialSource: "oauth",
      model: "grok-conversation-new",
    });
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .resolves.toMatchObject({ status: "ready", model: "grok-conversation-new" });

    await caller.select({
      connectionId: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    });
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .rejects.toThrow(/Unknown Outcome.*new attempt/i);
    expect(setupResult.text.request).toHaveBeenCalledTimes(2);
    setupResult.host.close();
  });

  it("atomically permits only one explicit new Conversation probe attempt", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request.mockRejectedValueOnce(new XaiTextUnknownOutcomeError({
      capability: "conversation",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
    }));
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.probe({ connectionId: "direct-xai", capability: "conversation" });

    let finish!: (value: { credentialSource: "oauth"; model: string }) => void;
    setupResult.text.request.mockImplementationOnce(() => new Promise((resolve) => {
      finish = resolve;
    }));
    const first = caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    });
    await vi.waitFor(() => expect(setupResult.text.request).toHaveBeenCalledTimes(2));
    await expect(caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).rejects.toThrow(/explicit Conversation probe attempt is already in progress/i);
    expect(setupResult.text.request).toHaveBeenCalledTimes(2);
    finish({ credentialSource: "oauth", model: "grok-conversation-exact" });
    await expect(first).resolves.toMatchObject({ status: "ready" });
    setupResult.text.request.mockResolvedValueOnce({
      credentialSource: "oauth",
      model: "grok-conversation-exact",
    });
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .resolves.toMatchObject({ status: "ready" });
    expect(setupResult.text.request).toHaveBeenCalledTimes(3);
    setupResult.host.close();
  });

  it("permits only one initial Conversation probe and does not let stale Unknown overwrite an explicit attempt", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    let rejectInitial!: (error: Error) => void;
    setupResult.text.request.mockImplementationOnce(() => new Promise((_resolve, reject) => {
      rejectInitial = reject;
    }));
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    const first = caller.probe({ connectionId: "direct-xai", capability: "conversation" });
    await vi.waitFor(() => expect(setupResult.text.request).toHaveBeenCalledTimes(1));
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .rejects.toThrow(/Conversation probe.*already in progress/i);
    rejectInitial(new XaiTextUnknownOutcomeError({
      capability: "conversation",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
    }));
    await expect(first).resolves.toMatchObject({ reason: "unknown_outcome" });

    let finishExplicit!: (value: { credentialSource: "oauth"; model: string }) => void;
    setupResult.text.request.mockImplementationOnce(() => new Promise((resolve) => {
      finishExplicit = resolve;
    }));
    const explicit = caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    });
    await vi.waitFor(() => expect(setupResult.text.request).toHaveBeenCalledTimes(2));
    setupResult.host.recordAgentConnectionUnknownOutcomeFence({
      connectionId: "direct-xai",
      adapter: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    });
    await expect(caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).rejects.toThrow(/already in progress/i);
    expect(setupResult.text.request).toHaveBeenCalledTimes(2);
    finishExplicit({ credentialSource: "oauth", model: "grok-conversation-exact" });
    await expect(explicit).resolves.toMatchObject({ status: "ready" });
    setupResult.host.close();
  });

  it.each([
    ["codex", "Codex", "gpt-5.6-sol"],
    ["claude-code", "Claude Code", "claude-sonnet-5"],
  ] as const)("requires current %s Conversation disclosure for probe and adoption", async (
    adapter,
    label,
    model,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "agent", connectionId: adapter, model },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path: `/fake/bin/${adapter}` }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: `candidate:${adapter}`, model });
    await expect(caller.probe({ connectionId: adapter, capability: "conversation", model }))
      .rejects.toThrow(/disclosure/i);
    const adapterProbe = adapter === "codex" ? setupResult.codex.probe : setupResult.claude.probe;
    expect(adapterProbe).not.toHaveBeenCalled();

    await caller.acceptDisclosure({ connectionId: adapter, capability: "conversation" });
    await caller.probe({ connectionId: adapter, capability: "conversation", model });
    await caller.declineDisclosure({ connectionId: adapter, capability: "conversation" });
    await expect(setupResult.center.conversationAdoptionEvidence()).rejects.toThrow(/disclosure/i);
    setupResult.host.close();
  });

  it("clears the Unknown fence after an explicit probe reaches a proven failure", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    setupResult.text.request
      .mockRejectedValueOnce(new XaiTextUnknownOutcomeError({
        capability: "conversation",
        model: "grok-conversation-exact",
        credentialSource: "oauth",
      }))
      .mockRejectedValueOnce(new Error("HTTP 404 invalid model"))
      .mockResolvedValueOnce({ credentialSource: "oauth", model: "grok-conversation-exact" });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.probe({ connectionId: "direct-xai", capability: "conversation" });
    await expect(caller.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).resolves.toMatchObject({ status: "failed", reason: "invalid_model" });
    await expect(caller.probe({ connectionId: "direct-xai", capability: "conversation" }))
      .resolves.toMatchObject({ status: "ready" });
    expect(setupResult.text.request).toHaveBeenCalledTimes(3);
    setupResult.host.close();
  });

  it("stores an xAI API key without changing the explicitly selected credential source", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.setApiKey({ apiKey: "submitted-once" });

    expect(setupResult.credentials.setApiKey).toHaveBeenCalledWith("submitted-once");
    expect(setupResult.host.listAgentConnectionRecords()
      .find(({ id }) => id === "direct-xai")?.settings).toMatchObject({
        credentialSource: "oauth",
      });
    expect(setupResult.credentials.setPreferredSource).not.toHaveBeenCalledWith("api-key");
    setupResult.host.close();
  });

  it("starts Grok OAuth authorization without changing the explicitly selected credential source", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: "api-key" });
    setupResult.credentials.authorize.mockResolvedValue({
      status: "running",
      verificationUrl: "https://accounts.x.ai/oauth2/device",
      userCode: "ABCD-EFGH",
      message: "Complete authorization",
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.authorize();

    expect(setupResult.host.listAgentConnectionRecords()
      .find(({ id }) => id === "direct-xai")?.settings).toMatchObject({
        credentialSource: "api-key",
      });
    expect(setupResult.credentials.setPreferredSource).not.toHaveBeenCalledWith("oauth");
    setupResult.host.close();
  });

  it.each([
    ["transcription", /Cloud Transcription Consent \(xai-audio-v1\)/],
    ["summary", /Summary Data Path Disclosure \(xai-summary-v1\)/],
    ["conversation", /Conversation Data Path Disclosure \(xai-conversation-v1\)/],
  ] as const)("requires the current xAI %s disclosure before a real probe", async (
    capability,
    expected,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await expect(caller.probe({ connectionId: "direct-xai", capability }))
      .rejects.toThrow(expected);
    expect(setupResult.audio.testXai).not.toHaveBeenCalled();
    expect(setupResult.text.request).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it("presents each selected xAI disclosure independently from authorization", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.credentials.status.mockResolvedValue({
      connected: false,
      source: null,
      oauthConnected: false,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "Selected Grok OAuth is not connected",
      authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
    });

    const direct = (await setupResult.center.view()).connections
      .find(({ id }: { id: string }) => id === "direct-xai");

    expect(direct?.capabilities.map(({ capability, selected, disclosure }) => ({
      capability,
      selected,
      required: disclosure.required,
      version: disclosure.disclosureVersion,
    }))).toEqual([
      { capability: "transcription", selected: true, required: true, version: "xai-audio-v1" },
      { capability: "summary", selected: true, required: true, version: "xai-summary-v1" },
      { capability: "conversation", selected: true, required: true, version: "xai-conversation-v1" },
    ]);
    expect(setupResult.audio.testXai).not.toHaveBeenCalled();
    expect(setupResult.text.request).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it("fails closed when an xAI probe returns a different credential source", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.recordCloudTranscriptionConsent("xai-audio-v1");
    setupResult.audio.testXai.mockResolvedValue({
      provider: "xai-api-key:yulu",
      credentialSource: "api-key",
    });

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "transcription",
    })).resolves.toMatchObject({
      status: "failed",
      model: "speech-to-text",
      credentialSource: "oauth",
      reason: "identity_mismatch",
    });
    expect(setupResult.host.listAgentConnectionRecords()
      .find(({ id }) => id === "direct-xai")?.settings).toMatchObject({
        credentialSource: "oauth",
      });
    expect(setupResult.configManager.read().transcription.engine).toBe("xai");
    expect(setupResult.host.listAgentConnectionReadinessHistory("direct-xai", "transcription")[0])
      .toMatchObject({ status: "failed", reason: "identity_mismatch" });
    expect((await setupResult.makeCenter().view()).connections
      .find(({ id }) => id === "direct-xai")?.capabilities
      .find(({ capability }) => capability === "transcription")?.currentReadiness)
      .toMatchObject({ status: "failed", reason: "identity_mismatch", credentialSource: "oauth" });
    setupResult.host.close();
  });

  it("gives actionable realtime Transcription remediation instead of an uneditable model repair", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.recordCloudTranscriptionConsent("xai-audio-v1");
    setupResult.audio.testXai.mockRejectedValue(new Error("xAI realtime STT failed (HTTP 404)"));

    const result = await setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "transcription",
    });

    expect(result).toMatchObject({
      status: "failed",
      model: "speech-to-text",
      credentialSource: "oauth",
      reason: "readiness_failed",
    });
    expect(result.detail).toContain("realtime STT availability");
    expect(result.detail).not.toMatch(/enter an entitled exact model/i);
    expect(setupResult.host.listAgentConnectionReadinessHistory("direct-xai", "transcription")[0])
      .toMatchObject({ status: "failed", reason: "readiness_failed" });
    expect((await setupResult.makeCenter().view()).connections
      .find(({ id }) => id === "direct-xai")?.capabilities
      .find(({ capability }) => capability === "transcription")?.currentReadiness)
      .toMatchObject({ status: "failed", reason: "readiness_failed", credentialSource: "oauth" });
    setupResult.host.close();
  });

  it("classifies the realtime WebSocket 403 upgrade response as an entitlement repair", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.recordCloudTranscriptionConsent("xai-audio-v1");
    setupResult.audio.testXai.mockRejectedValue(new Error("Unexpected server response: 403"));

    const result = await setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "transcription",
    });

    expect(result).toMatchObject({
      status: "failed",
      credentialSource: "oauth",
      reason: "entitlement_failed",
    });
    expect(result.detail).toContain("verify xAI realtime transcription access");
    expect((await setupResult.makeCenter().view()).connections
      .find(({ id }) => id === "direct-xai")?.capabilities
      .find(({ capability }) => capability === "transcription")?.currentReadiness)
      .toMatchObject({ status: "failed", reason: "entitlement_failed", credentialSource: "oauth" });
    setupResult.host.close();
  });

  it("records a successful Transcription probe as a realtime WebSocket result", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.recordCloudTranscriptionConsent("xai-audio-v1");
    setupResult.audio.testXai.mockResolvedValue({
      provider: "xai-oauth:yulu",
      credentialSource: "oauth",
    });

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "transcription",
    })).resolves.toMatchObject({ status: "ready", credentialSource: "oauth" });

    expect(setupResult.host.listAgentConnectionReadinessHistory("direct-xai", "transcription")[0])
      .toMatchObject({ runtimeEvidence: { transport: "xai-realtime-websocket" } });
    setupResult.host.close();
  });

  it.each([
    [
      new Error("xAI summary request failed (HTTP 404)"),
      "invalid_model",
      "failed",
    ],
    [
      new Error("xAI summary request failed (HTTP 403)"),
      "entitlement_failed",
      "failed",
    ],
    [
      new Error("xAI OAuth 已失效，请在 Yulu 设置中重新授权"),
      "credential_refresh_failed",
      "failed",
    ],
    [
      new XaiTextUnknownOutcomeError({
        capability: "summary",
        model: "grok-summary-exact",
        credentialSource: "oauth",
      }),
      "unknown_outcome",
      "unknown",
    ],
  ] as const)("preserves the selected xAI source and model after %s", async (
    failure,
    reason,
    terminalStatus,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.center.acceptDisclosure({
      connectionId: "direct-xai",
      capability: "summary",
    });
    setupResult.host.recordAgentConnectionReadiness({
      connectionId: "direct-xai",
      capability: "summary",
      status: "ready",
      model: "grok-summary-exact",
      credentialSource: "oauth",
      detail: "Older successful probe",
      reason: null,
      runtimeEvidence: {
        adapter: "direct-xai",
        transport: "xai-http",
        runtimeVersion: null,
        requestedProvider: "xai",
        requestedModel: "grok-summary-exact",
        actualProvider: "xai",
        actualModel: "grok-summary-exact",
        requestId: null,
        sessionId: null,
        terminalStatus: "ready",
        fallbackOccurred: false,
      },
      testedAt: "2026-08-28T01:00:00.000Z",
    });
    setupResult.text.request.mockRejectedValue(failure);

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "summary",
    })).resolves.toMatchObject({
      status: "failed",
      model: "grok-summary-exact",
      credentialSource: "oauth",
      reason,
    });
    expect(setupResult.host.listAgentConnectionRecords()
      .find(({ id }) => id === "direct-xai")?.settings).toMatchObject({ credentialSource: "oauth" });
    expect(setupResult.configManager.read().intelligence.summary).toEqual({
      provider: "xai",
      model: "grok-summary-exact",
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("direct-xai", "summary")[0])
      .toMatchObject({
        status: "failed",
        model: "grok-summary-exact",
        credentialSource: "oauth",
        reason,
        runtimeEvidence: {
          requestedProvider: "xai",
          requestedModel: "grok-summary-exact",
          terminalStatus,
          fallbackOccurred: false,
        },
      });
    const restarted = await setupResult.makeCenter().view();
    expect(restarted.connections.find(({ id }) => id === "direct-xai")?.capabilities
      .find(({ capability }) => capability === "summary")?.currentReadiness)
      .toMatchObject({
        status: "failed",
        model: "grok-summary-exact",
        credentialSource: "oauth",
        reason,
      });
    setupResult.host.close();
  });

  it("reports the exact selected xAI source when that source is not connected", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: "api-key" });
    setupResult.center.acceptDisclosure({
      connectionId: "direct-xai",
      capability: "summary",
    });

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "summary",
    })).resolves.toMatchObject({
      status: "failed",
      model: "grok-summary-exact",
      credentialSource: "api-key",
      reason: "missing_credentials",
    });
    expect(setupResult.text.request).not.toHaveBeenCalled();
    expect(setupResult.host.listAgentConnectionRecords()
      .find(({ id }) => id === "direct-xai")?.settings).toMatchObject({ credentialSource: "api-key" });
    setupResult.host.close();
  });

  it("projects only currently eligible Summary Providers from the shared contract", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "hermes", label: "Hermes", path: "/fake/bin/hermes" }]);
    setupResult.text.request.mockResolvedValue({
      credentialSource: "oauth",
      model: "grok-summary-exact",
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.acceptDisclosure({ connectionId: "direct-xai", capability: "summary" });
    await caller.probe({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    });
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:hermes", model: "grok-4.6" });

    await expect(caller.summaryActivation()).resolves.toMatchObject({
      selected: {
        connectionId: "direct-xai",
        provider: "xai",
        label: "xAI",
        model: "grok-summary-exact",
      },
      state: "ready",
      options: [{
        connectionId: "direct-xai",
        provider: "xai",
        label: "xAI",
        model: "grok-summary-exact",
      }],
    });
    const contract = await caller.summaryActivation();
    expect(contract.options.some(({ provider }: { provider: string }) => provider === "hermes"))
      .toBe(false);
    expect(setupResult.conversationOnly.probe).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it.each([
    ["codex", "gpt-5.6-sol"],
    ["claude-code", "claude-sonnet-5"],
  ] as const)("keeps %s Summary declared but requires a fresh readiness proof after restart", async (
    adapter,
    model,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label: adapter === "codex" ? "Codex" : "Claude Code", path: `/fake/bin/${adapter}` }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: `candidate:${adapter}`, model });
    await caller.acceptDisclosure({ connectionId: adapter, capability: "summary" });
    await caller.probe({ connectionId: adapter, capability: "summary", model });
    await caller.select({ connectionId: adapter, capability: "summary", model });
    await expect(caller.summaryActivation()).resolves.toMatchObject({
      state: "ready",
      options: [expect.objectContaining({ connectionId: adapter, model })],
    });

    const driftedModel = `${model}-config-drift`;
    setupResult.configManager.update("intelligence.summary", {
      provider: "agent",
      connectionId: adapter,
      model: driftedModel,
    });
    await expect(caller.summaryActivation()).resolves.toMatchObject({
      state: "blocked",
      selected: { connectionId: adapter, model: driftedModel },
      credentialSource: null,
      testedAt: null,
      blocker: {
        capability: "summary_readiness",
        reason: "readiness_required",
      },
      options: [expect.objectContaining({ connectionId: adapter, model, selected: false })],
    });
    setupResult.configManager.update("intelligence.summary", {
      provider: "agent",
      connectionId: adapter,
      model,
    });

    const restarted = await setupResult.makeCenter().summaryActivation();
    expect(restarted).toMatchObject({
      state: "blocked",
      publicOnboardingSupported: true,
      blocker: {
        capability: "summary_readiness",
        reason: "readiness_required",
        remediation: { href: `/settings/llm?connection=${adapter}&capability=summary` },
      },
      options: [],
    });
    setupResult.host.close();
  });

  it("requires an exact current xAI Conversation readiness proof", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.text.request.mockResolvedValue({
      credentialSource: "oauth",
      model: "grok-conversation-exact",
    });

    await expect(setupResult.center.assertXaiConversationReady({ model: "grok-conversation-exact" }))
      .rejects.toThrow(/exact xAI Conversation model/i);
    await setupResult.center.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    await setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "conversation",
      model: "grok-conversation-exact",
    });
    await expect(setupResult.center.assertXaiConversationReady({ model: "grok-conversation-exact" }))
      .resolves.toBe("oauth");
    await expect(setupResult.center.assertXaiConversationReady({ model: "grok-other" }))
      .rejects.toThrow(/exact xAI Conversation model/i);

    setupResult.credentials.status.mockResolvedValue({
      connected: true,
      source: "api-key",
      oauthConnected: false,
      apiKeyConfigured: true,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "xAI API key connected",
      authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
    });
    await expect(setupResult.center.assertXaiConversationReady({ model: "grok-conversation-exact" }))
      .rejects.toThrow(/exact xAI Conversation model/i);
    await expect(setupResult.makeCenter().assertXaiConversationReady({ model: "grok-conversation-exact" }))
      .rejects.toThrow(/exact xAI Conversation model/i);
    setupResult.host.close();
  });

  it("migrates an unambiguous existing xAI OAuth credential source exactly once", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-4.6" },
        conversation: { provider: "xai", model: "grok-4.6" },
      },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });

    const view = await setupResult.center.view();

    expect(view.connections.find(({ id }: { id: string }) => id === "direct-xai"))
      .toMatchObject({
        lifecycle: "connected",
        authorization: {
          connected: true,
          credentialSource: "oauth",
          runtimeVersion: null,
          minimumVersion: null,
          compatibilityTarget: "xai-api",
          versionSource: "not-applicable",
          supported: true,
          features: ["transcription", "summary", "conversation", "no-provider-fallback"],
        },
        settings: { credentialSource: "oauth" },
      });
    expect(setupResult.host.listAgentConnectionRecords().find(({ id }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: "oauth" });
    expect(setupResult.credentials.setPreferredSource).toHaveBeenLastCalledWith("oauth");
    setupResult.host.close();
  });

  it("keeps concurrent first views on the same migrated xAI source", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: { summary: { provider: "xai", model: "grok-4.6" } },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });

    const [first, second] = await Promise.all([
      setupResult.center.view(),
      setupResult.center.view(),
    ]);

    for (const view of [first, second]) {
      expect(view.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
        .toMatchObject({ credentialSource: "oauth" });
    }
    expect(setupResult.credentials.setPreferredSource).toHaveBeenLastCalledWith("oauth");
    setupResult.host.close();
  });

  it("does not resurrect a direct xAI connection deleted while credential status is pending", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: { summary: { provider: "xai", model: "grok-4.6" } },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    let resolveStatus!: (value: Awaited<ReturnType<typeof setupResult.credentials.status>>) => void;
    setupResult.credentials.status.mockReturnValueOnce(new Promise((resolve) => {
      resolveStatus = resolve;
    }));

    const pendingView = setupResult.center.view();
    await vi.waitFor(() => expect(setupResult.credentials.status).toHaveBeenCalled());
    setupResult.host.deleteAgentConnectionRecord("direct-xai");
    resolveStatus({
      connected: true,
      source: "oauth",
      oauthConnected: true,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "xAI OAuth connected",
      authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
    });
    const deletedDuringView = await pendingView;

    expect(deletedDuringView.connections.some(({ id }: { id: string }) => id === "direct-xai"))
      .toBe(false);
    expect(setupResult.host.listAgentConnectionRecords().some(({ id }) => id === "direct-xai"))
      .toBe(false);
    const nextView = await setupResult.center.view();
    expect(nextView.connections.some(({ id }: { id: string }) => id === "direct-xai"))
      .toBe(false);
    setupResult.host.close();
  });

  it("retries the one-time xAI migration after a credential store read failure", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: { summary: { provider: "xai", model: "grok-4.6" } },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    setupResult.credentials.status.mockResolvedValueOnce({
      connected: true,
      source: "api-key" as const,
      oauthConnected: false,
      apiKeyConfigured: true,
      oauthReadSucceeded: false,
      apiKeyReadSucceeded: true,
      detail: "OAuth Keychain read failed",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    });

    const unavailable = await setupResult.center.view();
    expect(unavailable.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: null });

    const recovered = await setupResult.center.view();
    expect(recovered.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: "oauth" });
    setupResult.host.close();
  });

  it("does not guess an xAI source for fresh or ambiguous credentials after the one-time migration", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    setupResult.credentials.status.mockResolvedValueOnce({
      connected: false,
      source: null,
      oauthConnected: false,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "No xAI credential",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    });

    const first = await setupResult.center.view();
    expect(first.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: null });

    setupResult.credentials.status.mockResolvedValue({
      connected: true,
      source: "oauth" as const,
      oauthConnected: true,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "xAI OAuth connected later",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    });
    const later = await setupResult.center.view();
    expect(later.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: null });
    setupResult.host.close();

    const ambiguous = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: { summary: { provider: "xai", model: "grok-4.6" } },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    ambiguous.credentials.status.mockResolvedValue({
      connected: true,
      source: "oauth" as const,
      oauthConnected: true,
      apiKeyConfigured: true,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "Both xAI sources exist",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    });
    const ambiguousView = await ambiguous.center.view();
    expect(ambiguousView.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: null });
    ambiguous.host.close();
  });

  it("does not auto-select OAuth for fresh non-xAI config and does migrate API-key-only xAI config", async () => {
    const fresh = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    const freshView = await fresh.center.view();
    expect(freshView.connections.find(({ id }: { id: string }) => id === "direct-xai")?.settings)
      .toMatchObject({ credentialSource: null });
    fresh.host.close();

    const apiKeyOnly = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: { summary: { provider: "xai", model: "grok-4.6" } },
      llm: { agent: { provider: "auto" } },
    }, [], { seedDirectCredentialSource: false });
    apiKeyOnly.credentials.status.mockResolvedValue({
      connected: true,
      source: "api-key" as const,
      oauthConnected: false,
      apiKeyConfigured: true,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: true,
      detail: "xAI API Key connected",
      authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
    });
    const apiKeyView = await apiKeyOnly.center.view();
    expect(apiKeyView.connections.find(({ id }: { id: string }) => id === "direct-xai"))
      .toMatchObject({
        lifecycle: "connected",
        authorization: { credentialSource: "api-key" },
        settings: { credentialSource: "api-key" },
      });
    apiKeyOnly.host.close();
  });

  it("deletes a Codex connection without touching runtime OAuth or pinned work", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
        conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/bin/codex", summaryModel: "gpt-5.6-sol", conversationModel: "gpt-5.6-sol" },
    });
    const task = setupResult.host.enqueueRecording({
      idempotencyKey: "recording:pinned-codex-delete",
      recordingStem: "Pinned_Codex_20260828_010000",
      title: "Pinned Codex task",
      audioPath: join(setupResult.root, "Pinned_Codex_20260828_010000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const session = createAgentSession(setupResult.root, {
      provider: "codex",
      connectionId: "codex",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
      disclosureVersion: "codex-conversation-v1",
      title: "Pinned Codex conversation",
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await expect(caller.deletionImpact({ connectionId: "codex" })).resolves.toMatchObject({
      connectionId: "codex",
      selectedCapabilities: ["summary", "conversation"],
      pinnedTasks: [expect.objectContaining({ id: task.id })],
      pinnedConversations: [expect.objectContaining({ id: session.id })],
      removesRuntimeAuthorization: false,
      removesYuluManagedCredentials: false,
    });
    await caller.remove({ connectionId: "codex", confirmed: true });

    expect(setupResult.credentials.logout).not.toHaveBeenCalled();
    expect(setupResult.credentials.clearApiKey).not.toHaveBeenCalled();
    expect(setupResult.host.listAgentConnectionRecords().some((record) => record.id === "codex")).toBe(false);
    expect(setupResult.host.getTask(task.id)).toMatchObject({ summaryConnectionId: "codex", summaryModel: "gpt-5.6-sol" });
    expect(readAgentSessionStore(setupResult.root).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: session.id, connectionId: "codex", model: "gpt-5.6-sol" }),
    ]));
    expect(setupResult.configManager.read().intelligence).toMatchObject({
      summary: { provider: "agent", model: "runtime-managed", disabled: true },
      conversation: { provider: "agent", model: "runtime-managed", disabled: true },
    });
    setupResult.host.close();
  });

  it("never clears direct xAI credentials when the same supported connection is removed concurrently", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
        conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/bin/codex" },
    });

    const results = await Promise.allSettled([
      setupResult.center.remove({ connectionId: "codex", confirmed: true }),
      setupResult.center.remove({ connectionId: "codex", confirmed: true }),
    ]);

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(setupResult.credentials.logout).not.toHaveBeenCalled();
    expect(setupResult.credentials.clearApiKey).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it.each([
    ["hermes", "Hermes", "/fake/bin/hermes", "grok-4.6"],
    ["openclaw", "OpenClaw", "/fake/bin/openclaw", "openai-codex/gpt-5.5"],
  ] as const)("connects %s explicitly as Conversation-only without probing on open", async (
    adapter,
    label,
    path,
    model,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-4.6" },
        conversation: { provider: "xai", model: "grok-4.6" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    expect((await caller.view()).candidates).toContainEqual(expect.objectContaining({
      adapter,
      capabilities: ["conversation"],
      lifecycle: "candidate",
    }));
    expect(setupResult.conversationOnly.status).not.toHaveBeenCalled();
    expect(setupResult.conversationOnly.probe).not.toHaveBeenCalled();

    const connected = await caller.confirmCandidate({ candidateId: `candidate:${adapter}`, model });
    expect(connected.connections).toContainEqual(expect.objectContaining({
      id: adapter,
      adapter,
      authorization: expect.objectContaining({ connected: true, credentialSource: "runtime-oauth" }),
      capabilities: [expect.objectContaining({
        capability: "conversation",
        currentReadiness: expect.objectContaining({ status: "untested", model }),
      })],
    }));
    const connection = connected.connections.find((item: { id: string }) => item.id === adapter);
    expect(connection.capabilities.some((item: { capability: string }) => item.capability === "summary")).toBe(false);
    await expect(caller.probe({ connectionId: adapter, capability: "summary", model }))
      .rejects.toThrow(/Conversation only/i);
    await expect(caller.probe({ connectionId: adapter, capability: "conversation", model }))
      .rejects.toThrow(/disclosure/i);
    expect(setupResult.conversationOnly.probe).not.toHaveBeenCalled();

    await caller.acceptDisclosure({ connectionId: adapter, capability: "conversation" });
    await expect(caller.probe({ connectionId: adapter, capability: "conversation", model })).resolves.toMatchObject({
      capability: "conversation",
      status: "ready",
      model,
    });
    await caller.select({ connectionId: adapter, capability: "conversation", model });
    expect(JSON.parse(readFileSync(setupResult.configPath, "utf8"))).toMatchObject({
      intelligence: { conversation: { provider: "agent", connectionId: adapter, model } },
    });
    expect(JSON.stringify(await caller.view())).not.toContain("accessToken");
    setupResult.host.close();
  });

  it("accepts captured production OpenClaw Client-to-Adapter-to-Center evidence", async () => {
    const run: CliCommandRunner = vi.fn(async (command) => {
      const args = command.slice(1).join(" ");
      const stdout = args === "--version"
        ? "OpenClaw 2026.5.12 (f066dd2)\n"
        : args === "agent --help"
          ? "--json --model <id> --message <text> --session-id <id>\n"
          : args === "models status --json --check"
            ? JSON.stringify({
                resolvedDefault: "openai-codex/gpt-5.5",
                fallbacks: [],
                auth: { missingProvidersInUse: [], unusableProfiles: [] },
              })
            : args === "infer model run --help"
              ? "--local --gateway --model <provider/model> --prompt <text> --json\n"
              : args.startsWith("infer model run --gateway --model openai-codex/gpt-5.5")
                ? JSON.stringify({
                    ok: true,
                    capability: "model.run",
                    transport: "gateway",
                    provider: "openai-codex",
                    model: "gpt-5.5",
                    attempts: [],
                    outputs: [{ text: "YULU_OPENCLAW_PROBE_OK" }],
                  })
                : "";
      return {
        stdout,
        stderr: "",
        code: stdout ? 0 : 1,
        timedOut: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      };
    });
    const runtime = new ConversationOnlyCliRuntimeClient({
      adapter: "openclaw",
      executable: "/fake/bin/openclaw",
      cwd: "/movies",
      run,
    });
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-4.6" },
        conversation: { provider: "xai", model: "grok-4.6" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "openclaw", label: "OpenClaw", path: "/fake/bin/openclaw" }], {
      conversationOnlyClient: runtime,
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:openclaw", model: "openai-codex/gpt-5.5" });
    await caller.acceptDisclosure({ connectionId: "openclaw", capability: "conversation" });
    await expect(caller.probe({
      connectionId: "openclaw",
      capability: "conversation",
      model: "openai-codex/gpt-5.5",
    })).resolves.toMatchObject({ status: "ready", model: "openai-codex/gpt-5.5" });
    await caller.select({
      connectionId: "openclaw",
      capability: "conversation",
      model: "openai-codex/gpt-5.5",
    });
    await expect(setupResult.center.conversationAdoptionEvidence()).resolves.toMatchObject({
      connectionId: "openclaw",
      adapter: "openclaw",
      model: "openai-codex/gpt-5.5",
      runtimeEvidence: { sessionId: null, terminalStatus: "ready" },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("openclaw", "conversation"))
      .toEqual([expect.objectContaining({
        runtimeEvidence: expect.objectContaining({
          requestedProvider: "openai-codex",
          actualProvider: "openai-codex",
          requestedModel: "openai-codex/gpt-5.5",
          actualModel: "openai-codex/gpt-5.5",
        }),
      })]);
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "infer", "model", "run", "--gateway", "--model", "openai-codex/gpt-5.5",
    ]), "/movies", 30_000);
    setupResult.host.close();
  });

  it("persists Conversation-only Unknown Outcome evidence across Host restart", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-4.6" },
        conversation: { provider: "xai", model: "grok-4.6" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "openclaw", label: "OpenClaw", path: "/fake/bin/openclaw" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:openclaw", model: "openai-codex/gpt-5.5" });
    await caller.acceptDisclosure({ connectionId: "openclaw", capability: "conversation" });
    setupResult.conversationOnly.probe.mockResolvedValueOnce({
      status: "failed",
      reason: "unknown_outcome",
      remediation: "OpenClaw probe outcome is unknown",
      evidence: {
        adapter: "openclaw",
        transport: "openclaw-cli-gateway-json",
        runtimeVersion: "2026.5.12",
        requestedProvider: "openai-codex",
        requestedModel: "openai-codex/gpt-5.5",
        actualProvider: null,
        actualModel: null,
        requestId: null,
        sessionId: null,
        terminalStatus: "unknown",
        fallbackOccurred: null,
        cancellationRequested: true,
        cancellationConfirmed: false,
      },
    });

    await expect(caller.probe({
      connectionId: "openclaw",
      capability: "conversation",
      model: "openai-codex/gpt-5.5",
    })).resolves.toMatchObject({ status: "failed", reason: "unknown_outcome" });
    expect((await setupResult.makeCenter().view()).connections
      .find((connection) => connection.id === "openclaw")?.capabilities[0]?.readinessHistory)
      .toEqual([expect.objectContaining({
        reason: "unknown_outcome",
        runtimeEvidence: expect.objectContaining({
          terminalStatus: "unknown",
          fallbackOccurred: null,
        }),
      })]);
    setupResult.host.close();
  });

  it("deletes only the Yulu OpenClaw connection boundary and clears its future selection", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-4.6" },
        conversation: { provider: "agent", connectionId: "openclaw", model: "openai-codex/gpt-5.5" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "openclaw", label: "OpenClaw", path: "/fake/bin/openclaw" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:openclaw", model: "openai-codex/gpt-5.5" });
    createAgentSession(setupResult.root, {
      provider: "openclaw",
      connectionId: "openclaw",
      model: "openai-codex/gpt-5.5",
      runtimeProvider: "openai-codex",
      disclosureVersion: "openclaw-conversation-v1",
      credentialSource: "runtime-oauth",
      title: "Pinned OpenClaw",
    });

    await expect(caller.deletionImpact({ connectionId: "openclaw" })).resolves.toMatchObject({
      selectedCapabilities: ["conversation"],
      pinnedConversations: [expect.objectContaining({ title: "Pinned OpenClaw" })],
      removesRuntimeAuthorization: false,
      removesYuluManagedCredentials: false,
    });
    await caller.remove({ connectionId: "openclaw", confirmed: true });
    expect(setupResult.credentials.logout).not.toHaveBeenCalled();
    expect(setupResult.credentials.clearApiKey).not.toHaveBeenCalled();
    expect(setupResult.host.listAgentConnectionRecords().some((record) => record.id === "openclaw")).toBe(false);
    expect(JSON.parse(readFileSync(setupResult.configPath, "utf8"))).toMatchObject({
      intelligence: { conversation: { provider: "agent", model: "runtime-managed", disabled: true } },
    });
    setupResult.host.close();
  });

  it("confirms Codex explicitly and projects native auth without probing either capability", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await expect(caller.confirmCandidate({
      candidateId: "candidate:codex",
      model: "gpt-5.6-sol",
    })).resolves.toMatchObject({
      connections: expect.arrayContaining([expect.objectContaining({
        id: "codex",
        kind: "supported-agent",
        adapter: "codex",
        authorization: expect.objectContaining({
          connected: true,
          credentialSource: "runtime-oauth",
          authorizationClass: "chatgpt",
          runtimeVersion: "0.144.4",
          loginCommand: "/fake/bin/codex login",
        }),
        capabilities: expect.arrayContaining([expect.objectContaining({
          capability: "conversation",
          currentReadiness: expect.objectContaining({
            status: "untested",
            model: "gpt-5.6-sol",
            testedAt: null,
            detail: "Not tested in this Host process",
            credentialSource: null,
          }),
        })]),
      })]),
    });
    expect(setupResult.codex.status).toHaveBeenCalled();
    expect(setupResult.codex.probe).not.toHaveBeenCalled();
    expect(setupResult.codex.converse).not.toHaveBeenCalled();

    const beforeDisclosure = await caller.view();
    const codex = beforeDisclosure.connections.find((connection: { id: string }) => connection.id === "codex");
    expect(codex.capabilities.find(({ capability }: { capability: string }) => capability === "conversation").disclosure).toMatchObject({
      required: true,
      data: "conversation_text_and_agent_tool_context",
      destination: "Codex runtime and its configured providers/connectors",
    });
    await caller.acceptDisclosure({ connectionId: "codex", capability: "conversation" });
    expect(setupResult.host.getAgentConnectionDisclosure("codex", "conversation")).toMatchObject({
      decision: "accepted",
      disclosureVersion: "codex-conversation-v1",
    });
    expect(setupResult.host.getSummaryDataPathDisclosure("codex")).toBeNull();

    await expect(caller.probe({ connectionId: "codex", capability: "conversation" })).resolves.toMatchObject({
      capability: "conversation",
      status: "ready",
      model: "gpt-5.6-sol",
    });
    expect(setupResult.codex.probe).toHaveBeenCalledWith({ model: "gpt-5.6-sol" });
    await caller.select({ connectionId: "codex", capability: "conversation", model: "gpt-5.6-sol" });
    await expect(caller.view()).resolves.toMatchObject({
      selections: { conversation: { connectionId: "codex", model: "gpt-5.6-sol" } },
    });
    expect(JSON.parse(readFileSync(setupResult.configPath, "utf8"))).toMatchObject({
      intelligence: { conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("codex", "conversation")).toEqual([
      expect.objectContaining({
        status: "ready",
        runtimeEvidence: expect.objectContaining({
          authorizationClass: "chatgpt",
          requestedModel: "gpt-5.6-sol",
          actualModel: "gpt-5.6-sol",
          fallbackOccurred: false,
        }),
      }),
    ]);
    setupResult.host.close();
  });

  it("invalidates Codex OAuth readiness when account/read reports an API-key class", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    await caller.acceptDisclosure({ connectionId: "codex", capability: "conversation" });
    await caller.probe({ connectionId: "codex", capability: "conversation", model: "gpt-5.6-sol" });
    const oauthStatus = await setupResult.codex.status();
    setupResult.codex.status.mockImplementation(async () => ({
      ...oauthStatus,
      authorized: false,
      authorizationClass: "api-key",
      availableModels: [],
      remediation:
        "Codex API-key authorization cannot be used as Runtime-owned OAuth; run /fake/bin/codex login without --with-api-key to complete ChatGPT OAuth, then refresh this connection",
    } as never));

    const view = await caller.view();
    const codex = view.connections.find((connection: { id: string }) => connection.id === "codex");
    expect(codex).toMatchObject({
      lifecycle: "disconnected",
      authorization: {
        connected: false,
        credentialSource: "runtime-oauth",
        authorizationClass: "api-key",
        remediation:
          "Codex API-key authorization cannot be used as Runtime-owned OAuth; run /fake/bin/codex login without --with-api-key to complete ChatGPT OAuth, then refresh this connection",
      },
    });
    expect(codex?.capabilities.find(({ capability }: { capability: string }) => capability === "conversation"))
      .toMatchObject({
        currentReadiness: { status: "untested", testedAt: null },
        readinessHistory: [expect.objectContaining({
          status: "ready",
          runtimeEvidence: expect.objectContaining({ authorizationClass: "chatgpt" }),
        })],
      });
    await expect(caller.select({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    })).rejects.toThrow();
    expect(setupResult.codex.probe).toHaveBeenCalledTimes(1);
    setupResult.host.close();
  });

  it("connects Claude Code, proves only Conversation, and keeps readiness bound to its exact runtime identity", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    const candidateView = await caller.view();
    expect(candidateView.candidates).toContainEqual(expect.objectContaining({
      adapter: "claude-code",
      capabilities: ["summary", "conversation"],
      lifecycle: "candidate",
      selected: false,
    }));
    expect(setupResult.claude.status).not.toHaveBeenCalled();
    expect(setupResult.claude.probe).not.toHaveBeenCalled();

    await expect(caller.confirmCandidate({
      candidateId: "candidate:claude-code",
      model: "claude-sonnet-5",
    })).resolves.toMatchObject({
      connections: expect.arrayContaining([expect.objectContaining({
        id: "claude-code",
        adapter: "claude-code",
        authorization: expect.objectContaining({
          connected: true,
          credentialSource: "runtime-oauth",
          authorizationClass: "claude-subscription",
          runtimeVersion: "2.1.169",
          authorizationMethod: "claude.ai",
          loginCommand: "/fake/bin/claude auth login",
          statusCommand: "/fake/bin/claude auth status",
        }),
        capabilities: expect.arrayContaining([expect.objectContaining({
          capability: "conversation",
          declared: true,
          currentReadiness: expect.objectContaining({
            status: "untested",
            model: "claude-sonnet-5",
          }),
          disclosure: expect.objectContaining({
            required: true,
            disclosureVersion: CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
            data: "conversation_text_and_agent_tool_context",
          }),
        })]),
      })]),
    });
    expect(setupResult.claude.probe).not.toHaveBeenCalled();

    await caller.acceptDisclosure({ connectionId: "claude-code", capability: "conversation" });
    await expect(caller.probe({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    })).resolves.toMatchObject({
      capability: "conversation",
      status: "ready",
      model: "claude-sonnet-5",
    });
    await caller.select({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    });
    const live = await caller.view();
    expect(live.connections.find((item: { id: string }) => item.id === "claude-code")?.capabilities
      .find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({ declared: true, currentReadiness: { status: "untested" } });
    await expect(caller.view()).resolves.toMatchObject({
      selections: { conversation: { connectionId: "claude-code", model: "claude-sonnet-5" } },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("claude-code", "conversation")).toEqual([
      expect.objectContaining({
        status: "ready",
        runtimeEvidence: expect.objectContaining({
          adapter: "claude-code",
          authorizationClass: "claude-subscription",
          requestedModel: "claude-sonnet-5",
          actualModel: "claude-sonnet-5",
          sessionId: "019f0000-0000-7000-8000-000000000136",
          fallbackOccurred: false,
        }),
      }),
    ]);

    const restarted = await setupResult.makeCenter().view();
    expect(restarted.connections.find((item) => item.id === "claude-code")?.capabilities
      .find(({ capability }) => capability === "conversation"))
      .toMatchObject({
        capability: "conversation",
        currentReadiness: { status: "untested", testedAt: null },
        readinessHistory: [expect.objectContaining({ status: "ready", model: "claude-sonnet-5" })],
      });
    setupResult.host.close();
  });

  it("invalidates Claude Code OAuth readiness when native status reports API-key login", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:claude-code", model: "claude-sonnet-5" });
    await caller.acceptDisclosure({ connectionId: "claude-code", capability: "conversation" });
    await caller.probe({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    });
    const oauthStatus = await setupResult.claude.status();
    setupResult.claude.status.mockImplementation(async () => ({
      ...oauthStatus,
      authorized: false,
      authorizationClass: "api-key",
      authorizationMethod: "api_key",
      remediation:
        "Claude Code API-key login cannot be used as Runtime-owned OAuth; run /fake/bin/claude auth login and choose a Claude subscription, then refresh this connection",
    } as never));

    const view = await caller.view();
    const claude = view.connections.find((connection: { id: string }) => connection.id === "claude-code");
    expect(claude).toMatchObject({
      lifecycle: "disconnected",
      authorization: {
        connected: false,
        credentialSource: "runtime-oauth",
        authorizationClass: "api-key",
        authorizationMethod: "api_key",
        remediation:
          "Claude Code API-key login cannot be used as Runtime-owned OAuth; run /fake/bin/claude auth login and choose a Claude subscription, then refresh this connection",
      },
    });
    expect(claude?.capabilities.find(({ capability }: { capability: string }) => capability === "conversation"))
      .toMatchObject({
        currentReadiness: { status: "untested", testedAt: null },
        readinessHistory: [expect.objectContaining({
          status: "ready",
          runtimeEvidence: expect.objectContaining({ authorizationClass: "claude-subscription" }),
        })],
      });
    await expect(caller.select({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    })).rejects.toThrow();
    expect(setupResult.claude.probe).toHaveBeenCalledTimes(1);
    setupResult.host.close();
  });

  it("migrates a #136 Conversation-only Claude record while keeping Summary fail-closed", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary" },
        conversation: {
          provider: "agent",
          connectionId: "claude-code",
          model: "claude-sonnet-5",
        },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.upsertAgentConnectionRecord({
      id: "claude-code",
      kind: "supported-agent",
      adapter: "claude-code",
      label: "Claude Code",
      lifecycle: "available",
      settings: {
        executablePath: "/fake/bin/claude",
        conversationModel: "claude-sonnet-5",
      },
    });
    const conversationStatus = await setupResult.claude.status();
    setupResult.claude.status.mockReset();
    setupResult.claude.status
      .mockResolvedValueOnce(conversationStatus)
      .mockResolvedValueOnce({
        ...conversationStatus,
        supported: false,
        features: conversationStatus.features.filter((feature) => feature !== "managed-hooks/none"),
        remediation: "Claude Code cannot currently prove policy-managed hooks are disabled; Summary remains unavailable",
      } as never);

    const view = await setupResult.center.view();
    const claude = view.connections.find((connection) => connection.id === "claude-code");

    expect(claude).toMatchObject({
      authorization: { connected: true },
      settings: {
        summaryModel: "claude-sonnet-5",
        conversationModel: "claude-sonnet-5",
      },
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          capability: "summary",
          declared: false,
          currentReadiness: expect.objectContaining({
            status: "failed",
            model: "claude-sonnet-5",
            testedAt: null,
            detail: "Claude Code cannot currently prove policy-managed hooks are disabled; Summary remains unavailable",
            reason: "readiness_failed",
          }),
        }),
        expect.objectContaining({
          capability: "conversation",
          declared: true,
          selected: true,
          currentReadiness: expect.objectContaining({ status: "untested", model: "claude-sonnet-5" }),
        }),
      ]),
    });
    expect(setupResult.claude.probe).not.toHaveBeenCalled();
    expect(setupResult.claude.probeSummary).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it("keeps Claude Conversation available when only the Summary isolation status check fails", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary" },
        conversation: {
          provider: "agent",
          connectionId: "claude-code",
          model: "claude-sonnet-5",
        },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.upsertAgentConnectionRecord({
      id: "claude-code",
      kind: "supported-agent",
      adapter: "claude-code",
      label: "Claude Code",
      lifecycle: "available",
      settings: {
        executablePath: "/fake/bin/claude",
        summaryModel: "claude-sonnet-5",
        conversationModel: "claude-sonnet-5",
      },
    });
    const conversationStatus = await setupResult.claude.status();
    setupResult.claude.status.mockReset();
    setupResult.claude.status
      .mockResolvedValueOnce(conversationStatus)
      .mockRejectedValueOnce(new Error("tool-free inspection failed"));

    const view = await setupResult.center.view();
    const claude = view.connections.find((connection) => connection.id === "claude-code");

    expect(claude).toMatchObject({
      lifecycle: "connected",
      authorization: { connected: true },
      capabilities: expect.arrayContaining([
        expect.objectContaining({
          capability: "summary",
          declared: false,
          currentReadiness: expect.objectContaining({
            status: "failed",
            detail: "Claude Code Summary isolation status is unavailable",
          }),
        }),
        expect.objectContaining({
          capability: "conversation",
          declared: true,
          selected: true,
          currentReadiness: expect.objectContaining({ status: "untested" }),
        }),
      ]),
    });
    setupResult.host.close();
  });

  it("proves and selects Claude Code Summary independently from Conversation readiness and disclosure", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:claude-code", model: "claude-sonnet-5" });
    const before = await caller.view();
    expect(before.connections.find((connection: { id: string }) => connection.id === "claude-code")?.capabilities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          capability: "summary",
          declared: true,
          currentReadiness: expect.objectContaining({
            status: "untested", model: "claude-sonnet-5", testedAt: null,
          }),
          disclosure: expect.objectContaining({
            required: true,
            disclosureVersion: "claude-code-summary-v1",
            data: "transcript_text",
          }),
        }),
        expect.objectContaining({ capability: "conversation" }),
      ]));

    await caller.acceptDisclosure({ connectionId: "claude-code", capability: "summary" });
    expect(setupResult.host.getAgentConnectionDisclosure("claude-code", "summary")).toMatchObject({
      decision: "accepted",
      disclosureVersion: "claude-code-summary-v1",
    });
    expect(setupResult.host.getAgentConnectionDisclosure("claude-code", "conversation")).toBeNull();

    setupResult.claude.status.mockClear();
    await expect(caller.probe({
      connectionId: "claude-code",
      capability: "summary",
      model: "claude-sonnet-5",
    })).resolves.toMatchObject({ capability: "summary", status: "ready", model: "claude-sonnet-5" });
    expect(setupResult.claude.probeSummary).toHaveBeenCalledWith({ model: "claude-sonnet-5" });
    expect(setupResult.claude.status).toHaveBeenCalledWith({ toolFree: true });
    expect(setupResult.claude.probe).not.toHaveBeenCalled();

    setupResult.claude.status.mockClear();
    await caller.select({
      connectionId: "claude-code",
      capability: "summary",
      model: "claude-sonnet-5",
    });
    expect(setupResult.claude.status).toHaveBeenCalledWith({ toolFree: true });
    await expect(caller.view()).resolves.toMatchObject({
      selections: { summary: { connectionId: "claude-code", model: "claude-sonnet-5" } },
    });
    expect(JSON.parse(readFileSync(setupResult.configPath, "utf8"))).toMatchObject({
      intelligence: {
        summary: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" },
      },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("claude-code", "summary"))
      .toEqual([expect.objectContaining({
        status: "ready",
        runtimeEvidence: expect.objectContaining({
          adapter: "claude-code",
          requestedProvider: "firstParty",
          actualProvider: "firstParty",
          requestedModel: "claude-sonnet-5",
          actualModel: "claude-sonnet-5",
          fallbackOccurred: false,
        }),
      })]);

    const task = setupResult.host.enqueueRecording({
      idempotencyKey: "recording:claude-summary-production",
      recordingStem: "Claude_20260827_200000",
      title: "Claude production Summary",
      audioPath: join(setupResult.root, "Claude_20260827_200000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "claude-code",
      summaryProvider: "claude-code",
      summaryModel: "claude-sonnet-5",
      summaryConnectionId: "claude-code",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
    }).task;
    const gateway = setupResult.center.summaryAdapter().gateway(setupResult.configManager.read());
    await expect(gateway.runArtifactWorkflow({
      task,
      leaseToken: "host-owned",
      workspace: {
        dir: join(setupResult.root, "private-stage"),
        transcriptPath: join(setupResult.root, "private-stage", "transcript.txt"),
        summaryPath: join(setupResult.root, "private-stage", "summary.md"),
        chunkPattern: join(setupResult.root, "private-stage", "audio-%03d.wav"),
      },
      transcriptionProvider: "local",
      committedTranscript: "Only committed transcript text.",
    })).resolves.toMatchObject({
      summary: "# Claude Summary\n\nOnly committed input.",
      summaryIdentity: { provider: "claude-code", model: "claude-sonnet-5" },
      audit: { toolNames: [], notionWrite: false },
    });
    expect(setupResult.claude.summarize).toHaveBeenCalledWith({
      model: "claude-sonnet-5",
      instructions: task.instructions,
      transcript: "Only committed transcript text.",
    });
    setupResult.host.close();
  });

  it("does not declare Claude Code Summary when the current runtime cannot prove every isolation feature", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const completeStatus = await setupResult.claude.status();
    setupResult.claude.status.mockResolvedValue({
      ...completeStatus,
      features: completeStatus.features.filter((feature) => feature !== "tools/none"),
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:claude-code", model: "claude-sonnet-5" });
    const view = await caller.view();
    const claude = view.connections.find((connection: { id: string }) => connection.id === "claude-code");
    expect(claude.capabilities.find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({ declared: false, currentReadiness: { status: "untested" } });
    expect(claude.capabilities.find(({ capability }: { capability: string }) => capability === "conversation"))
      .toMatchObject({ declared: true });
    await expect(caller.probe({ connectionId: "claude-code", capability: "summary" }))
      .resolves.toMatchObject({ status: "failed" });
    setupResult.host.close();
  });

  it("preserves Claude Code Summary probe Unknown Outcome as distinct readiness evidence", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:claude-code", model: "claude-sonnet-5" });
    const ready = await setupResult.claude.probeSummary({ model: "claude-sonnet-5" });
    setupResult.claude.probeSummary.mockImplementationOnce(async () => ({
      ...ready,
      status: "failed",
      reason: "unknown_outcome",
      remediation: "Claude Code probe entered Unknown Outcome",
      evidence: { ...ready.evidence!, terminalStatus: "unknown" },
    } as never));

    await expect(caller.probe({
      connectionId: "claude-code",
      capability: "summary",
      model: "claude-sonnet-5",
    })).resolves.toMatchObject({
      status: "failed",
      reason: "unknown_outcome",
      detail: "Claude Code probe entered Unknown Outcome",
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("claude-code", "summary"))
      .toEqual([expect.objectContaining({
        reason: "unknown_outcome",
        runtimeEvidence: expect.objectContaining({ terminalStatus: "unknown" }),
      })]);
    setupResult.host.close();
  });

  it("proves and selects Codex Summary independently from Conversation authorization and disclosure", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    expect((await caller.view()).candidates.find((candidate: { adapter: string }) =>
      candidate.adapter === "codex")?.capabilities)
      .toEqual(["summary", "conversation"]);
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    const before = await caller.view();
    const codex = before.connections.find((connection: { id: string }) => connection.id === "codex");
    expect(codex.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: "summary",
        declared: true,
        currentReadiness: expect.objectContaining({ status: "untested", model: "gpt-5.6-sol" }),
        disclosure: expect.objectContaining({
          required: true,
          disclosureVersion: "codex-summary-v1",
          data: "transcript_text",
        }),
      }),
      expect.objectContaining({ capability: "conversation" }),
    ]));
    expect(setupResult.codex.probeSummary).not.toHaveBeenCalled();

    await caller.acceptDisclosure({ connectionId: "codex", capability: "summary" });
    expect(setupResult.host.getAgentConnectionDisclosure("codex", "summary")).toMatchObject({
      decision: "accepted",
      disclosureVersion: "codex-summary-v1",
    });
    expect(setupResult.host.getAgentConnectionDisclosure("codex", "conversation")).toBeNull();

    setupResult.codex.status.mockClear();
    await expect(caller.probe({ connectionId: "codex", capability: "summary" })).resolves.toMatchObject({
      capability: "summary",
      status: "ready",
      model: "gpt-5.6-sol",
    });
    expect(setupResult.codex.probeSummary).toHaveBeenCalledWith({ model: "gpt-5.6-sol" });
    expect(setupResult.codex.status).toHaveBeenCalledWith({ toolFree: true });
    expect(setupResult.codex.probe).not.toHaveBeenCalled();
    const tested = await caller.view();
    expect(tested.connections.find((connection: { id: string }) => connection.id === "codex")
      .capabilities.find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({ declared: true, currentReadiness: { status: "ready" } });

    setupResult.codex.status.mockClear();
    await caller.select({ connectionId: "codex", capability: "summary", model: "gpt-5.6-sol" });
    expect(setupResult.codex.status).toHaveBeenCalledWith({ toolFree: true });
    await expect(caller.view()).resolves.toMatchObject({
      selections: { summary: { connectionId: "codex", model: "gpt-5.6-sol" } },
    });
    expect(JSON.parse(readFileSync(setupResult.configPath, "utf8"))).toMatchObject({
      intelligence: { summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("codex", "summary")).toEqual([
      expect.objectContaining({
        status: "ready",
        runtimeEvidence: expect.objectContaining({
          requestedModel: "gpt-5.6-sol",
          actualModel: "gpt-5.6-sol",
          fallbackOccurred: false,
        }),
      }),
    ]);

    const task = setupResult.host.enqueueRecording({
      idempotencyKey: "recording:codex-summary-production",
      recordingStem: "Codex_20260827_190000",
      title: "Codex production Summary",
      audioPath: join(setupResult.root, "Codex_20260827_190000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "gpt-5.6-sol",
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    }).task;
    const gateway = setupResult.center.summaryAdapter().gateway(setupResult.configManager.read());
    await expect(gateway.runArtifactWorkflow({
      task,
      leaseToken: "host-owned",
      workspace: {
        dir: join(setupResult.root, "private-stage"),
        transcriptPath: join(setupResult.root, "private-stage", "transcript.txt"),
        summaryPath: join(setupResult.root, "private-stage", "summary.md"),
        chunkPattern: join(setupResult.root, "private-stage", "audio-%03d.wav"),
      },
      transcriptionProvider: "local",
      committedTranscript: "Only committed transcript text.",
    })).resolves.toMatchObject({
      summary: "# Summary\n\nOnly committed input.",
      summaryIdentity: { provider: "codex", model: "gpt-5.6-sol" },
      audit: { toolNames: [], notionWrite: false },
    });
    expect(setupResult.codex.summarize).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      instructions: task.instructions,
      transcript: "Only committed transcript text.",
    });
    setupResult.host.close();
  });

  it("does not declare Codex Summary when the current runtime cannot prove every isolation feature", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const completeStatus = await setupResult.codex.status();
    setupResult.codex.status.mockResolvedValue({
      ...completeStatus,
      features: completeStatus.features.filter((feature) => feature !== "mcpServerStatus/list"),
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    const view = await caller.view();
    const codex = view.connections.find((connection: { id: string }) => connection.id === "codex");
    expect(codex.capabilities.find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({ declared: false, currentReadiness: { status: "untested" } });
    await expect(caller.probe({ connectionId: "codex", capability: "summary" }))
      .resolves.toMatchObject({ status: "failed" });
    setupResult.host.close();
  });

  it("probes the requested Codex model and invalidates readiness when exact runtime identity changes", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    setupResult.codex.status.mockResolvedValue({
      ...(await setupResult.codex.status()),
      availableModels: ["gpt-5.6-sol", "gpt-5.6-terra"],
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    await caller.acceptDisclosure({ connectionId: "codex", capability: "conversation" });
    await expect(caller.probe({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-terra",
    })).resolves.toMatchObject({ status: "ready", model: "gpt-5.6-terra" });
    expect(setupResult.codex.probe).toHaveBeenLastCalledWith({ model: "gpt-5.6-terra" });
    await expect(caller.select({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-terra",
    })).resolves.toMatchObject({
      selections: { conversation: { connectionId: "codex", model: "gpt-5.6-terra" } },
    });

    const readyStatus = await setupResult.codex.status();
    setupResult.codex.status.mockResolvedValue({ ...readyStatus, authorized: false });
    const disconnected = await caller.view();
    expect(disconnected.connections.find(({ id }: { id: string }) => id === "codex")?.capabilities
      .find(({ capability }: { capability: string }) => capability === "conversation")?.currentReadiness)
      .toMatchObject({ status: "untested", model: "gpt-5.6-terra" });
    await expect(caller.select({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-terra",
    })).rejects.toThrow(/test this exact Codex Conversation model/i);

    setupResult.codex.status.mockResolvedValue({ ...readyStatus, authorized: true });
    await caller.probe({ connectionId: "codex", capability: "conversation", model: "gpt-5.6-terra" });
    setupResult.host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: {
        executablePath: "/replacement/bin/codex",
        conversationModel: "gpt-5.6-terra",
        credentialSource: "runtime-oauth",
      },
    });
    await expect(caller.select({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-terra",
    })).rejects.toThrow(/test this exact Codex Conversation model/i);
    setupResult.host.close();
  });

  it("opens secret-safe without probing and migrates old Agent choices to candidate or legacy state", async () => {
    const supported = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary" },
        conversation: { provider: "xai", model: "grok-conversation" },
      },
      llm: { enabled: true, command: null, agent: { provider: "codex" } },
    });

    const view = await supported.center.view();

    expect(view.connections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "direct-xai",
        kind: "direct-provider",
        adapter: "direct-xai",
        authorization: expect.objectContaining({ connected: true, credentialSource: "oauth" }),
        settings: expect.objectContaining({ credentialSource: "oauth" }),
      }),
    ]));
    expect(view.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ adapter: "codex", lifecycle: "candidate", selected: false }),
    ]));
    expect(view.selections).toMatchObject({
      summary: { connectionId: "direct-xai", model: "grok-summary" },
      conversation: { connectionId: "direct-xai", model: "grok-conversation" },
    });
    expect(view.connections[0]?.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ capability: "transcription", currentReadiness: expect.objectContaining({ status: "untested" }) }),
      expect.objectContaining({ capability: "summary", currentReadiness: expect.objectContaining({ status: "untested" }) }),
      expect.objectContaining({ capability: "conversation", currentReadiness: expect.objectContaining({ status: "untested" }) }),
    ]));
    expect(supported.audio.testXai).not.toHaveBeenCalled();
    expect(supported.text.request).not.toHaveBeenCalled();
    expect(JSON.stringify(view)).not.toMatch(/access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key.*value/i);

    const migratedConfig = JSON.parse(await import("node:fs/promises").then(({ readFile }) => readFile(supported.configPath, "utf8")));
    expect(migratedConfig.llm).toMatchObject({ enabled: false, command: null, agent: { provider: "auto" } });
    expect(readdirSync(supported.root).filter((name) => name.includes("legacy-agent-connection"))).toHaveLength(1);
    supported.host.close();

    const migratedClaude = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { enabled: true, command: ["claude"], agent: { provider: "claude" } },
    });
    await expect(migratedClaude.center.view()).resolves.toMatchObject({
      candidates: [expect.objectContaining({
        adapter: "claude-code",
        capabilities: ["summary", "conversation"],
        lifecycle: "candidate",
        selected: false,
      })],
      legacyConnections: [],
    });
    expect(JSON.parse(readFileSync(migratedClaude.configPath, "utf8"))).toMatchObject({
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    });
    expect(migratedClaude.claude.status).not.toHaveBeenCalled();
    migratedClaude.host.close();

    const legacy = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { enabled: true, command: ["private-wrapper", "--profile", "work"], agent: { provider: "custom" } },
    });
    const legacyView = await legacy.center.view();
    expect(legacyView.legacyConnections).toEqual([
      expect.objectContaining({ kind: "legacy-custom", lifecycle: "legacy", selected: false }),
    ]);
    expect(JSON.stringify(legacyView.legacyConnections)).not.toContain("--profile");
    const archives = readdirSync(legacy.root).filter((name) => name.includes("legacy-agent-connection"));
    expect(archives).toHaveLength(1);
    const archivePath = join(legacy.root, archives[0]!);
    expect(statSync(archivePath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(archivePath, "utf8"))).toMatchObject({
      llm: { enabled: true, command: ["private-wrapper", "--profile", "work"], agent: { provider: "custom" } },
    });
    legacy.host.close();

    const wrapper = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { enabled: true, command: ["codex-wrapper", "--profile", "work"], agent: { provider: "codex" } },
    });
    await expect(wrapper.center.view()).resolves.toMatchObject({
      candidates: [],
      legacyConnections: [expect.objectContaining({ kind: "legacy-custom", selected: false })],
    });
    wrapper.host.close();

    const unsupported = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { enabled: true, command: null, agent: { provider: "gemini" } },
    });
    await expect(unsupported.center.view()).resolves.toMatchObject({
      legacyConnections: [expect.objectContaining({
        kind: "legacy-custom",
        lifecycle: "legacy",
        selected: false,
      })],
    });
    unsupported.host.close();

    const automatic = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {},
      llm: { enabled: true, command: null, agent: { provider: "auto" } },
    });
    await expect(automatic.center.view()).resolves.toMatchObject({ candidates: [] });
    expect(automatic.discover).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(automatic.configPath, "utf8"))).toMatchObject({
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    });
    automatic.host.close();
  });

  it("keeps current capability readiness separate from persisted Readiness History", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.text.request.mockResolvedValue({
      model: "grok-summary-exact",
      credentialSource: "oauth",
    });
    setupResult.center.acceptDisclosure({
      connectionId: "direct-xai",
      capability: "summary",
    });

    await expect(setupResult.center.probe({
      connectionId: "direct-xai",
      capability: "summary",
    })).resolves.toMatchObject({
      capability: "summary",
      status: "ready",
      model: "grok-summary-exact",
      credentialSource: "oauth",
      testedAt: expect.any(String),
    });
    expect(setupResult.text.request).toHaveBeenCalledOnce();
    expect(setupResult.audio.testXai).not.toHaveBeenCalled();

    const liveView = await setupResult.center.view();
    const liveSummary = liveView.connections[0]?.capabilities.find(({ capability }) => capability === "summary");
    expect(liveSummary).toMatchObject({
      currentReadiness: { status: "ready" },
      readinessHistory: [expect.objectContaining({
        status: "ready",
        model: "grok-summary-exact",
        runtimeEvidence: {
          adapter: "direct-xai",
          transport: "xai-http",
          runtimeVersion: null,
          requestedProvider: "xai",
          requestedModel: "grok-summary-exact",
          actualProvider: "xai",
          actualModel: "grok-summary-exact",
          requestId: null,
          sessionId: null,
          terminalStatus: "ready",
          fallbackOccurred: false,
        },
      })],
    });

    const restartedView = await setupResult.makeCenter().view();
    const restartedSummary = restartedView.connections[0]?.capabilities.find(({ capability }) => capability === "summary");
    expect(restartedSummary).toMatchObject({
      currentReadiness: { status: "untested", testedAt: null },
      readinessHistory: [expect.objectContaining({ status: "ready", model: "grok-summary-exact" })],
    });
    setupResult.host.close();
  });

  it("requires the UI bearer for every mutation and never selects a discovered candidate", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "claude-code", label: "Claude Code", path: "/fake/bin/claude" }]);
    const unauthorized = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: false,
    } as never);
    const authorized = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await expect(unauthorized.refreshCandidates()).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.select({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    })).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.selectCredentialSource({
      connectionId: "direct-xai",
      credentialSource: "api-key",
    })).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.startNativeAuthorization({
      connectionId: "candidate:claude-code",
    })).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.refreshNativeAuthorizationStatus({
      connectionId: "candidate:claude-code",
    })).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.createConversationProbeAttempt({
      connectionId: "direct-xai",
      model: "grok-conversation-exact",
    })).rejects.toThrow("UI mutation bearer required");
    expect(setupResult.discover).not.toHaveBeenCalled();

    await expect(authorized.refreshCandidates()).resolves.toMatchObject({
      candidates: [expect.objectContaining({ adapter: "claude-code", lifecycle: "candidate", selected: false })],
    });
    await expect(authorized.select({
      connectionId: "candidate:claude-code",
      capability: "conversation",
      model: "runtime-managed",
    })).rejects.toThrow("Connection Candidate");

    await authorized.select({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    });
    await authorized.selectCredentialSource({
      connectionId: "direct-xai",
      credentialSource: "api-key",
    });
    expect(setupResult.credentials.setPreferredSource).toHaveBeenLastCalledWith("api-key");
    await expect(authorized.view()).resolves.toMatchObject({
      selections: { summary: { connectionId: "direct-xai", model: "grok-summary-exact" } },
    });
    expect(setupResult.text.request).not.toHaveBeenCalled();
    expect(setupResult.audio.testXai).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it("persists a separate Conversation disclosure and previews pinned work before deletion", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "xai", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    setupResult.host.enqueueRecording({
      idempotencyKey: "recording:pinned-xai",
      recordingStem: "Pinned_20260827_120000",
      title: "Pinned",
      audioPath: join(setupResult.root, "Pinned_20260827_120000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-summary-exact",
      summaryCredentialSource: "oauth",
    });
    createAgentSession(setupResult.root, {
      provider: "xai",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
      title: "Pinned conversation",
    });
    setupResult.host.declineSummaryDataPathDisclosure("xai", "xai-summary-v1");
    setupResult.host.recordCloudTranscriptionConsent("xai-audio-v1");
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    const before = await caller.view();
    const conversation = before.connections[0].capabilities
      .find((item: { capability: string }) => item.capability === "conversation");
    const summary = before.connections[0].capabilities
      .find((item: { capability: string }) => item.capability === "summary");
    expect(summary.disclosure.required).toBe(true);
    expect(summary.disclosure.decision).toBe("declined");
    expect(conversation.disclosure).toMatchObject({
      required: true,
      data: "meeting_excerpt_text",
      destination: "xAI",
    });

    await caller.acceptDisclosure({ connectionId: "direct-xai", capability: "conversation" });
    const accepted = await caller.view();
    expect(accepted.connections[0].capabilities
      .find((item: { capability: string }) => item.capability === "conversation").disclosure.required).toBe(false);
    await caller.declineDisclosure({ connectionId: "direct-xai", capability: "summary" });
    const declined = await caller.view();
    expect(declined.connections[0].capabilities
      .find((item: { capability: string }) => item.capability === "summary").disclosure).toMatchObject({
        required: true,
        decision: "declined",
      });

    await expect(caller.deletionImpact({ connectionId: "direct-xai" })).resolves.toMatchObject({
      connectionId: "direct-xai",
      selectedCapabilities: ["transcription", "summary", "conversation"],
      pinnedTasks: [expect.objectContaining({ recordingStem: "Pinned_20260827_120000" })],
      pinnedConversations: [expect.objectContaining({ title: "Pinned conversation" })],
      removesRuntimeAuthorization: false,
    });
    await caller.remove({ connectionId: "direct-xai", confirmed: true });
    expect(setupResult.credentials.logout).toHaveBeenCalledOnce();
    expect(setupResult.credentials.clearApiKey).toHaveBeenCalledOnce();
    expect(setupResult.host.getCloudTranscriptionConsent()).toBeNull();
    expect(setupResult.host.getSummaryDataPathDisclosure("xai")).toBeNull();
    expect(setupResult.host.getAgentConnectionDisclosure("direct-xai", "conversation")).toBeNull();
    await expect(caller.view()).resolves.toMatchObject({
      connections: [],
      selections: {
        transcription: { connectionId: null },
        summary: { connectionId: null },
        conversation: { connectionId: null },
      },
    });
    expect(setupResult.host.listAgentConnectionRecords()).toEqual([]);
    await expect(caller.select({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    })).rejects.toThrow("Agent Connection not found");
    await expect(setupResult.makeCenter().view()).resolves.toMatchObject({ connections: [] });
    await expect(caller.restoreDirectXai()).resolves.toMatchObject({
      connections: [expect.objectContaining({ id: "direct-xai" })],
    });
    expect(setupResult.credentials.authorize).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it.each([
    ["codex", "Codex", "/fake/bin/codex"],
    ["claude-code", "Claude Code", "/fake/bin/claude"],
    ["hermes", "Hermes", "/fake/bin/hermes"],
    ["openclaw", "OpenClaw", "/fake/bin/openclaw"],
  ] as const)("launches %s native authorization from a candidate without selecting or probing", async (
    adapter,
    label,
    path,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    const configBefore = readFileSync(setupResult.configPath, "utf8");
    await expect(caller.startNativeAuthorization({ connectionId: `candidate:${adapter}` }))
      .resolves.toEqual({
        connectionId: `candidate:${adapter}`,
        adapter,
        launched: true,
        resume: "refresh-status",
      });

    expect(setupResult.nativeAuthorization).toHaveBeenCalledWith({ adapter, executable: path });
    expect(readFileSync(setupResult.configPath, "utf8")).toBe(configBefore);
    expect(setupResult.host.listAgentConnectionRecords()
      .some((record) => record.kind === "supported-agent")).toBe(false);
    expect(setupResult.codex.probe).not.toHaveBeenCalled();
    expect(setupResult.codex.probeSummary).not.toHaveBeenCalled();
    expect(setupResult.claude.probe).not.toHaveBeenCalled();
    expect(setupResult.claude.probeSummary).not.toHaveBeenCalled();
    expect(setupResult.conversationOnly.probe).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it.each([
    ["codex", "Codex", "/fake/bin/codex", "0.144.4"],
    ["claude-code", "Claude Code", "/fake/bin/claude", "2.1.169"],
    ["hermes", "Hermes", "/fake/bin/hermes", "0.20.0"],
    ["openclaw", "OpenClaw", "/fake/bin/openclaw", "2026.5.12"],
  ] as const)("refreshes %s candidate authorization status without connecting, selecting, or probing", async (
    adapter,
    label,
    path,
    runtimeVersion,
  ) => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter, label, path }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    const configBefore = readFileSync(setupResult.configPath, "utf8");
    await expect(caller.refreshNativeAuthorizationStatus({ connectionId: `candidate:${adapter}` }))
      .resolves.toMatchObject({
        connectionId: `candidate:${adapter}`,
        adapter,
        supported: true,
        authorized: true,
        runtimeVersion,
      });

    expect(readFileSync(setupResult.configPath, "utf8")).toBe(configBefore);
    expect(setupResult.host.listAgentConnectionRecords()
      .some((record) => record.kind === "supported-agent")).toBe(false);
    expect(setupResult.codex.probe).not.toHaveBeenCalled();
    expect(setupResult.codex.probeSummary).not.toHaveBeenCalled();
    expect(setupResult.claude.probe).not.toHaveBeenCalled();
    expect(setupResult.claude.probeSummary).not.toHaveBeenCalled();
    expect(setupResult.conversationOnly.probe).not.toHaveBeenCalled();
    setupResult.host.close();
  });

  it("invalidates current readiness when native reauthorization can change runtime identity", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary-exact" },
        conversation: { provider: "xai", model: "grok-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    }, [{ adapter: "codex", label: "Codex", path: "/fake/bin/codex" }]);
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await caller.refreshCandidates();
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    await caller.acceptDisclosure({ connectionId: "codex", capability: "summary" });
    await caller.probe({ connectionId: "codex", capability: "summary", model: "gpt-5.6-sol" });
    const before = await caller.view();
    expect(before.connections.find((connection: { id: string }) => connection.id === "codex")
      ?.capabilities.find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({
        currentReadiness: { status: "ready" },
        readinessHistory: [expect.objectContaining({ status: "ready" })],
      });

    await caller.startNativeAuthorization({ connectionId: "codex" });

    const after = await caller.view();
    expect(after.connections.find((connection: { id: string }) => connection.id === "codex")
      ?.capabilities.find(({ capability }: { capability: string }) => capability === "summary"))
      .toMatchObject({
        currentReadiness: { status: "untested", testedAt: null },
        readinessHistory: [expect.objectContaining({ status: "ready" })],
      });
    setupResult.host.close();
  });
});
