import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentSessionsRouter } from "../../src/routers/agentSessions.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { updateAgentSessionNativeSession } from "../../src/agentSessionStore.js";
import {
  CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
  CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  HERMES_CONVERSATION_DISCLOSURE_VERSION,
  OPENCLAW_CONVERSATION_DISCLOSURE_VERSION,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
} from "../../src/conversationDataDisclosure.js";

function makeCtx(configDir: string, config: Record<string, unknown> = {
  intelligence: { conversation: { provider: "agent", model: "runtime-managed" } },
  llm: { enabled: true, command: ["codex"] },
}): AppContext {
  return {
    uiMutationAuthorized: true,
    paths: { configDir },
    config: { read: () => config },
    xaiCredentials: { status: async () => ({ connected: true, source: "oauth" }) },
    host: {
      listAgentConnectionRecords: () => [{
        id: "codex",
        kind: "supported-agent",
        adapter: "codex",
        label: "Codex",
        lifecycle: "available",
        settings: { executablePath: "/fake/codex", conversationModel: "gpt-5.6-sol" },
      }, {
        id: "claude-code",
        kind: "supported-agent",
        adapter: "claude-code",
        label: "Claude Code",
        lifecycle: "available",
        settings: { executablePath: "/fake/claude", conversationModel: "claude-sonnet-5" },
      }, {
        id: "hermes",
        kind: "supported-agent",
        adapter: "hermes",
        label: "Hermes",
        lifecycle: "available",
        settings: { executablePath: "/fake/hermes", conversationModel: "grok-4.6" },
      }, {
        id: "openclaw",
        kind: "supported-agent",
        adapter: "openclaw",
        label: "OpenClaw",
        lifecycle: "available",
        settings: { executablePath: "/fake/openclaw", conversationModel: "openai-codex/gpt-5.5" },
      }, {
        id: "cliproxyapi",
        kind: "gateway",
        adapter: "cliproxyapi",
        label: "CLIProxyAPI",
        lifecycle: "available",
        settings: {
          endpoint: "http://127.0.0.1:8317/v1",
          httpsApproved: false,
          conversationModel: "gateway-conversation-exact",
          credentialClass: "api-key",
          credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
          conversationDisclosureIdentity: {
            endpoint: "http://127.0.0.1:8317/v1",
            credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
          },
        },
      }],
      getAgentConnectionDisclosure: () => ({
        connectionId: "direct-xai",
        capability: "conversation",
        disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
        decidedAt: "2026-08-27T00:00:00.000Z",
      }),
    },
  } as unknown as AppContext;
}

describe("agentSessionsRouter", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates, lists, and reads sessions using the server-selected Agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const caller = createCaller(agentSessionsRouter, makeCtx(root));

    const codex = await caller.create({ agent: "codex", title: "本周产品会怎么推进？" });
    const second = await caller.create({ agent: "malicious-browser-value", title: "Second session" });
    await caller.append({ sessionId: codex.id, message: { role: "user", text: "本周产品会怎么推进？" } });
    await caller.append({ sessionId: codex.id, message: { role: "assistant", text: "**结论**：继续推进。", sources: [{ title: "Product Weekly", url: "/inbox/a" }] } });

    const codexList = await caller.list({ agent: "codex" });
    expect(codexList.sessions).toHaveLength(2);
    expect(codexList.sessions[0]).toMatchObject({
      id: codex.id,
      agent: "codex",
      title: "本周产品会怎么推进？",
      messageCount: 2,
    });

    const all = await caller.list();
    expect(all.sessions.map((session: { id: string }) => session.id).sort()).toEqual([second.id, codex.id].sort());
    expect(all.sessions.every((session: { provider: string; model: string }) =>
      session.provider === "codex" && session.model === "runtime-managed"
    )).toBe(true);

    const saved = await caller.get({ id: codex.id });
    expect(saved.messages).toHaveLength(2);
    expect(saved.messages[1]).toMatchObject({
      role: "assistant",
      text: "**结论**：继续推进。",
      sources: [{ title: "Product Weekly", url: "/inbox/a" }],
    });
  });

  it("renames a blank session from the first user message", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const caller = createCaller(agentSessionsRouter, makeCtx(root));

    const session = await caller.create({ agent: "codex" });
    expect(session.title).toBe("新对话");

    const updated = await caller.append({ sessionId: session.id, message: { role: "user", text: "列出 Bruce 最近的重点" } });
    expect(updated.title).toBe("列出 Bruce 最近的重点");
  });

  it("persists a provider-native session id on a Yulu session", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const caller = createCaller(agentSessionsRouter, makeCtx(root));
    const session = await caller.create({ agent: "codex", title: "Native session" });

    updateAgentSessionNativeSession(root, session.id, {
      nativeSessionId: "019f0000-0000-7000-8000-000000000001",
      runtimeLabel: "Codex",
    });

    const saved = await caller.get({ id: session.id });
    expect(saved).toMatchObject({
      id: session.id,
      nativeSessionId: "019f0000-0000-7000-8000-000000000001",
      runtimeLabel: "Codex",
    });
  });

  it("requires the separate conversation disclosure before pinning the exact xAI identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const config = {
      intelligence: { conversation: { provider: "xai", model: "grok-4.6-exact" } },
      llm: { enabled: true, command: ["codex"] },
    };
    const ctx = makeCtx(root, config);
    let accepted = false;
    ctx.host.getAgentConnectionDisclosure = () => accepted ? {
      connectionId: "direct-xai",
      capability: "conversation",
      disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-08-27T00:00:00.000Z",
    } : null;
    const caller = createCaller(agentSessionsRouter, ctx);

    await expect(caller.create({ agent: "codex", title: "Pinned xAI" }))
      .rejects.toThrow("conversation data path disclosure");
    accepted = true;

    const session = await caller.create({ agent: "codex", title: "Pinned xAI" });
    expect(session).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      credentialSource: "oauth",
      status: "active",
    });

    config.intelligence.conversation = { provider: "agent", model: "runtime-managed" };
    expect(await caller.get({ id: session.id })).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      credentialSource: "oauth",
    });
  });

  it("snapshots the exact Codex connection and model for each new conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const config = {
      intelligence: {
        conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const ctx = makeCtx(root, config);
    const assertCodexConversationReady = vi.fn(async () => undefined);
    ctx.agentConnections = { assertCodexConversationReady } as never;
    let accepted = false;
    ctx.host.getAgentConnectionDisclosure = () => accepted ? {
      connectionId: "codex",
      capability: "conversation",
      disclosureVersion: CODEX_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-08-27T00:00:00.000Z",
    } : null;
    const caller = createCaller(agentSessionsRouter, ctx);

    await expect(caller.create({ title: "Pinned Codex" }))
      .rejects.toThrow("Codex Conversation data path disclosure");
    accepted = true;
    const created = await caller.create({ title: "Pinned Codex" });
    expect(created).toMatchObject({
      provider: "codex",
      connectionId: "codex",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
    });
    expect(created.nativeSessionId).toBeUndefined();
    expect(assertCodexConversationReady).toHaveBeenCalledWith({
      connectionId: "codex",
      model: "gpt-5.6-sol",
    });

    config.intelligence.conversation = { provider: "xai", model: "grok-future" } as never;
    expect(await caller.get({ id: created.id })).toMatchObject({
      provider: "codex",
      connectionId: "codex",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
    });
  });

  it("refuses a new Codex conversation when current exact readiness is stale", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const config = {
      intelligence: {
        conversation: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const ctx = makeCtx(root, config);
    ctx.host.getAgentConnectionDisclosure = () => ({
      connectionId: "codex",
      capability: "conversation",
      disclosureVersion: CODEX_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-08-27T00:00:00.000Z",
    });
    ctx.agentConnections = {
      assertCodexConversationReady: vi.fn(async () => {
        throw new Error("Test this exact Codex Conversation model before starting a new conversation");
      }),
    } as never;

    await expect(createCaller(agentSessionsRouter, ctx).create({ title: "No stale proof" }))
      .rejects.toThrow(/test this exact Codex Conversation model/i);
    await expect(createCaller(agentSessionsRouter, ctx).list()).resolves.toEqual({ sessions: [] });
  });

  it("snapshots the exact Claude Code connection and model for each new conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const config = {
      intelligence: {
        conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" },
      },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const ctx = makeCtx(root, config);
    const assertClaudeConversationReady = vi.fn(async () => undefined);
    ctx.agentConnections = { assertClaudeConversationReady } as never;
    ctx.host.getAgentConnectionDisclosure = () => ({
      connectionId: "claude-code",
      capability: "conversation",
      disclosureVersion: CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-08-27T00:00:00.000Z",
    });

    const created = await createCaller(agentSessionsRouter, ctx).create({ title: "Pinned Claude" });
    expect(created).toMatchObject({
      provider: "claude-code",
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      credentialSource: "runtime-oauth",
      runtimeLabel: "Claude Code",
    });
    expect(created.nativeSessionId).toBeUndefined();
    expect(assertClaudeConversationReady).toHaveBeenCalledWith({
      connectionId: "claude-code",
      model: "claude-sonnet-5",
    });

    config.intelligence.conversation = {
      provider: "agent",
      connectionId: "codex",
      model: "gpt-5.6-sol",
    } as never;
    expect(await createCaller(agentSessionsRouter, ctx).get({ id: created.id })).toMatchObject({
      provider: "claude-code",
      connectionId: "claude-code",
      model: "claude-sonnet-5",
    });
  });

  it.each([
    ["hermes", "Hermes", "grok-4.6", HERMES_CONVERSATION_DISCLOSURE_VERSION],
    ["openclaw", "OpenClaw", "openai-codex/gpt-5.5", OPENCLAW_CONVERSATION_DISCLOSURE_VERSION],
  ] as const)("snapshots the exact %s Conversation connection after current disclosure and readiness", async (
    adapter,
    runtimeLabel,
    model,
    disclosureVersion,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const config = {
      intelligence: { conversation: { provider: "agent", connectionId: adapter, model } },
      llm: { enabled: false, command: null, agent: { provider: "auto" } },
    };
    const ctx = makeCtx(root, config);
    const runtimeProvider = adapter === "hermes" ? "xai" : "openai-codex";
    const assertConversationOnlyReady = vi.fn(async () => runtimeProvider);
    ctx.agentConnections = { assertConversationOnlyReady } as never;
    let accepted = false;
    ctx.host.getAgentConnectionDisclosure = () => accepted ? {
      connectionId: adapter,
      capability: "conversation",
      disclosureVersion,
      decision: "accepted",
      decidedAt: "2026-08-28T00:00:00.000Z",
    } : null;
    const caller = createCaller(agentSessionsRouter, ctx);

    await expect(caller.create({ title: `${runtimeLabel} disclosure` }))
      .rejects.toThrow(`${runtimeLabel} Conversation data path disclosure`);
    accepted = true;
    const created = await caller.create({ title: `${runtimeLabel} pinned` });

    expect(created).toMatchObject({
      provider: adapter,
      connectionId: adapter,
      model,
      credentialSource: "runtime-oauth",
      runtimeLabel,
      runtimeProvider,
      disclosureVersion,
    });
    expect(created.nativeSessionId).toBeUndefined();
    expect(assertConversationOnlyReady).toHaveBeenCalledWith({
      connectionId: adapter,
      model,
    });
  });

  it("rejects browser mutations without the UI mutation bearer", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const ctx = makeCtx(root);
    ctx.uiMutationAuthorized = false;

    await expect(createCaller(agentSessionsRouter, ctx).create({ title: "Unauthorized" }))
      .rejects.toThrow("UI mutation bearer required");
  });

  it("snapshots the Gateway endpoint, model, credential class, and disclosure for a new conversation", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
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
    const ctx = makeCtx(root, config);
    const assertGatewayConversationReady = vi.fn(async () => undefined);
    ctx.agentConnections = { assertGatewayConversationReady } as never;
    let accepted = false;
    ctx.host.getAgentConnectionDisclosure = () => accepted ? {
      connectionId: "cliproxyapi",
      capability: "conversation",
      disclosureVersion: CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-08-27T00:00:00.000Z",
    } : null;
    const caller = createCaller(agentSessionsRouter, ctx);

    await expect(caller.create({ title: "Pinned Gateway" }))
      .rejects.toThrow("CLIProxyAPI Conversation data path disclosure");
    accepted = true;
    const created = await caller.create({ title: "Pinned Gateway" });
    expect(created).toMatchObject({
      provider: "cliproxyapi",
      connectionId: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      model: "gateway-conversation-exact",
      credentialSource: "api-key",
      credentialIdentity: "gateway.cliproxyapi.00000000-0000-4000-8000-000000000137",
      disclosureVersion: CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
      runtimeLabel: "CLIProxyAPI",
    });
    expect(assertGatewayConversationReady).toHaveBeenCalledWith({
      connectionId: "cliproxyapi",
      model: "gateway-conversation-exact",
    });

    config.intelligence.conversation = {
      provider: "agent",
      connectionId: "codex",
      model: "gpt-5.6-sol",
    } as never;
    expect(await caller.get({ id: created.id })).toMatchObject({
      provider: "cliproxyapi",
      endpointIdentity: "http://127.0.0.1:8317/v1",
      model: "gateway-conversation-exact",
    });
  });

  it("renames, pins, archives, and deletes sessions", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const caller = createCaller(agentSessionsRouter, makeCtx(root));

    const first = await caller.create({ agent: "codex", title: "First" });
    const second = await caller.create({ agent: "codex", title: "Second" });

    await caller.rename({ id: first.id, title: "Renamed" });
    await caller.pin({ id: first.id, pinned: true });
    let list = await caller.list({ agent: "codex" });
    expect(list.sessions[0]).toMatchObject({ id: first.id, title: "Renamed" });

    await caller.archive({ id: first.id, archived: true });
    list = await caller.list({ agent: "codex" });
    expect(list.sessions.map((session: { id: string }) => session.id)).toEqual([second.id]);

    await caller.delete({ id: second.id });
    list = await caller.list({ agent: "codex" });
    expect(list.sessions).toEqual([]);
  });
});
