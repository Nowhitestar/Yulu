import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentSessionsRouter } from "../../src/routers/agentSessions.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { updateAgentSessionNativeSession } from "../../src/agentSessionStore.js";

function makeCtx(configDir: string): AppContext {
  return {
    paths: { configDir },
  } as unknown as AppContext;
}

describe("agentSessionsRouter", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("creates, lists, and reads sessions by selected Agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-sessions-"));
    roots.push(root);
    const caller = createCaller(agentSessionsRouter, makeCtx(root));

    const codex = await caller.create({ agent: "codex", title: "本周产品会怎么推进？" });
    const claude = await caller.create({ agent: "claude", title: "Claude session" });
    await caller.append({ sessionId: codex.id, message: { role: "user", text: "本周产品会怎么推进？" } });
    await caller.append({ sessionId: codex.id, message: { role: "assistant", text: "**结论**：继续推进。", sources: [{ title: "Product Weekly", url: "/inbox/a" }] } });

    const codexList = await caller.list({ agent: "codex" });
    expect(codexList.sessions).toHaveLength(1);
    expect(codexList.sessions[0]).toMatchObject({
      id: codex.id,
      agent: "codex",
      title: "本周产品会怎么推进？",
      messageCount: 2,
    });

    const all = await caller.list();
    expect(all.sessions.map((session: { id: string }) => session.id).sort()).toEqual([claude.id, codex.id].sort());

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
