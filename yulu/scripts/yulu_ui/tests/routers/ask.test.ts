import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { askRouter, buildAgentQuestionPrompt } from "../../src/routers/ask.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const runAgentCliCommand = vi.hoisted(() => vi.fn());
vi.mock("../../src/agentCliRunner.js", () => ({ runAgentCliCommand }));

const roots: string[] = [];

function context(config: Record<string, unknown>, root = mkdtempSync(join(tmpdir(), "yulu-ask-"))): AppContext {
  roots.push(root);
  const configDir = join(root, "config");
  const moviesDir = join(root, "movies");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(moviesDir, { recursive: true });
  return {
    config: { read: () => config },
    paths: { configDir, moviesDir, scriptDir: "/fake/yulu/scripts" },
  } as unknown as AppContext;
}

afterEach(() => {
  runAgentCliCommand.mockReset();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Agent-owned Ask flow", () => {
  it("builds a thin coordinator prompt that delegates retrieval and connectors", () => {
    const prompt = buildAgentQuestionPrompt("上次讨论了什么？", 6);
    expect(prompt).toContain("recording_search");
    expect(prompt).toContain("recording_get");
    expect(prompt).toContain("own read-only connectors");
    expect(prompt).toContain("上次讨论了什么？");
    expect(prompt).not.toContain("会议资料来源：");
  });

  it("returns an honest unavailable state instead of synthesizing a fallback answer", async () => {
    const result = await createCaller(askRouter, context({
      llm: { enabled: false, agent: { provider: "hermes" } },
    })).ask({ question: "项目进度？" });

    expect(result).toMatchObject({
      ok: false,
      answer: "",
      usedFallback: false,
      llmStatus: "not_configured",
      sources: [],
    });
    expect(runAgentCliCommand).not.toHaveBeenCalled();
  });

  it("passes the question directly to Hermes and leaves retrieval Agent-owned", async () => {
    runAgentCliCommand.mockResolvedValue({
      code: 0,
      stdout: "结论：项目正在收敛。",
      stderr: "",
      nativeSessionId: "20260711_ask_1",
    });
    const result = await createCaller(askRouter, context({
      llm: { enabled: true, command: ["hermes"], agent: { provider: "hermes" } },
    })).ask({ question: "项目进度？", limit: 5 });

    expect(runAgentCliCommand).toHaveBeenCalledWith(expect.objectContaining({
      prompt: expect.stringContaining("项目进度？"),
      timeoutMs: 300_000,
    }));
    expect(result).toMatchObject({
      ok: true,
      answer: "结论：项目正在收敛。",
      llmStatus: "ok",
      usedFallback: false,
      sources: [],
      search: { owner: "agent", telemetry: { coordinatorRetrieval: false } },
    });
  });

  it("resumes the native Agent session and persists a replacement session id", async () => {
    const ctx = context({
      llm: { enabled: true, command: ["hermes"], agent: { provider: "hermes" } },
    });
    const sessionId = "11111111-1111-4111-8111-111111111111";
    writeFileSync(join(ctx.paths.configDir, "agent-sessions.json"), JSON.stringify({
      version: 1,
      sessions: [{
        id: sessionId,
        agent: "hermes",
        purpose: "ask",
        title: "Ask",
        nativeSessionId: "old-native",
        messages: [],
        createdAt: "2026-07-11T00:00:00.000Z",
        updatedAt: "2026-07-11T00:00:00.000Z",
      }],
    }));
    runAgentCliCommand.mockResolvedValue({
      code: 0,
      stdout: "answer",
      stderr: "",
      nativeSessionId: "new-native",
    });

    await createCaller(askRouter, ctx).ask({ question: "continue", sessionId });
    expect(runAgentCliCommand).toHaveBeenCalledWith(expect.objectContaining({
      nativeSessionId: "old-native",
      yuluSessionId: sessionId,
      configDir: ctx.paths.configDir,
    }));
    expect(JSON.parse(readFileSync(join(ctx.paths.configDir, "agent-sessions.json"), "utf8")).sessions[0])
      .toMatchObject({ nativeSessionId: "new-native" });
  });

  it("returns Agent execution errors without a Yulu-authored answer", async () => {
    runAgentCliCommand.mockResolvedValue({ code: 1, stdout: "", stderr: "Hermes failed", nativeSessionId: "" });
    const result = await createCaller(askRouter, context({
      llm: { enabled: true, command: ["hermes"], agent: { provider: "hermes" } },
    })).ask({ question: "项目进度？" });

    expect(result).toMatchObject({
      ok: false,
      answer: "",
      llmStatus: "error",
      llmError: "Hermes failed",
      usedFallback: false,
    });
  });
});
