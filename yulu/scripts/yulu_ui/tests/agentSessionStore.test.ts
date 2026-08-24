import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentSessionMessage,
  createAgentSession,
  getAgentSession,
  pauseAgentSession,
  readAgentSessionStore,
  resumeAgentSession,
  storePath,
  updateAgentSessionNativeSession,
} from "../src/agentSessionStore.js";

describe("agentSessionStore", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("migrates legacy ask sessions once without losing local history or sources", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    writeFileSync(storePath(root), JSON.stringify({
      version: 1,
      sessions: [{
        id: "legacy-session",
        agent: "codex",
        purpose: "ask",
        title: "Legacy conversation",
        createdAt: "2026-08-24T10:00:00.000Z",
        updatedAt: "2026-08-24T10:01:00.000Z",
        pinnedAt: "2026-08-24T10:02:00.000Z",
        nativeSessionId: "native-session",
        messages: [{
          id: "message-1",
          role: "assistant",
          text: "Legacy answer",
          createdAt: "2026-08-24T10:01:00.000Z",
          sources: [{ title: "Weekly", url: "/inbox/weekly" }],
        }],
      }],
    }));

    const session = readAgentSessionStore(root).sessions[0]!;
    expect(session).toMatchObject({
      agent: "codex",
      provider: "codex",
      model: "runtime-managed",
      status: "active",
      pinnedAt: "2026-08-24T10:02:00.000Z",
      nativeSessionId: "native-session",
      messages: [{
        text: "Legacy answer",
        sources: [{ title: "Weekly", url: "/inbox/weekly" }],
      }],
    });

    const migrated = JSON.parse(readFileSync(storePath(root), "utf8"));
    expect(migrated).toMatchObject({
      version: 2,
      sessions: [{ provider: "codex", model: "runtime-managed", status: "active" }],
    });
    expect(readFileSync(storePath(root), "utf8")).toBe(JSON.stringify(migrated, null, 2) + "\n");
  });

  it("pins an ask session provider and model while persisting its local history", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "xai",
      model: "grok-4.6-exact",
      title: "Pinned conversation",
    });

    appendAgentSessionMessage(root, created.id, {
      role: "assistant",
      text: "Pinned answer",
      sources: [{ title: "Roadmap", url: "/inbox/roadmap" }],
    });
    updateAgentSessionNativeSession(root, created.id, { nativeSessionId: "native-session" });

    expect(getAgentSession(root, created.id)).toMatchObject({
      agent: "xai",
      provider: "xai",
      model: "grok-4.6-exact",
      status: "active",
      nativeSessionId: "native-session",
      messages: [{
        text: "Pinned answer",
        sources: [{ title: "Roadmap", url: "/inbox/roadmap" }],
      }],
    });
  });

  it("pauses and resumes a conversation without changing its identity or history", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "xai",
      model: "grok-4.6-exact",
    });
    appendAgentSessionMessage(root, created.id, { role: "user", text: "Keep this question" });

    const paused = pauseAgentSession(root, created.id, "model unavailable ".repeat(100));
    expect(paused).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      messages: [{ text: "Keep this question" }],
    });
    expect(paused.pausedReason).toHaveLength(1000);
    expect(getAgentSession(root, created.id)).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      pausedReason: paused.pausedReason,
    });

    const resumed = resumeAgentSession(root, created.id);
    expect(resumed).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "active",
      messages: [{ text: "Keep this question" }],
    });
    expect(resumed.pausedReason).toBeUndefined();
  });
});
