import { describe, expect, it } from "vitest";
import {
  buildClaudeSessionCommand,
  buildCodexSessionCommand,
  buildHermesSessionCommand,
  buildOpenClawSessionCommand,
  extractHermesSessionId,
} from "../src/agentCliRunner.js";

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
