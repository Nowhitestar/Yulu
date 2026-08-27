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
  const center = new AgentConnectionCenter({
    config: new ConfigManager(configPath),
    host,
    configDir: root,
    credentials,
    audio,
    text,
    discover,
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
    }),
    discover,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public Agent Connection Host contract", () => {
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
