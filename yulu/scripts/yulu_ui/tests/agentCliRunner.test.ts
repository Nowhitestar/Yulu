import { describe, expect, it } from "vitest";
import {
  buildClaudeSessionCommand,
  buildCodexSessionCommand,
  buildHermesSessionCommand,
  buildOpenClawSessionCommand,
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
      "--query",
      "总结昨天的会议",
    ]);
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
