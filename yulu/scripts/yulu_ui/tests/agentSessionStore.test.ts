import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendAgentSessionMessage,
  beginAgentSessionInvocation,
  createAgentSessionAttemptFromUnknown,
  createAgentSession,
  getAgentSession,
  pauseAgentSession,
  projectAgentSessionHistory,
  readAgentSessionStore,
  recoverInterruptedAgentSessionInvocations,
  retireAgentSessionsForConnection,
  resumeAgentSession,
  storePath,
  summarizeAgentSession,
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
      version: 8,
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
      credentialSource: "oauth",
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
      credentialSource: "oauth",
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

    const paused = pauseAgentSession(root, created.id, "model unavailable ".repeat(100), {
      question: "Keep this question",
      sources: [{
        ref: 1,
        kind: "meeting_summary",
        stem: "Weekly_20260824_100000",
        title: "Weekly",
        recordedAt: "2026-08-24T10:00:00",
        sourcePath: "/private/weekly.summary.md",
        snippet: "Pinned evidence",
        url: "/inbox/Weekly_20260824_100000",
      }],
    });
    expect(paused).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      retrySnapshot: {
        question: "Keep this question",
        sources: [{ snippet: "Pinned evidence" }],
      },
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
    expect(resumed.retrySnapshot).toBeUndefined();
  });

  it("projects pinned identity and pause status in conversation summaries", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "xai",
      model: "grok-4.6-exact",
    });
    const paused = pauseAgentSession(root, created.id, "selected model unavailable");

    expect(summarizeAgentSession(paused)).toMatchObject({
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      pausedReason: "selected model unavailable",
    });
  });

  it("retires sessions for a removed connection without replaying or deleting history", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const retired = createAgentSession(root, {
      purpose: "ask",
      provider: "cliproxyapi",
      connectionId: "cliproxyapi",
      model: "retired-model",
      title: "Retired conversation",
    });
    appendAgentSessionMessage(root, retired.id, { role: "user", text: "Preserve this local history" });
    pauseAgentSession(root, retired.id, "temporarily unavailable", {
      question: "Do not replay this input",
      sources: [],
    });
    const supported = createAgentSession(root, {
      purpose: "ask",
      provider: "codex",
      connectionId: "codex",
      model: "gpt-5.6-sol",
      title: "Supported conversation",
    });

    expect(retireAgentSessionsForConnection(root, "cliproxyapi")).toEqual([retired.id]);
    expect(retireAgentSessionsForConnection(root, "cliproxyapi")).toEqual([]);
    expect(getAgentSession(root, retired.id)).toMatchObject({
      status: "paused",
      connectionId: "cliproxyapi",
      pausedReason: expect.stringContaining("retired"),
      messages: [{ text: "Preserve this local history" }],
    });
    expect(getAgentSession(root, retired.id)).not.toHaveProperty("retrySnapshot");
    expect(getAgentSession(root, supported.id)).toMatchObject({ status: "active", connectionId: "codex" });
  });

  it("recovers a dispatched Conversation as Unknown Outcome and creates only an explicit new attempt", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "codex",
      connectionId: "codex-primary",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
      disclosureVersion: "codex-conversation-v1",
      title: "Pinned conversation",
    });
    updateAgentSessionNativeSession(root, created.id, { nativeSessionId: "thread-original" });
    const invocation = beginAgentSessionInvocation(root, created.id, {
      question: "Preserve this exact input",
      sources: [],
    }, {
      kind: "prompt",
      prompt: "Exact outbound Codex prompt",
    });

    expect(recoverInterruptedAgentSessionInvocations(root)).toEqual([created.id]);
    expect(getAgentSession(root, created.id)).toMatchObject({
      status: "paused",
      provider: "codex",
      connectionId: "codex-primary",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
      disclosureVersion: "codex-conversation-v1",
      nativeSessionId: "thread-original",
      unknownOutcome: {
        executionId: invocation.executionId,
        inputSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        snapshot: { question: "Preserve this exact input", sources: [] },
        providerInput: { kind: "prompt", prompt: "Exact outbound Codex prompt" },
      },
    });
    expect(getAgentSession(root, created.id)).not.toHaveProperty("retrySnapshot");

    const replacement = createAgentSessionAttemptFromUnknown(root, created.id);
    expect(replacement).toMatchObject({
      status: "paused",
      provider: "codex",
      connectionId: "codex-primary",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth",
      disclosureVersion: "codex-conversation-v1",
      supersedesSessionId: created.id,
      retrySnapshot: { question: "Preserve this exact input", sources: [] },
      retryProviderInput: { kind: "prompt", prompt: "Exact outbound Codex prompt" },
    });
    expect(replacement.nativeSessionId).toBeUndefined();
    expect(getAgentSession(root, created.id)?.unknownOutcome?.executionId).toBe(invocation.executionId);
  });

  it("rejects an explicit replacement when the preserved provider input was corrupted", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "xai",
      model: "grok-4.6-exact",
      credentialSource: "oauth",
    });
    const invocation = beginAgentSessionInvocation(root, created.id, {
      question: "Preserve this exact input",
      sources: [],
    }, {
      kind: "messages",
      messages: [{ role: "user", content: "Original provider payload" }],
    });
    recoverInterruptedAgentSessionInvocations(root);

    const persisted = JSON.parse(readFileSync(storePath(root), "utf8"));
    persisted.sessions[0].unknownOutcome.providerInput.messages[0].content = "Tampered payload";
    writeFileSync(storePath(root), `${JSON.stringify(persisted, null, 2)}\n`);

    expect(() => createAgentSessionAttemptFromUnknown(root, created.id))
      .toThrow("input snapshot failed integrity validation");
    expect(getAgentSession(root, created.id)?.unknownOutcome?.executionId).toBe(invocation.executionId);
  });

  it("projects only a bounded local message tail without source metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-session-store-"));
    roots.push(root);
    const created = createAgentSession(root, {
      purpose: "ask",
      provider: "xai",
      model: "grok-4.6",
    });
    for (let index = 0; index < 14; index += 1) {
      appendAgentSessionMessage(root, created.id, {
        role: index % 2 === 0 ? "user" : "assistant",
        text: `${index}:${"界".repeat(1_100)}`,
        sources: [{ sourcePath: `/private/source-${index}.md`, snippet: "private source" }],
        remoteSources: [{ channel: "notion", detail: "private connector output" }],
      });
    }
    appendAgentSessionMessage(root, created.id, { role: "user", text: "current question" });
    appendAgentSessionMessage(root, created.id, { role: "assistant", text: "", error: "request failed" });

    const history = projectAgentSessionHistory(getAgentSession(root, created.id)!, "current question");

    expect(history.length).toBeLessThanOrEqual(12);
    expect(history.reduce((total, message) => total + message.content.length, 0)).toBeLessThanOrEqual(12_000);
    expect(history.at(-1)?.content).toContain("13:");
    expect(history.some((message) => message.content === "current question")).toBe(false);
    expect(history.every((message) => Object.keys(message).sort().join(",") === "content,role")).toBe(true);
    expect(JSON.stringify(history)).not.toContain("sourcePath");
    expect(JSON.stringify(history)).not.toContain("connector");
  });
});
