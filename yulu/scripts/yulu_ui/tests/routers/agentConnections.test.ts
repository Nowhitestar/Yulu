import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigManager } from "../../src/config.js";
import { HostStore } from "../../src/hostStore.js";
import { AgentConnectionCenter } from "../../src/agentConnections.js";
import { agentConnectionsRouter } from "../../src/routers/agentConnections.js";
import { createCaller } from "../../src/trpc.js";
import { createAgentSession } from "../../src/agentSessionStore.js";

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
  const center = new AgentConnectionCenter({
    config: new ConfigManager(configPath),
    host,
    configDir: root,
    credentials,
    audio,
    text,
    discover,
    codexAdapter,
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
    }),
    discover,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public Agent Connection Host contract", () => {
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
