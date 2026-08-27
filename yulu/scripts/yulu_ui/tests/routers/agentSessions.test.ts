import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentSessionsRouter } from "../../src/routers/agentSessions.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { updateAgentSessionNativeSession } from "../../src/agentSessionStore.js";
import {
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
} from "../../src/conversationDataDisclosure.js";

function makeCtx(configDir: string, config: Record<string, unknown> = {
  intelligence: { conversation: { provider: "agent", model: "runtime-managed" } },
  llm: { enabled: true, command: ["codex"] },
}): AppContext {
  return {
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
