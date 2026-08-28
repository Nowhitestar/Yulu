import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeConnectorCommand,
  buildClaudeSessionCommand,
  buildCodexConnectorCommand,
  buildCodexSessionCommand,
  buildHermesConnectorConfig,
  buildHermesSessionCommand,
  buildOpenClawSessionCommand,
  buildSharingGuardSource,
  extractHermesSessionId,
  prepareCodexConnectorProfile,
  prepareHermesConnectorProfile,
  runAgentCliCommand,
} from "../src/agentCliRunner.js";

const tempDirs: string[] = [];
const originalHermesHome = process.env.HERMES_HOME;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
  else process.env.HERMES_HOME = originalHermesHome;
});

describe("agentCliRunner", () => {
  it("builds an initial Codex exec command that captures JSON events and the last message", () => {
    const command = buildCodexSessionCommand(
      ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"],
      { outputPath: "/tmp/last.txt" },
    );

    expect(command).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "-o",
      "/tmp/last.txt",
      "-",
    ]);
  });

  it("builds a Codex exec resume command for an existing native session", () => {
    const command = buildCodexSessionCommand(
      ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"],
      {
        nativeSessionId: "019f0000-0000-7000-8000-000000000001",
        outputPath: "/tmp/last.txt",
      },
    );

    expect(command).toEqual([
      "codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
      "--json",
      "-o",
      "/tmp/last.txt",
      "resume",
      "019f0000-0000-7000-8000-000000000001",
      "-",
    ]);
  });

  it("builds a Claude command with a stable session id", () => {
    const command = buildClaudeSessionCommand(
      ["claude", "--print", "--add-dir", "/movies"],
      { nativeSessionId: "019f0000-0000-7000-8000-000000000001" },
    );

    expect(command).toEqual([
      "claude",
      "--print",
      "--add-dir",
      "/movies",
      "--session-id",
      "019f0000-0000-7000-8000-000000000001",
    ]);
  });

  it("isolates Claude to one connector and an explicit tool allowlist", () => {
    const command = buildClaudeConnectorCommand(
      ["claude", "--print"],
      { configPaths: ["/app/.mcp.json", "/home/me/.claude.json"], settingsPath: "/tmp/settings.json" },
      { connector: "notion", allowedTools: ["notion_search", "notion_fetch"] },
    );
    expect(command).toEqual(expect.arrayContaining([
      "--permission-mode", "dontAsk",
      "--allowedTools", "mcp__notion__notion_search,mcp__notion__notion_fetch",
      "--strict-mcp-config",
      "--mcp-config", "/app/.mcp.json", "/home/me/.claude.json",
      "--setting-sources", "",
      "--settings", "/tmp/settings.json",
    ]));
  });

  it("creates a project-scoped Codex guard without copying runtime-owned auth or config", () => {
    const source = mkdtempSync(join(tmpdir(), "yulu-codex-source-"));
    tempDirs.push(source);
    mkdirSync(join(source, ".codex"));
    writeFileSync(join(source, ".codex", "config.toml"), 'token = "runtime-owned-secret"\n');

    const profile = prepareCodexConnectorProfile({
      connector: "notion",
      allowedTools: ["notion_search"],
    });
    tempDirs.push(profile.cwd);

    expect(readFileSync(join(profile.cwd, ".codex", "config.toml"), "utf8")).toBe("");
    expect(existsSync(join(profile.cwd, ".git"))).toBe(true);
    expect(existsSync(join(profile.cwd, ".codex", "hooks.json"))).toBe(false);
    expect(readFileSync(profile.guardPath, "utf8")).not.toContain("runtime-owned-secret");
    const command = buildCodexConnectorCommand(["codex", "exec"], profile);
    expect(command).toEqual(expect.arrayContaining([
      "codex", "exec",
      "-c", `projects.${JSON.stringify(profile.cwd)}.trust_level="trusted"`,
      "-c", expect.stringMatching(/^hooks=\{SessionStart=/),
      "--dangerously-bypass-hook-trust",
    ]));
    expect(command.join(" ")).toContain(profile.guardPath);
  });

  it("fails closed before connector execution unless a project hook authorizes the exact tool input", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu-sharing-guard-"));
    tempDirs.push(dir);
    const auditPath = join(dir, "audit.jsonl");
    const guardPath = join(dir, "guard.mjs");
    const destination = JSON.stringify({ page_id: "parent-123" });
    writeFileSync(guardPath, buildSharingGuardSource({
      connector: "notion",
      allowedTools: ["notion_create_pages"],
      writeGuard: {
        destination,
        content: "Yulu Test Share — connection verification only. This message contains no meeting content.",
      },
    }, auditPath));
    const run = (tool_name: string, tool_input: Record<string, unknown>) => spawnSync(
      process.execPath,
      [guardPath],
      { input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input }), encoding: "utf8" },
    );

    expect(run("mcp__notion__notion_create_pages", {
      parent: { page_id: "parent-123" },
      pages: [{ content: "Yulu Test Share — connection verification only. This message contains no meeting content." }],
    }).status).toBe(0);
    expect(run("mcp__notion__notion_create_pages", {
      parent: { page_id: "parent-123" },
      pages: [{ content: "Yulu Test Share — connection verification only. This message contains no meeting content." }],
    }).status).toBe(2);
    expect(run("mcp__notion__notion_delete_page", { id: "other" }).status).toBe(2);
    expect(readFileSync(auditPath, "utf8")).toMatch(/"decision":"allow"/);
    expect(readFileSync(auditPath, "utf8")).toMatch(/"decision":"deny"/);
  });

  it("authorizes only the authoritative Notion parent and one exact page payload", () => {
    const run = (tool_input: Record<string, unknown>) => {
      const dir = mkdtempSync(join(tmpdir(), "yulu-sharing-notion-guard-"));
      tempDirs.push(dir);
      const guardPath = join(dir, "guard.mjs");
      writeFileSync(guardPath, buildSharingGuardSource({
        connector: "notion",
        allowedTools: ["notion_create_pages"],
        writeGuard: {
          destination: JSON.stringify({ page_id: "meeting-parent-123" }),
          content: "# Product summary\n\nShip it.",
        },
      }, join(dir, "audit.jsonl")));
      return spawnSync(process.execPath, [guardPath], {
        input: JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_name: "mcp__notion__notion_create_pages",
          tool_input,
        }),
        encoding: "utf8",
      });
    };
    const content = "# Product summary\n\nShip it.";

    expect(run({
      parent: { page_id: "meeting-parent-123" },
      pages: [{ content }],
    }).status).toBe(0);

    expect(run({
      parent: { page_id: "wrong-parent" },
      metadata: { destination: { page_id: "meeting-parent-123" } },
      pages: [{ content }],
    }).status).toBe(2);
    expect(run({
      parent: { page_id: "meeting-parent-123" },
      pages: [{ content }, { content }],
    }).status).toBe(2);
    expect(run({
      parent: { page_id: "meeting-parent-123" },
      pages: [{ content, properties: { Project: { select: { name: "Secret" } } } }],
    }).status).toBe(2);
    expect(run({
      parent: { page_id: "meeting-parent-123" },
      pages: [{ content }],
      metadata: { mode: "silent" },
    }).status).toBe(2);
  });

  it("denies mutation and foreign tools during a read-only connector phase", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu-sharing-read-guard-"));
    tempDirs.push(dir);
    const auditPath = join(dir, "audit.jsonl");
    const guardPath = join(dir, "guard.mjs");
    writeFileSync(guardPath, buildSharingGuardSource({
      connector: "notion",
      allowedTools: ["notion_search", "notion_fetch"],
    }, auditPath));
    const run = (tool_name: string) => spawnSync(process.execPath, [guardPath], {
      input: JSON.stringify({ hook_event_name: "PreToolUse", tool_name, tool_input: {} }),
      encoding: "utf8",
    });

    expect(run("mcp__notion__notion_search").status).toBe(0);
    expect(run("mcp__notion__notion_create_pages").status).toBe(2);
    expect(run("mcp__zulip__get_messages").status).toBe(2);
  });

  it("fails a Codex connector run when the CLI does not execute the project hook", async () => {
    const source = mkdtempSync(join(tmpdir(), "yulu-fake-codex-"));
    tempDirs.push(source);
    const executable = join(source, "fake-codex");
    writeFileSync(executable, [
      "#!/bin/sh",
      "if [ \"$1\" = 'features' ]; then printf '%s\\n' 'hooks stable true'; exit 0; fi",
      "previous=''",
      "for argument in \"$@\"; do",
      "  if [ \"$previous\" = '-o' ]; then printf '%s' '{\"status\":\"ready\"}' > \"$argument\"; fi",
      "  previous=\"$argument\"",
      "done",
      "exit 0",
    ].join("\n"));
    chmodSync(executable, 0o755);

    const result = await runAgentCliCommand({
      runtime: {
        provider: "codex",
        label: "Codex",
        source: "configured-command",
        command: [executable, "exec", "--sandbox", "read-only"],
        cwd: source,
        disabledReason: null,
      },
      scriptDir: source,
      configDir: source,
      prompt: "read only",
      timeoutMs: 5_000,
      connectorToolPolicy: { connector: "notion", allowedTools: ["notion_search"] },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/guard did not execute/i);
    expect(result.connectorWriteState).toBe("unknown");
  });

  it("does not start a connector turn when Codex hooks are unavailable", async () => {
    const source = mkdtempSync(join(tmpdir(), "yulu-old-codex-"));
    tempDirs.push(source);
    const executable = join(source, "old-codex");
    const turnMarker = join(source, "turn-started");
    writeFileSync(executable, [
      "#!/bin/sh",
      "if [ \"$1\" = 'features' ]; then printf '%s\\n' 'hooks experimental true'; exit 0; fi",
      `printf '%s' started > ${JSON.stringify(turnMarker)}`,
      "exit 0",
    ].join("\n"));
    chmodSync(executable, 0o755);

    const result = await runAgentCliCommand({
      runtime: {
        provider: "codex",
        label: "Codex",
        source: "configured-command",
        command: [executable, "exec"],
        cwd: source,
        disabledReason: null,
      },
      scriptDir: source,
      configDir: source,
      prompt: "must not run",
      timeoutMs: 5_000,
      connectorToolPolicy: { connector: "notion", allowedTools: ["notion_search"] },
    });

    expect(result).toMatchObject({
      code: 1,
      stderr: expect.stringMatching(/hooks.*unavailable/i),
      connectorWriteState: "not-started",
    });
    expect(existsSync(turnMarker)).toBe(false);
  });

  it("builds a Hermes one-shot command that can resume a native session", () => {
    const command = buildHermesSessionCommand(
      ["hermes", "chat", "-Q", "--source", "yulu"],
      {
        nativeSessionId: "019f0000-0000-7000-8000-000000000001",
        prompt: "总结昨天的会议",
        toolsets: ["file", "yulu"],
      },
    );

    expect(command).toEqual([
      "hermes",
      "chat",
      "-Q",
      "--source",
      "yulu",
      "--resume",
      "019f0000-0000-7000-8000-000000000001",
      "--toolsets",
      "file,yulu",
      "--query",
      "总结昨天的会议",
    ]);
  });

  it("replaces configured Hermes toolsets with the task allowlist", () => {
    const command = buildHermesSessionCommand(
      [
        "hermes",
        "-p",
        "yulu-runtime",
        "chat",
        "-t",
        "all",
        "--toolsets=terminal,notion",
        "-tbrowser",
      ],
      { prompt: "只处理本地 artifact", toolsets: ["yulu_artifact", "yulu_artifact"] },
    );

    expect(command).toEqual([
      "hermes",
      "-p",
      "yulu-runtime",
      "chat",
      "-Q",
      "--source",
      "yulu",
      "--toolsets",
      "yulu_artifact",
      "--query",
      "只处理本地 artifact",
    ]);
  });

  it("fails closed when an explicit Hermes toolset allowlist is empty", () => {
    expect(() => buildHermesSessionCommand(
      ["hermes", "chat"],
      { prompt: "处理录音", toolsets: [] },
    )).toThrow("Hermes toolsets must not be empty");
  });

  it("extracts Hermes' native non-UUID session id from stderr", () => {
    expect(extractHermesSessionId("\nsession_id: 20260711_123456_a1b2c3\n")).toBe(
      "20260711_123456_a1b2c3",
    );
  });

  it("only accepts Hermes session ids from a dedicated stderr line", () => {
    expect(extractHermesSessionId("warning: session_id: 20260711_123456_a1b2c3\n")).toBeUndefined();
  });

  it("scopes a Hermes config to the requested MCP connector and extends discovery", () => {
    const config = [
      "model:",
      "  default: gpt-test",
      "mcp_discovery_timeout: 1.5",
      "mcp_servers:",
      "  notion:",
      "    url: https://example.com/notion",
      "  zulip:",
      "    command: npx",
      "    args:",
      "      - zulip-mcp",
      "  google_calendar:",
      "    command: node",
      "display:",
      "  compact: true",
      "",
    ].join("\n");

    const scoped = buildHermesConnectorConfig(config, "zulip");

    expect(scoped).toContain("mcp_discovery_timeout: 8");
    expect(scoped).toContain("  zulip:\n    command: npx");
    expect(scoped).not.toContain("  notion:");
    expect(scoped).not.toContain("  google_calendar:");
    expect(scoped).toContain("display:\n  compact: true");
  });

  it("creates an isolated Hermes home without editing or copying user state", () => {
    const source = mkdtempSync(join(tmpdir(), "yulu-hermes-source-"));
    tempDirs.push(source);
    writeFileSync(join(source, "config.yaml"), [
      "mcp_servers:",
      "  zulip:",
      "    command: npx",
      "",
    ].join("\n"));
    writeFileSync(join(source, "state.db"), "state");

    const profile = prepareHermesConnectorProfile("zulip", source);
    tempDirs.push(profile.home);

    expect(lstatSync(join(profile.home, "state.db")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(profile.home, "config.yaml"), "utf8")).toContain(
      "mcp_discovery_timeout: 8",
    );
    expect(readFileSync(join(source, "config.yaml"), "utf8")).not.toContain(
      "mcp_discovery_timeout",
    );
  });

  it("fails closed instead of using Hermes for a Sharing connector operation", async () => {
    const source = mkdtempSync(join(tmpdir(), "yulu-hermes-source-"));
    tempDirs.push(source);
    writeFileSync(join(source, "config.yaml"), [
      "mcp_servers:",
      "  notion:",
      "    url: https://example.com/notion",
      "  zulip:",
      "    command: npx",
      "",
    ].join("\n"));
    process.env.HERMES_HOME = source;

    const fakeHermes = join(source, "hermes");
    writeFileSync(fakeHermes, "#!/bin/sh\nexit 99\n");
    chmodSync(fakeHermes, 0o755);

    const result = await runAgentCliCommand({
      runtime: {
        provider: "hermes",
        label: "Hermes",
        source: "configured-command",
        command: [fakeHermes, "chat"],
        cwd: source,
        disabledReason: null,
      },
      scriptDir: source,
      configDir: source,
      prompt: "share through zulip",
      timeoutMs: 5_000,
      hermesToolsets: ["zulip"],
      hermesConnector: "zulip",
      connectorToolPolicy: { connector: "zulip", allowedTools: ["get_messages"] },
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/pre-tool authorization/i);
    expect(readFileSync(join(source, "config.yaml"), "utf8")).toContain("  notion:");
  });

  it("fails closed when the requested Hermes connector is not configured", () => {
    expect(() => buildHermesConnectorConfig(
      "mcp_servers:\n  notion:\n    url: https://example.com\n",
      "zulip",
    )).toThrow("Hermes connector is not configured: zulip");
  });

  it("builds an OpenClaw command with an explicit session id", () => {
    const command = buildOpenClawSessionCommand(
      ["openclaw", "agent", "--json"],
      {
        nativeSessionId: "019f0000-0000-7000-8000-000000000001",
        prompt: "发送到 Notion",
      },
    );

    expect(command).toEqual([
      "openclaw",
      "agent",
      "--json",
      "--session-id",
      "019f0000-0000-7000-8000-000000000001",
      "--message",
      "发送到 Notion",
    ]);
  });
});
