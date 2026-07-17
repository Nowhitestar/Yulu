import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildClaudeSessionCommand,
  buildCodexSessionCommand,
  buildHermesConnectorConfig,
  buildHermesSessionCommand,
  buildOpenClawSessionCommand,
  extractHermesSessionId,
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

  it("runs Hermes with the scoped connector home and removes it afterward", async () => {
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
    writeFileSync(fakeHermes, [
      "#!/bin/sh",
      "grep -q '  zulip:' \"$HERMES_HOME/config.yaml\" || exit 41",
      "if grep -q '  notion:' \"$HERMES_HOME/config.yaml\"; then exit 42; fi",
      "printf '%s\\n' \"$HERMES_HOME\"",
    ].join("\n"));
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
    });

    const scopedHome = result.stdout.trim();
    expect(result.code).toBe(0);
    expect(scopedHome).toMatch(/yulu-hermes-connector-/);
    expect(existsSync(scopedHome)).toBe(false);
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
