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
import { CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION } from "../../src/conversationDataDisclosure.js";
import type { GatewayRuntimeEvidence } from "../../src/cliProxyApiAdapter.js";

const roots: string[] = [];

function setup(
  config: Record<string, unknown>,
  discovered: Array<{ adapter: "codex" | "claude-code" | "hermes" | "openclaw"; label: string; path: string }> = [],
) {
  const root = mkdtempSync(join(tmpdir(), "yulu-agent-connections-"));
  roots.push(root);
  const configPath = join(root, "config.json");
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  const host = new HostStore(join(root, "host.sqlite"));
  const credentials = {
    status: vi.fn(async () => ({
      connected: true,
      source: "oauth" as const,
      oauthConnected: true,
      apiKeyConfigured: false,
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
  const codex = {
    status: vi.fn(async () => ({
      adapter: "codex" as const,
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      minimumVersion: "0.144.0",
      supported: true,
      authorized: true,
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
        "probe-bounds" as const,
        "tools/none" as const,
        "probe-isolation" as const,
        "fallback-model/opt-in" as const,
        "managed-hooks/none" as const,
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
        requestedProvider: null,
        requestedModel: model,
        actualProvider: null,
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
        requestedProvider: null,
        requestedModel: model,
        actualProvider: null,
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
  const gatewayKeys = new Map<string, string>();
  const gatewaySecretWrite = vi.fn(async (credentialIdentity: string, value: string) => {
    gatewayKeys.set(credentialIdentity, value);
  });
  const gatewaySecretClear = vi.fn(async (credentialIdentity: string) => {
    gatewayKeys.delete(credentialIdentity);
  });
  const gatewaySecretStore = vi.fn((credentialIdentity: string) => ({
    read: vi.fn(async () => gatewayKeys.get(credentialIdentity) ?? null),
    write: vi.fn(async (value: string) => gatewaySecretWrite(credentialIdentity, value)),
    clear: vi.fn(async () => gatewaySecretClear(credentialIdentity)),
  }));
  const gatewayEvidence = (endpoint: string, model: string, requestId: string): GatewayRuntimeEvidence => ({
    adapter: "cliproxyapi",
    transport: endpoint.startsWith("https:")
      ? "openai-responses-approved-https"
      : "openai-responses-loopback-http",
    runtimeVersion: "cliproxyapi-v0.23.0-rc.1-openai-responses",
    endpoint,
    requestedProvider: null,
    requestedModel: model,
    actualProvider: null,
    actualModel: model,
    requestId,
    sessionId: null,
    terminalStatus: "ready",
    fallbackOccurred: false,
    toolsEnabled: false,
  });
  const gateway = {
    validateEndpoint: vi.fn(async function (this: { endpoint?: string }) {
      const endpoint = this.endpoint ?? "http://127.0.0.1:8317/v1";
      return { endpoint, transport: endpoint.startsWith("https:") ? "approved-https" as const : "loopback-http" as const };
    }),
    probe: vi.fn(),
    summarize: vi.fn(async ({ model }: { model: string }) => ({
      summary: "# Gateway Summary",
      evidence: gatewayEvidence("http://127.0.0.1:8317/v1", model, "summary-request"),
    })),
    converse: vi.fn(async ({ model }: { model: string }) => ({
      answer: "Gateway answer",
      evidence: gatewayEvidence("http://127.0.0.1:8317/v1", model, "conversation-request"),
    })),
  };
  const cliProxyAdapter = vi.fn(({
    endpoint: rawEndpoint,
    credentialIdentity,
  }: { endpoint: string; httpsApproved: boolean; credentialIdentity: string }) => {
    const endpoint = rawEndpoint.replace(/\/$/, "");
    return {
      validateEndpoint: vi.fn(async () => ({
        endpoint,
        transport: endpoint.startsWith("https:") ? "approved-https" as const : "loopback-http" as const,
      })),
      keyConfigured: vi.fn(async () => gatewayKeys.has(credentialIdentity)),
      probe: vi.fn(async (input: { capability: "summary" | "conversation"; model: string }) => {
        gateway.probe(input);
        return {
          status: "ready" as const,
          evidence: gatewayEvidence(endpoint, input.model, `probe-${input.capability}`),
        };
      }),
      summarize: vi.fn(async (input: { model: string; instructions: string; transcript: string }) => {
        const result = await gateway.summarize(input);
        return { ...result, evidence: gatewayEvidence(endpoint, input.model, "summary-request") };
      }),
      converse: vi.fn(async (input: { model: string }) => {
        const result = await gateway.converse(input);
        return { ...result, evidence: gatewayEvidence(endpoint, input.model, "conversation-request") };
      }),
    };
  });
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
    gatewaySecretStore,
    cliProxyAdapter,
  });
  host.upsertAgentConnectionRecord({
    id: "direct-xai",
    kind: "direct-provider",
    adapter: "direct-xai",
    label: "xAI",
    lifecycle: "available",
    settings: { credentialSource: "oauth" },
  });
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
    gateway,
    gatewaySecretStore,
    gatewaySecretWrite,
    gatewaySecretClear,
    gatewayKeys,
    cliProxyAdapter,
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
      gatewaySecretStore,
      cliProxyAdapter,
    }),
    discover,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public Agent Connection Host contract", () => {
  it("creates a secret-safe CLIProxyAPI Gateway and keeps Summary and Conversation independent", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary" },
        conversation: { provider: "xai", model: "grok-conversation" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    const created = await caller.saveGateway({
      endpoint: "http://127.0.0.1:8317/v1/",
      summaryModel: "gateway-summary-exact",
      conversationModel: "gateway-conversation-exact",
      inferenceKey: "least-privilege-key-never-project",
      httpsApproved: false,
      confirmed: true,
    });

    expect(created.connections).toEqual(expect.arrayContaining([expect.objectContaining({
      id: "cliproxyapi",
      kind: "gateway",
      adapter: "cliproxyapi",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "api-key",
        keyConfigured: true,
        compatibilityTarget: "v0.23.0-rc.1",
      },
      settings: expect.objectContaining({
        endpoint: "http://127.0.0.1:8317/v1",
        transport: "loopback-http",
        summaryModel: "gateway-summary-exact",
        conversationModel: "gateway-conversation-exact",
        credentialClass: "api-key",
      }),
      capabilities: expect.arrayContaining([
        expect.objectContaining({ capability: "summary", currentReadiness: expect.objectContaining({ status: "untested", model: "gateway-summary-exact", testedAt: null, detail: "Not tested in this Host process", credentialSource: null }) }),
        expect.objectContaining({ capability: "conversation", currentReadiness: expect.objectContaining({ status: "untested", model: "gateway-conversation-exact", testedAt: null, detail: "Not tested in this Host process", credentialSource: null }) }),
      ]),
    })]));
    expect(setupResult.gatewaySecretWrite.mock.calls[0]?.[1] === "least-privilege-key-never-project").toBe(true);
    expect(setupResult.gateway.probe).not.toHaveBeenCalled();
    expect(JSON.stringify(created).includes("least-privilege-key-never-project")).toBe(false);

    await caller.acceptDisclosure({ connectionId: "cliproxyapi", capability: "summary" });
    await caller.acceptDisclosure({ connectionId: "cliproxyapi", capability: "conversation" });
    const summaryReady = await caller.probe({ connectionId: "cliproxyapi", capability: "summary" });
    expect(summaryReady).toMatchObject({ capability: "summary", status: "ready", model: "gateway-summary-exact" });
    expect(summaryReady).not.toHaveProperty("reason");
    let view = await caller.view();
    expect(view.connections.find((item: { id: string }) => item.id === "cliproxyapi")?.capabilities)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ capability: "summary", currentReadiness: expect.objectContaining({ status: "ready" }) }),
        expect.objectContaining({ capability: "conversation", currentReadiness: expect.objectContaining({ status: "untested" }) }),
      ]));
    await expect(caller.select({ connectionId: "cliproxyapi", capability: "conversation" }))
      .rejects.toThrow(/Test this exact CLIProxyAPI Conversation model/i);
    await caller.probe({ connectionId: "cliproxyapi", capability: "conversation" });
    await caller.select({ connectionId: "cliproxyapi", capability: "summary" });
    await caller.select({ connectionId: "cliproxyapi", capability: "conversation" });
    view = await caller.view();
    expect(view.selections).toMatchObject({
      summary: { connectionId: "cliproxyapi", model: "gateway-summary-exact" },
      conversation: { connectionId: "cliproxyapi", model: "gateway-conversation-exact" },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("cliproxyapi", "summary"))
      .toEqual([expect.objectContaining({
        status: "ready",
        reason: null,
        runtimeEvidence: expect.objectContaining({
          endpoint: "http://127.0.0.1:8317/v1",
          requestedProvider: null,
          actualProvider: null,
          requestedModel: "gateway-summary-exact",
          fallbackOccurred: false,
          toolsEnabled: false,
        }),
      })]);
    setupResult.host.close();
  });

  it("runs Gateway Summary from the pinned task endpoint after the connection is edited", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "xai", model: "grok-summary" },
        conversation: { provider: "xai", model: "grok-conversation" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.saveGateway({
      endpoint: "http://127.0.0.1:8317/v1",
      summaryModel: "gateway-summary-exact",
      conversationModel: "gateway-conversation-exact",
      inferenceKey: "first-task-key",
      httpsApproved: true,
      confirmed: true,
    });
    await caller.acceptDisclosure({ connectionId: "cliproxyapi", capability: "summary" });
    await caller.probe({ connectionId: "cliproxyapi", capability: "summary" });
    await caller.select({ connectionId: "cliproxyapi", capability: "summary" });
    const firstRecord = setupResult.host.listAgentConnectionRecords()
      .find((record) => record.id === "cliproxyapi")!;
    const firstCredentialIdentity = String(firstRecord.settings.credentialIdentity ?? "");
    expect(firstRecord.settings.httpsApproved).toBe(false);
    expect(firstRecord.settings.credentialRevisions).toEqual([
      expect.objectContaining({ credentialIdentity: firstCredentialIdentity, httpsApproved: false }),
    ]);
    const task = setupResult.host.enqueueRecording({
      idempotencyKey: "recording:gateway-summary-production",
      recordingStem: "Gateway_20260827_210000",
      title: "Gateway production Summary",
      audioPath: join(setupResult.root, "Gateway_20260827_210000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "cliproxyapi",
      summaryProvider: "cliproxyapi",
      summaryModel: "gateway-summary-exact",
      summaryConnectionId: "cliproxyapi",
      summaryCredentialClass: "api-key",
      summaryCredentialIdentity: firstCredentialIdentity,
      summaryDisclosureVersion: "cliproxyapi-summary-v1",
      summaryEndpointIdentity: "http://127.0.0.1:8317/v1",
      instructions: "Use only the committed transcript.",
    }).task;

    await caller.saveGateway({
      endpoint: "http://127.0.0.1:9417/v1",
      summaryModel: "edited-summary-model",
      conversationModel: "edited-conversation-model",
      inferenceKey: "replacement-task-key",
      httpsApproved: false,
      confirmed: true,
    });
    const secondCredentialIdentity = String(
      setupResult.host.listAgentConnectionRecords().find((record) => record.id === "cliproxyapi")
        ?.settings.credentialIdentity ?? "",
    );
    expect(secondCredentialIdentity).not.toBe(firstCredentialIdentity);
    expect(setupResult.gatewayKeys.get(firstCredentialIdentity) === "first-task-key").toBe(true);
    expect(setupResult.gatewayKeys.get(secondCredentialIdentity) === "replacement-task-key").toBe(true);
    expect(setupResult.host.getAgentConnectionDisclosure("cliproxyapi", "summary")).toBeNull();
    expect(setupResult.host.getAgentConnectionDisclosure("cliproxyapi", "conversation")).toBeNull();
    expect(setupResult.configManager.read().intelligence.summary).toEqual({
      provider: "agent",
      model: "runtime-managed",
    });
    await caller.probe({ connectionId: "cliproxyapi", capability: "summary" });
    setupResult.host.recordAgentConnectionDisclosure({
      connectionId: "cliproxyapi",
      capability: "summary",
      disclosureVersion: "cliproxyapi-summary-v1",
      decision: "accepted",
    });
    await expect(caller.select({ connectionId: "cliproxyapi", capability: "summary" }))
      .rejects.toThrow(/endpoint.*disclosure|disclosure.*endpoint/i);
    setupResult.cliProxyAdapter.mockClear();
    setupResult.gateway.summarize.mockClear();
    setupResult.gateway.probe.mockClear();

    const restartedCenter = setupResult.makeCenter();
    expect(restartedCenter.summaryAdapter().current({
      connectionId: "cliproxyapi",
      provider: "cliproxyapi",
      model: "gateway-summary-exact",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: firstCredentialIdentity,
    })).toMatchObject({
      status: "untested",
      detail: expect.stringMatching(/exact production preflight/i),
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: firstCredentialIdentity,
    });
    const gateway = restartedCenter.summaryAdapter().gateway(setupResult.configManager.read(), {
      connectionId: "cliproxyapi",
      provider: "cliproxyapi",
      model: "gateway-summary-exact",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: firstCredentialIdentity,
    });
    const claimed = setupResult.host.claim(task.id)!;
    const transcriptArtifact = {
      id: "gateway-production-transcript",
      taskId: task.id,
      recordingStem: task.recordingStem,
      kind: "transcript" as const,
      path: join(setupResult.root, "Gateway_20260827_210000.transcript.txt"),
      sha256: "a".repeat(64),
      bytes: 41,
      mimeType: "text/plain",
      provenance: { transcriptionProvider: "local" },
      createdAt: new Date().toISOString(),
    };
    setupResult.host.recordTranscript(task.id, claimed.leaseToken!, transcriptArtifact);
    const pinnedTask = setupResult.host.recordSummaryInputSnapshot(
      task.id,
      claimed.leaseToken!,
      transcriptArtifact,
    );
    await expect(gateway.runArtifactWorkflow({
      task: pinnedTask,
      leaseToken: claimed.leaseToken!,
      workspace: {
        dir: join(setupResult.root, "private-stage"),
        transcriptPath: join(setupResult.root, "private-stage", "transcript.txt"),
        summaryPath: join(setupResult.root, "private-stage", "summary.md"),
        chunkPattern: join(setupResult.root, "private-stage", "audio-%03d.wav"),
      },
      transcriptionProvider: "local",
      committedTranscript: "Only Host-read committed transcript text.",
    })).resolves.toMatchObject({
      nativeSessionId: "summary-request",
      summary: "# Gateway Summary",
      summaryIdentity: { provider: "cliproxyapi", model: "gateway-summary-exact" },
      runtimeEvidence: expect.objectContaining({
        endpoint: "http://127.0.0.1:8317/v1",
        toolsEnabled: false,
        fallbackOccurred: false,
      }),
      audit: { toolNames: [], notionWrite: false },
    });
    expect(setupResult.cliProxyAdapter).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      credentialIdentity: firstCredentialIdentity,
    });
    expect(setupResult.gateway.summarize).toHaveBeenCalledWith({
      model: "gateway-summary-exact",
      instructions: "Use only the committed transcript.",
      transcript: "Only Host-read committed transcript text.",
    });
    expect(setupResult.host.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "gateway.summary_preflight_intent" }),
      expect.objectContaining({ type: "gateway.summary_dispatch_intent" }),
    ]));
    expect(setupResult.gateway.probe).toHaveBeenCalledWith({
      capability: "summary",
      model: "gateway-summary-exact",
    });
    setupResult.cliProxyAdapter.mockClear();
    await expect(setupResult.center.converseGateway({
      connectionId: "cliproxyapi",
      endpointIdentity: "https://attacker.example/v1",
      credentialIdentity: firstCredentialIdentity,
      model: "gateway-conversation-exact",
      input: [{ role: "user", content: "Never send the old key here" }],
    })).rejects.toThrow(/endpoint.*credential revision|credential revision.*endpoint/i);
    expect(setupResult.cliProxyAdapter).not.toHaveBeenCalled();
    await restartedCenter.converseGateway({
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      credentialIdentity: firstCredentialIdentity,
      model: "gateway-conversation-exact",
      input: [{ role: "user", content: "Pinned old endpoint conversation" }],
    });
    expect(setupResult.cliProxyAdapter).toHaveBeenCalledWith({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      credentialIdentity: firstCredentialIdentity,
    });
    expect(JSON.stringify(setupResult.host.listAgentConnectionRecords()).includes("replacement-task-key")).toBe(false);
    setupResult.host.close();
  });

  it("deletes only the Yulu CLIProxyAPI record and client key while preserving pinned work", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", connectionId: "cliproxyapi", model: "gateway-summary-exact" },
        conversation: { provider: "agent", connectionId: "cliproxyapi", model: "gateway-conversation-exact" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);
    await caller.saveGateway({
      endpoint: "http://127.0.0.1:8317/v1",
      summaryModel: "gateway-summary-exact",
      conversationModel: "gateway-conversation-exact",
      inferenceKey: "deletion-key-never-project",
      httpsApproved: false,
      confirmed: true,
    });
    setupResult.host.enqueueRecording({
      idempotencyKey: "recording:pinned-gateway",
      recordingStem: "Pinned_Gateway_20260827_220000",
      title: "Pinned Gateway task",
      audioPath: join(setupResult.root, "Pinned_Gateway_20260827_220000.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "cliproxyapi",
      summaryProvider: "cliproxyapi",
      summaryModel: "gateway-summary-exact",
      summaryConnectionId: "cliproxyapi",
      summaryCredentialClass: "api-key",
      summaryDisclosureVersion: "cliproxyapi-summary-v1",
      summaryEndpointIdentity: "http://127.0.0.1:8317/v1",
    });
    const session = createAgentSession(setupResult.root, {
      provider: "cliproxyapi",
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      model: "gateway-conversation-exact",
      credentialSource: "api-key",
      disclosureVersion: "cliproxyapi-conversation-v2",
      title: "Pinned Gateway conversation",
    });

    await expect(caller.deletionImpact({ connectionId: "cliproxyapi" })).resolves.toMatchObject({
      connectionId: "cliproxyapi",
      selectedCapabilities: ["summary", "conversation"],
      pinnedTasks: [expect.objectContaining({ title: "Pinned Gateway task" })],
      pinnedConversations: [expect.objectContaining({ id: session.id })],
      removesRuntimeAuthorization: false,
      removesYuluManagedCredentials: true,
    });
    await caller.remove({ connectionId: "cliproxyapi", confirmed: true });
    expect(setupResult.gatewaySecretClear).toHaveBeenCalledOnce();
    expect(setupResult.credentials.logout).not.toHaveBeenCalled();
    expect(setupResult.credentials.clearApiKey).not.toHaveBeenCalled();
    expect(setupResult.host.listAgentConnectionRecords().find((record) => record.id === "cliproxyapi"))
      .toBeUndefined();
    expect(setupResult.host.listTasks(100)).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: "Pinned Gateway task", summaryEndpointIdentity: "http://127.0.0.1:8317/v1" }),
    ]));
    expect(readAgentSessionStore(setupResult.root).sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: session.id, endpointIdentity: "http://127.0.0.1:8317/v1" }),
    ]));
    expect(JSON.stringify(await caller.view()).includes("deletion-key-never-project")).toBe(false);
    setupResult.host.close();
  });

  it("merges concurrent Gateway saves without orphaning either immutable credential revision", async () => {
    const setupResult = setup({
      audio: {},
      transcription: { engine: "local", language: "zh" },
      intelligence: {
        summary: { provider: "agent", model: "runtime-managed" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "auto" } },
    });
    const caller = createCaller(agentConnectionsRouter, {
      agentConnections: setupResult.center,
      uiMutationAuthorized: true,
    } as never);

    await Promise.all([
      caller.saveGateway({
        endpoint: "http://127.0.0.1:8317/v1",
        summaryModel: "summary-a",
        conversationModel: "conversation-a",
        inferenceKey: "concurrent-key-a",
        httpsApproved: false,
        confirmed: true,
      }),
      caller.saveGateway({
        endpoint: "http://127.0.0.1:9417/v1",
        summaryModel: "summary-b",
        conversationModel: "conversation-b",
        inferenceKey: "concurrent-key-b",
        httpsApproved: false,
        confirmed: true,
      }),
    ]);

    const record = setupResult.host.listAgentConnectionRecords()
      .find((candidate) => candidate.id === "cliproxyapi")!;
    expect(record.settings.credentialRevisions).toHaveLength(2);
    expect(setupResult.gatewayKeys.size).toBe(2);
    await caller.remove({ connectionId: "cliproxyapi", confirmed: true });
    expect(setupResult.gatewaySecretClear).toHaveBeenCalledTimes(2);
    expect(setupResult.gatewayKeys.size).toBe(0);
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
          requestedModel: "gpt-5.6-sol",
          actualModel: "gpt-5.6-sol",
          fallbackOccurred: false,
        }),
      }),
    ]);
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
      capabilities: ["conversation"],
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
      .toMatchObject({ declared: false, currentReadiness: { status: "untested" } });
    await expect(caller.view()).resolves.toMatchObject({
      selections: { conversation: { connectionId: "claude-code", model: "claude-sonnet-5" } },
    });
    expect(setupResult.host.listAgentConnectionReadinessHistory("claude-code", "conversation")).toEqual([
      expect.objectContaining({
        status: "ready",
        runtimeEvidence: expect.objectContaining({
          adapter: "claude-code",
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
          declared: false,
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
          requestedProvider: null,
          actualProvider: null,
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
      .toEqual(["conversation"]);
    await caller.confirmCandidate({ candidateId: "candidate:codex", model: "gpt-5.6-sol" });
    const before = await caller.view();
    const codex = before.connections.find((connection: { id: string }) => connection.id === "codex");
    expect(codex.capabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({
        capability: "summary",
        declared: false,
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
        capabilities: ["conversation"],
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
    await expect(unauthorized.saveGateway({
      endpoint: "http://127.0.0.1:8317/v1",
      summaryModel: "gateway-summary-exact",
      conversationModel: "gateway-conversation-exact",
      inferenceKey: "must-not-be-written",
      httpsApproved: false,
      confirmed: true,
    })).rejects.toThrow("UI mutation bearer required");
    expect(setupResult.gatewaySecretWrite).not.toHaveBeenCalled();
    await expect(unauthorized.select({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    })).rejects.toThrow("UI mutation bearer required");
    await expect(unauthorized.selectCredentialSource({
      connectionId: "direct-xai",
      credentialSource: "api-key",
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
});
