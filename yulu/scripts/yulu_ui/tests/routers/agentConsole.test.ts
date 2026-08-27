import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { agentConsoleRouter } from "../../src/routers/agentConsole.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

vi.mock("../../src/executables.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/executables.js")>();
  return {
    ...actual,
    envWithFallbackPath: (env: NodeJS.ProcessEnv = process.env) => process.env.YULU_TEST_PATH_ONLY === "1"
      ? { ...env, PATH: env.PATH ?? "" }
      : actual.envWithFallbackPath(env),
  };
});

function wavHeader(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2 * 2, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0, 40);
  return header;
}

function makeCtx(
  moviesDir: string,
  configState: Record<string, unknown>,
  latestForRecording: (stem: string) => unknown = () => null,
): AppContext {
  return {
    uiMutationAuthorized: true,
    paths: {
      moviesDir,
      configDir: join(moviesDir, "config"),
      scriptDir: "/fake/yulu/scripts",
      statusAgentSock: join(moviesDir, "missing-status.sock"),
    },
    host: { latestForRecording },
    config: {
      read: () => configState,
      update: vi.fn((key: string, value: unknown) => {
        const parts = key.split(".");
        let cursor = configState;
        for (let i = 0; i < parts.length - 1; i += 1) {
          const part = parts[i]!;
          cursor[part] = (cursor[part] ?? {}) as Record<string, unknown>;
          cursor = cursor[part] as Record<string, unknown>;
        }
        cursor[parts[parts.length - 1]!] = value;
        return {
          daemonsNeedingRestart: key.startsWith("calendars") ? ["calendar", "scheduler"] : [],
          daemonsNeedingSighup: [],
        };
      }),
    },
    launchctl: {
      restart: vi.fn(async () => ({ ok: true })),
    },
    recordingPipeline: {
      transcriptionHealth: vi.fn(() => ({
        available: true,
        provider: "hermes",
        reason: null,
        paused: false,
        policyReason: null,
      })),
    },
  } as unknown as AppContext;
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("agentConsoleRouter", () => {
  const roots: string[] = [];
  const oldEnv = {
    path: process.env.PATH,
    codexRoots: process.env.YULU_CODEX_PLUGIN_ROOTS,
    claudeRoots: process.env.YULU_CLAUDE_PLUGIN_ROOTS,
    hermesHome: process.env.YULU_HERMES_HOME,
    rootsOnly: process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY,
    codexConfig: process.env.YULU_CODEX_CONFIG_PATH,
    testPathOnly: process.env.YULU_TEST_PATH_ONLY,
  };
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    restoreEnv("PATH", oldEnv.path);
    restoreEnv("YULU_CODEX_PLUGIN_ROOTS", oldEnv.codexRoots);
    restoreEnv("YULU_CLAUDE_PLUGIN_ROOTS", oldEnv.claudeRoots);
    restoreEnv("YULU_HERMES_HOME", oldEnv.hermesHome);
    restoreEnv("YULU_AGENT_PLUGIN_ROOTS_ONLY", oldEnv.rootsOnly);
    restoreEnv("YULU_CODEX_CONFIG_PATH", oldEnv.codexConfig);
    restoreEnv("YULU_TEST_PATH_ONLY", oldEnv.testPathOnly);
  });

  it("treats existing summaries as ready even when the latest Host task is still running", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const stem = "AgentkeyProductWeekly_20260625_160011";
    writeFileSync(join(moviesDir, `${stem}.wav`), wavHeader());
    writeFileSync(join(moviesDir, `${stem}.transcript.txt`), "transcript");
    writeFileSync(join(moviesDir, `${stem}.summary.md`), "summary");
    const result = await createCaller(agentConsoleRouter, makeCtx(
      moviesDir,
      { llm: { agent: { provider: "auto" } } },
      () => ({ state: "running", phase: "transcribing", sendToNotion: false, error: null }),
    )).overview();

    expect(result.tasks[0]).toMatchObject({
      stem,
      stages: { transcribe: "done", summarize: "done", send: "idle" },
      hasSummary: true,
    });
  });

  it("does not surface a terminal legacy failure as the meeting's current action state", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const stem = "LegacyMeeting_20260712_160000";
    writeFileSync(join(moviesDir, `${stem}.wav`), wavHeader());

    const result = await createCaller(agentConsoleRouter, makeCtx(
      moviesDir,
      { llm: { agent: { provider: "auto" } } },
      () => ({
        state: "failed",
        phase: "failed",
        sendToNotion: false,
        error: "Retired legacy combined manual task after atomic meeting actions migration",
      }),
    )).overview();

    expect(result.tasks[0]).toMatchObject({
      stem,
      stages: { transcribe: "idle", summarize: "waiting", send: "waiting" },
      error: "",
    });
  });

  it("treats a stale summary as needing regeneration", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const stem = "Retranscribed_20260712_170000";
    writeFileSync(join(moviesDir, `${stem}.wav`), wavHeader());
    writeFileSync(join(moviesDir, `${stem}.transcript.txt`), "fresh transcript");
    writeFileSync(join(moviesDir, `${stem}.summary.md`), "old summary");
    writeFileSync(join(moviesDir, `${stem}.summary.stale`), "2026-07-12T17:01:00Z\n");

    const result = await createCaller(agentConsoleRouter, makeCtx(
      moviesDir,
      { llm: { agent: { provider: "auto" } } },
    )).overview();

    expect(result.tasks[0]).toMatchObject({
      hasTranscript: true,
      hasSummary: false,
      stages: { transcribe: "done", summarize: "idle", send: "waiting" },
    });
  });

  it("normalizes recent recordings into task cards", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const stem = "ProductSync_20260625_093000";
    writeFileSync(join(moviesDir, `${stem}.wav`), wavHeader());
    writeFileSync(join(moviesDir, `${stem}.transcript.txt`), "transcript");
    writeFileSync(join(moviesDir, `${stem}.summary.md`), "summary");

    const result = await createCaller(agentConsoleRouter, makeCtx(
      moviesDir,
      { llm: { agent: { provider: "auto" } } },
      () => ({ state: "completed", phase: "completed", sendToNotion: true, error: null }),
    )).overview();

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({
      stem,
      title: "ProductSync",
      stages: { record: "done", transcribe: "done", summarize: "done", send: "done" },
      dest: "notion",
    });
  });

  it("keeps a discovered runtime candidate-only and preserves the legacy selection", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "codex"), 0o755);
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    const configState = { llm: { enabled: false, command: ["python3", "legacy.py"], agent: { provider: "auto" } } };
    const ctx = makeCtx(moviesDir, configState);

    const result = await createCaller(agentConsoleRouter, ctx).connectAgent({ agent: "codex" });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Agent Connection Center");
    expect(configState.llm).toMatchObject({ enabled: false, command: ["python3", "legacy.py"], agent: { provider: "auto" } });
  });

  it("does not use the legacy selector even when a candidate CLI is absent", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    process.env.PATH = binDir;
    process.env.YULU_TEST_PATH_ONLY = "1";
    const configState = { llm: { enabled: true, command: null, agent: { provider: "hermes" } } };

    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, configState)).connectAgent({ agent: "codex" });

    expect(result).toMatchObject({ ok: false, activeAgent: "hermes" });
    expect(result.error).toContain("Agent Connection Center");
    expect(configState.llm.agent.provider).toBe("hermes");
  });

  it("detects and connects non-Codex local Agent CLIs", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    for (const cmd of ["codex", "claude", "hermes", "openclaw"]) {
      writeFileSync(join(binDir, cmd), "#!/bin/sh\nexit 0\n");
      chmodSync(join(binDir, cmd), 0o755);
    }
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;

    const configState = { llm: { enabled: true, command: null, agent: { provider: "auto" } } };
    const caller = createCaller(agentConsoleRouter, makeCtx(moviesDir, configState));
    let result = await caller.overview();

    expect(result.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "codex", found: true, supported: true, connected: true }),
      expect.objectContaining({ id: "claude", found: true, supported: true }),
      expect.objectContaining({ id: "hermes", found: true, supported: true }),
      expect.objectContaining({ id: "openclaw", found: true, supported: true }),
    ]));

    await expect(caller.connectAgent({ agent: "hermes" })).resolves.toMatchObject({ ok: false });
    result = await caller.overview();
    expect(result.activeAgent).toBe("codex");
    expect(result.agents.find((agent: { id: string }) => agent.id === "hermes")).toMatchObject({ connected: false });
    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "summary")).toMatchObject({
      status: "configured",
      agent: "codex",
    });
  });

  it("keeps Console plugin visibility separate from selected Agent configuration", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    const codexPlugins = join(root, "codex-plugins");
    const claudePlugins = join(root, "claude-plugins");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    mkdirSync(join(codexPlugins, "notion"), { recursive: true });
    mkdirSync(claudePlugins);
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(binDir, "claude"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "codex"), 0o755);
    chmodSync(join(binDir, "claude"), 0o755);
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    process.env.YULU_CODEX_PLUGIN_ROOTS = codexPlugins;
    process.env.YULU_CLAUDE_PLUGIN_ROOTS = claudePlugins;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";

    const configState = {
      llm: { enabled: true, command: null, agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    };
    const ctx = makeCtx(moviesDir, configState);
    const caller = createCaller(agentConsoleRouter, ctx);

    let result = await caller.overview();
    expect(result.plugins.current.map((plugin: { id: string }) => plugin.id)).toEqual(["summary", "notion"]);
    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "notion")).toMatchObject({
      status: "configured",
      resolvedPath: join(codexPlugins, "notion"),
    });
    expect(result.plugins.available.find((plugin: { id: string }) => plugin.id === "zulip")).toMatchObject({
      status: "unconfigured",
    });

    configState.llm.agent.provider = "claude";
    result = await caller.overview();
    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "notion")).toMatchObject({
      status: "unconfigured",
      resolvedPath: "",
    });
  });

  it("detects Codex MCP server plugins from config.toml, not only plugin folders", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    const codexConfig = join(root, "config.toml");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    writeFileSync(join(binDir, "codex"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "codex"), 0o755);
    writeFileSync(codexConfig, [
      "[mcp_servers.zulipchat]",
      'command = "/opt/anaconda3/bin/uvx"',
      'args = ["--from", "zulipchat-mcp==0.6.2", "zulipchat-mcp"]',
      "",
    ].join("\n"));
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    process.env.YULU_CODEX_CONFIG_PATH = codexConfig;

    const configState = {
      llm: { enabled: true, command: null, agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "zulip"] } },
    };
    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, configState)).overview();

    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "zulip")).toMatchObject({
      status: "configured",
      resolvedPath: `${codexConfig}#mcp_servers.zulipchat`,
    });
  });

  it("detects Hermes OAuth MCP connectors from mcp-tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    const hermesHome = join(root, "hermes-home");
    const tokenDir = join(hermesHome, "mcp-tokens");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    mkdirSync(tokenDir, { recursive: true });
    writeFileSync(join(binDir, "hermes"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "hermes"), 0o755);
    writeFileSync(join(tokenDir, "notion.json"), "{}\n");
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    process.env.YULU_HERMES_HOME = hermesHome;

    const configState = {
      llm: { enabled: true, command: null, agent: { provider: "hermes" } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    };
    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, configState)).overview();

    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "notion")).toMatchObject({
      status: "configured",
      resolvedPath: join(tokenDir, "notion.json"),
    });
  });

  it("detects Hermes connectors declared in config.yaml", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    const hermesHome = join(root, "hermes-home");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    mkdirSync(hermesHome);
    writeFileSync(join(binDir, "hermes"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "hermes"), 0o755);
    writeFileSync(join(hermesHome, "config.yaml"), [
      "model: test",
      "mcp_servers:",
      "  notion:",
      "    url: https://mcp.notion.com/mcp",
      "  google_calendar:",
      "    command: npx",
      "other:",
      "  notion: ignored",
      "",
    ].join("\n"));
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    process.env.YULU_HERMES_HOME = hermesHome;

    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, {
      llm: { enabled: true, command: null, agent: { provider: "hermes" } },
      agent_console: { plugins: { added: ["summary"] } },
    })).overview();

    expect(result.plugins.all.find((plugin: { id: string }) => plugin.id === "notion")).toMatchObject({
      status: "configured",
      resolvedPath: `${join(hermesHome, "config.yaml")}#mcp_servers.notion`,
    });
    expect(result.plugins.all.find((plugin: { id: string }) => plugin.id === "calendar")).toMatchObject({
      status: "configured",
      resolvedPath: `${join(hermesHome, "config.yaml")}#mcp_servers.google_calendar`,
    });
  });

  it("does not report a Hermes connector configured while required env placeholders are unresolved", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    const binDir = join(root, "bin");
    const hermesHome = join(root, "hermes-home");
    mkdirSync(moviesDir);
    mkdirSync(binDir);
    mkdirSync(hermesHome);
    writeFileSync(join(binDir, "hermes"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "hermes"), 0o755);
    writeFileSync(join(hermesHome, "config.yaml"), [
      "mcp_servers:",
      "  zulip:",
      "    command: npx",
      "    env:",
      "      ZULIP_REALM: ${ZULIP_REALM}",
      "      ZULIP_EMAIL: ${ZULIP_EMAIL}",
      "      ZULIP_API_KEY: ${ZULIP_API_KEY}",
      "",
    ].join("\n"));
    process.env.PATH = `${binDir}:${oldEnv.path ?? ""}`;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    process.env.YULU_HERMES_HOME = hermesHome;

    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, {
      llm: { enabled: true, command: null, agent: { provider: "hermes" } },
      agent_console: { plugins: { added: ["summary"] } },
    })).overview();

    expect(result.plugins.all.find((plugin: { id: string }) => plugin.id === "zulip")).toMatchObject({
      status: "unconfigured",
      resolvedPath: "",
    });
  });

  it("adds and removes Console plugin filters without touching calendar connector config", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const configState = {
      llm: { enabled: true, command: ["codex"], agent: { provider: "codex" } },
      connectors: { gog: { read_calendar: true } },
      agent_console: { plugins: { added: ["summary"] } },
    };
    const caller = createCaller(agentConsoleRouter, makeCtx(moviesDir, configState));

    await caller.addPlugin({ plugin: "zulip" });
    expect(configState.agent_console.plugins.added).toEqual(["summary", "zulip"]);
    expect(configState.connectors.gog.read_calendar).toBe(true);

    await caller.removePlugin({ plugin: "zulip" });
    expect(configState.agent_console.plugins.added).toEqual(["summary"]);
    expect(configState.connectors.gog.read_calendar).toBe(true);
  });

  it("stores send destinations under the selected Agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const configState = {
      llm: { enabled: true, command: ["codex"], agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "notion", "zulip"] } },
    };
    const caller = createCaller(agentConsoleRouter, makeCtx(moviesDir, configState));

    await caller.setDestination({ channel: "notion", target: "Product Notes" });
    await caller.setDestination({ channel: "zulip", stream: "meetings", topic: "weekly" });

    expect(configState.agent_console).toMatchObject({
      destinations: {
        codex: {
          notion: { target: "Product Notes" },
          zulip: { stream: "meetings", topic: "weekly" },
        },
      },
    });
    expect(configState).not.toHaveProperty("agent_pipeline.notion_destination");
    const result = await caller.overview();
    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "notion")).toMatchObject({
      destination: expect.objectContaining({ value: "Product Notes", configured: true }),
    });
    expect(result.plugins.current.find((plugin: { id: string }) => plugin.id === "zulip")).toMatchObject({
      destination: expect.objectContaining({ value: "meetings / weekly", configured: true }),
    });
  });

  it("keeps the durable Notion destination scoped to Hermes", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const configState = {
      llm: { enabled: true, command: ["hermes"], agent: { provider: "hermes" } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    };
    const caller = createCaller(agentConsoleRouter, makeCtx(moviesDir, configState));

    await caller.setDestination({ channel: "notion", target: "Hermes Notes" });

    expect(configState).toMatchObject({
      agent_console: { destinations: { hermes: { notion: { target: "Hermes Notes" } } } },
      agent_pipeline: { notion_destination: "Hermes Notes" },
    });
  });

  it("returns the native Agent MCP management command", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const result = await createCaller(agentConsoleRouter, makeCtx(moviesDir, {
      llm: { enabled: true, command: ["hermes"], agent: { provider: "hermes" } },
    })).configurePlugin({ plugin: "notion" });

    expect(result).toMatchObject({
      ok: true,
      agent: "hermes",
      manageCommand: "hermes mcp",
    });
  });

  it("merges saved and Agent-discovered destination options per selected Agent", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const configState = {
      llm: { enabled: true, command: null, agent: { provider: "codex" } },
      agent_console: {
        plugins: { added: ["summary", "zulip"] },
        destinations: { codex: { zulip: { stream: "saved", topic: "weekly" } } },
        destination_options: {
          codex: {
            zulip: [
              { label: "product / launch", stream: "product", topic: "launch", source: "agent" },
            ],
          },
        },
      },
    };
    const caller = createCaller(agentConsoleRouter, makeCtx(moviesDir, configState));

    const result = await caller.destinationOptions({ channel: "zulip" });

    expect(result.options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "saved / weekly", source: "saved" }),
      expect.objectContaining({ label: "product / launch", source: "agent" }),
    ]));
  });

  it("updates Console calendar settings and restarts calendar scheduler services", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-console-"));
    roots.push(root);
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    const configState = {
      llm: { enabled: true, command: null, agent: { provider: "codex" } },
      calendars: [{ type: "google", enabled: true, gog_account: "", watch_calendars: [] }],
    };
    const ctx = makeCtx(moviesDir, configState);
    const caller = createCaller(agentConsoleRouter, ctx);

    const result = await caller.updateCalendarConfig({
      key: "calendars.0.watch_calendars",
      value: ["primary", "team"],
    });

    expect(configState.calendars[0]).toMatchObject({ watch_calendars: ["primary", "team"] });
    expect(result.restartErrors).toEqual([]);
    expect(ctx.launchctl.restart).toHaveBeenCalledWith("com.yulu.calendar");
    expect(ctx.launchctl.restart).toHaveBeenCalledWith("com.yulu.scheduler");
  });
});
