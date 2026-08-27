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
import { XAI_CONVERSATION_DISCLOSURE_VERSION } from "../../src/conversationDataDisclosure.js";

const runAgentCliCommand = vi.hoisted(() => vi.fn());
vi.mock("../../src/agentCliRunner.js", () => ({ runAgentCliCommand }));

const roots: string[] = [];

function context(
  config: Record<string, unknown>,
  injected: {
    localSearch?: ReturnType<typeof vi.fn>;
    xaiRequest?: ReturnType<typeof vi.fn>;
    conversationDisclosure?: boolean;
  } = {},
): AppContext {
  const root = mkdtempSync(join(tmpdir(), "yulu-ask-"));
  roots.push(root);
  const configDir = join(root, "config");
  const moviesDir = join(root, "movies");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(moviesDir, { recursive: true });
  return {
    config: { read: () => config },
    host: {
      getAgentConnectionDisclosure: () => injected.conversationDisclosure === false ? null : ({
        connectionId: "direct-xai",
        capability: "conversation",
        disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
        decidedAt: "2026-08-27T00:00:00.000Z",
      }),
    },
    paths: { configDir, moviesDir, scriptDir: "/fake/yulu/scripts" },
    ...(injected.localSearch ? { localSearch: injected.localSearch } : {}),
    ...(injected.xaiRequest ? { xaiText: { request: injected.xaiRequest } } : {}),
  } as unknown as AppContext;
}

function session(ctx: AppContext, provider: string, model = "runtime-managed") {
  return createAgentSession(ctx.paths.configDir, {
    purpose: "ask",
    provider,
    model,
    ...(provider === "xai" ? { credentialSource: "oauth" as const } : {}),
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
