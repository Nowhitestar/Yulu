import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { askRouter } from "../../src/routers/ask.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { createAgentSession, updateAgentSessionNativeSession } from "../../src/agentSessionStore.js";

const execFileMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const oldEnv = {
  claudeRoots: process.env.YULU_CLAUDE_PLUGIN_ROOTS,
  rootsOnly: process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY,
};

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock, spawn: spawnMock };
});

function lastCb(args: unknown[]) {
  const last = args[args.length - 1];
  return typeof last === "function" ? (last as (e: unknown, r?: { stdout: string; stderr: string }) => void) : null;
}

function mockSearch(stdout: unknown) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    lastCb(args)?.(null, { stdout: JSON.stringify(stdout), stderr: "" });
  });
}

function mockSearchByQuery(results: Record<string, unknown>) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const cliArgs = args[1] as string[];
    const query = cliArgs[3] ?? "";
    const stdout = results[query] ?? { ok: true, hits: [], telemetry: { hit_count: 0 } };
    lastCb(args)?.(null, { stdout: JSON.stringify(stdout), stderr: "" });
  });
}

function mockLlm(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const stdinWrites: string[] = [];
    const proc = {
      stdin: { write: (s: string) => stdinWrites.push(s), end: () => {} },
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
      __stdinWrites: stdinWrites,
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function makeCtx(opts: {
  moviesDir: string;
  configDir: string;
  config?: Record<string, unknown>;
}): AppContext {
  const config = opts.config ?? {
    llm: { enabled: true, command: ["claude", "--print"] },
    agent_console: { plugins: { added: ["summary", "notion", "zulip", "calendar"] } },
    connectors: { notion: { send_summary: true }, zulip: { send_summary: true } },
    output: {
      notion: { destination_label: "Team Notes" },
      zulip: { stream: "team", topic: "纪要" },
    },
    calendars: [
      { type: "google", enabled: true, gog_account: "me@example.com", watch_calendars: ["primary"] },
    ],
  };
  return {
    config: { read: () => config },
    paths: {
      scriptDir: "/fake/yulu/scripts",
      moviesDir: opts.moviesDir,
      configDir: opts.configDir,
    },
  } as unknown as AppContext;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("askRouter", () => {
  let root: string;
  let moviesDir: string;
  let configDir: string;

  beforeEach(() => {
    execFileMock.mockReset();
    spawnMock.mockReset();
    root = mkdtempSync(join(tmpdir(), "ask_"));
    moviesDir = join(root, "movies");
    configDir = join(root, "config");
    mkdirSync(moviesDir);
    mkdirSync(configDir);
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    delete process.env.YULU_CLAUDE_PLUGIN_ROOTS;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    restoreEnv("YULU_CLAUDE_PLUGIN_ROOTS", oldEnv.claudeRoots);
    restoreEnv("YULU_AGENT_PLUGIN_ROOTS_ONLY", oldEnv.rootsOnly);
  });

  it("retrieves meeting context, connector context, and asks the configured Agent command", async () => {
    const stem = "ProductWeekly_20260624_090000";
    const sourcePath = join(moviesDir, `${stem}.summary.md`);
    const pluginRoot = join(root, "claude-plugins");
    mkdirSync(join(pluginRoot, "notion"), { recursive: true });
    mkdirSync(join(pluginRoot, "zulip"), { recursive: true });
    mkdirSync(join(pluginRoot, "calendar"), { recursive: true });
    process.env.YULU_CLAUDE_PLUGIN_ROOTS = pluginRoot;
    writeFileSync(sourcePath, "会议提到 OKR 需要重新定义，Notion 用于沉淀结论。");
    writeFileSync(join(configDir, "schedule.json"), JSON.stringify({
      meetings: [{ id: "m1", title: "Product Weekly", start: "2026-06-24T09:00:00", end: "2026-06-24T10:00:00" }],
    }));
    mockSearch({
      ok: true,
      hits: [{
        kind: "meeting_summary",
        stem,
        meeting_title: "Product Weekly",
        recorded_at: "2026-06-24T09:00:00",
        source_path: sourcePath,
        score: 1,
        snippet: "...[hit]OKR[/hit]...",
      }],
      telemetry: { hit_count: 1 },
    });
    mockLlm("OKR 要重新定义，并写入 Team Notes。[1]\n");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({ question: "OKR 怎么处理？" });

    expect(result.usedFallback).toBe(false);
    expect(result.answer).toContain("OKR");
    expect(result.sources[0].title).toBe("Product Weekly");
    expect(result.sources[0].url).toBe(`/inbox/${stem}?tab=summary&snippet=OKR`);
    expect(result.connectorContext.calendar.upcomingMeetings[0].title).toBe("Product Weekly");
    expect(result.connectorContext.outputs).toEqual([
      expect.objectContaining({ channel: "notion", label: "Notion", enabled: true, connected: true, destination: "Yulu Meeting" }),
      expect.objectContaining({ channel: "zulip", label: "Zulip", enabled: true, connected: true, destination: "选择 Channel 和 Topic" }),
    ]);
    expect(result.agentRuntime).toEqual(expect.objectContaining({
      label: "Claude Code",
      source: "configured-command",
      status: "ready",
    }));
    expect(String(spawnMock.mock.calls[0]![0])).toContain("claude");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["--print"]);
    const proc = spawnMock.mock.results[0]!.value as { __stdinWrites: string[] };
    const prompt = proc.__stdinWrites.join("");
    expect(prompt).toContain("OKR 怎么处理？");
    expect(prompt).toContain("会议提到 OKR");
    expect(prompt).toContain("Agent CLI");
    expect(prompt).toContain("remote_connector_query: delegate to Agent MCP connectors");
    expect(prompt).toContain("scheduler_boundary: Yulu owns native calendar scheduling");
    expect(prompt).toContain("notion: enabled connected=yes");
    expect(prompt).toContain("destination=Yulu Meeting");
  });

  it("expands natural-language questions into salient search terms", async () => {
    const stem = "AgentkeyProductWeekly_20260618_160020";
    const sourcePath = join(moviesDir, `${stem}.summary.md`);
    writeFileSync(sourcePath, "小春、小白、Bruce、Serell 讨论了 AgentKey 增长、KYC 和下一步方案。");
    mockSearchByQuery({
      "bruce 和我主要聊了什么": { ok: true, hits: [], telemetry: { hit_count: 0 } },
      bruce: {
        ok: true,
        hits: [{
          kind: "meeting_summary",
          stem,
          meeting_title: "AgentkeyProductWeekly",
          recorded_at: "2026-06-18T16:00:20",
          source_path: sourcePath,
          score: 2.2,
          snippet: "...小春、小白、[hit]Bruce[/hit]、Serell...",
        }],
        telemetry: { hit_count: 1 },
      },
    });
    mockLlm("你和 Bruce 主要围绕 AgentKey 增长、KYC 和后续方案推进。[1]\n");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({
      question: "bruce 和我主要聊了什么",
    });

    const queries = execFileMock.mock.calls.map((call) => (call[1] as string[])[3]);
    expect(queries).toContain("bruce");
    expect(result.sources).toHaveLength(1);
    expect(result.sources[0].title).toBe("AgentkeyProductWeekly");
    expect(result.search.telemetry.plannedQueries).toContain("bruce");
    expect(result.answer).toContain("Bruce");
  });

  it("resumes the provider-native Codex session for a persisted Ask session", async () => {
    const session = createAgentSession(configDir, { agent: "codex", title: "Ask native" });
    updateAgentSessionNativeSession(configDir, session.id, {
      nativeSessionId: "019f0000-0000-7000-8000-000000000001",
      runtimeLabel: "Codex",
    });
    mockSearch({ hits: [], telemetry: {} });
    mockLlm(JSON.stringify({ type: "message", text: "继续同一个 Codex session。" }) + "\n");
    const ctx = makeCtx({
      moviesDir,
      configDir,
      config: {
        llm: {
          enabled: true,
          command: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"],
          agent: { provider: "codex" },
        },
        agent_console: { plugins: { added: ["summary"] } },
      },
    });

    const result = await createCaller(askRouter, ctx).ask({
      question: "继续刚才的问题",
      sessionId: session.id,
    });

    expect(result.answer).toBe("继续同一个 Codex session。");
    expect(String(spawnMock.mock.calls[0]![0])).toContain("codex");
    expect(spawnMock.mock.calls[0]![1]).toEqual(expect.arrayContaining([
      "exec",
      "--json",
      "resume",
      "019f0000-0000-7000-8000-000000000001",
      "-",
    ]));
  });

  it("returns a source-backed fallback when no Agent runtime is configured or available", async () => {
    const sourcePath = join(moviesDir, "Memo_20260624_100000.transcript.txt");
    writeFileSync(sourcePath, "local transcript");
    mockSearch({
      hits: [{
        kind: "meeting_transcript",
        stem: "Memo_20260624_100000",
        meeting_title: "Memo",
        source_path: sourcePath,
        snippet: "[hit]local[/hit] transcript",
      }],
      telemetry: {},
    });
    const ctx = makeCtx({
      moviesDir,
      configDir,
      config: { llm: { enabled: true, agent: { provider: "gemini" } }, connectors: {}, output: {}, calendars: [] },
    });

    const result = await createCaller(askRouter, ctx).ask({ question: "local?" });

    expect(result.usedFallback).toBe(true);
    expect(result.llmStatus).toBe("not_configured");
    expect(result.agentRuntime.status).toBe("missing");
    expect(result.answer).toContain("gemini CLI is not available");
    expect(result.answer).toContain("Memo");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("degrades to fallback when llm.command fails", async () => {
    mockSearch({ hits: [], telemetry: {} });
    mockLlm("", 1, "model unavailable");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({ question: "anything" });

    expect(result.usedFallback).toBe(true);
    expect(result.llmStatus).toBe("error");
    expect(result.llmError).toContain("model unavailable");
    expect(result.answer).toContain("model unavailable");
  });

  it("skips local meeting citations for general identity questions", async () => {
    mockSearch({
      hits: [{
        kind: "meeting_summary",
        stem: "Memo_20260624_100000",
        meeting_title: "Memo",
        snippet: "[hit]你是谁[/hit]",
      }],
      telemetry: {},
    });
    mockLlm("我是 Yulu 里的会议助手。");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({ question: "你是谁？" });

    expect(execFileMock).not.toHaveBeenCalled();
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain("会议助手");
  });

  it("marks Notion as remote Agent context instead of a local citation", async () => {
    const pluginRoot = join(root, "claude-plugins");
    mkdirSync(join(pluginRoot, "notion"), { recursive: true });
    process.env.YULU_CLAUDE_PLUGIN_ROOTS = pluginRoot;
    mockSearch({ ok: true, hits: [], telemetry: { hit_count: 0 } });
    mockLlm("Notion 里可以继续查项目资料。\n\n远端上下文：Notion");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({
      question: "Notion 里有什么？",
    });

    expect(result.sources).toEqual([]);
    expect(result.remoteSources).toEqual([
      expect.objectContaining({ channel: "notion", label: "Notion", connected: true }),
    ]);
  });

  it("does not read source files outside the recordings root", async () => {
    const outsidePath = join(root, "outside.md");
    writeFileSync(outsidePath, "secret text");
    mockSearch({
      hits: [{
        kind: "meeting_summary",
        stem: "Memo_20260624_100000",
        meeting_title: "Memo",
        source_path: outsidePath,
        snippet: "[hit]safe snippet[/hit]",
      }],
      telemetry: {},
    });
    mockLlm("safe answer [1]");

    const result = await createCaller(askRouter, makeCtx({ moviesDir, configDir })).ask({ question: "safe?" });
    const proc = spawnMock.mock.results[0]!.value as { __stdinWrites: string[] };

    expect(result.sources[0].excerpt).toBe("safe snippet");
    expect(proc.__stdinWrites.join("")).not.toContain("secret text");
  });
});
