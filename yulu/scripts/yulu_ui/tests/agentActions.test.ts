import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const mocks = vi.hoisted(() => ({
  run: vi.fn(async (input: {
    prompt?: string;
    hermesToolsets?: readonly string[];
    hermesConnector?: string;
    yuluSessionId?: string;
  }) => ({
    stdout: input.hermesToolsets?.includes("slack")
      ? '{"status":"sent","channel":"slack","destination":"#meetings","url":"","id":"msg-1"}'
      : "ok",
    stderr: "",
    code: 0,
    nativeSessionId: "native-1",
  })),
  create: vi.fn(),
  append: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../src/agentCliRunner.js", () => ({ runAgentCliCommand: mocks.run }));
vi.mock("../src/agentSessionStore.js", () => ({
  createAgentSession: mocks.create,
  appendAgentSessionMessage: mocks.append,
  updateAgentSessionNativeSession: mocks.update,
}));

import { runAgentShareSummary, runAgentSummarize } from "../src/agentActions.js";

const runtime = {
  provider: "hermes" as const,
  label: "Hermes",
  source: "auto-detected" as const,
  command: ["hermes"],
  cwd: "/tmp",
  disabledReason: null,
};

describe("manual Agent recording actions", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu-agent-action-"));
    let id = 0;
    mocks.create.mockReset().mockImplementation(() => ({ id: `session-${++id}` }));
    mocks.run.mockClear().mockImplementation(async (input) => ({
      stdout: input.hermesToolsets?.includes("slack")
        ? '{"status":"sent","channel":"slack","destination":"#meetings","url":"","id":"msg-1"}'
        : "ok",
      stderr: "",
      code: 0,
      nativeSessionId: "native-1",
    }));
    mocks.append.mockClear();
    mocks.update.mockClear();
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("grants Hermes only the requested share channel and starts a fresh session each time", async () => {
    const summaryPath = join(root, "summary.md");
    writeFileSync(summaryPath, "summary");
    const input = {
      configDir: root,
      scriptDir: root,
      runtime,
      channel: "slack",
      channelLabel: "Slack",
      summaryPath,
      title: "Weekly sync",
      destinationHint: "#meetings",
    };

    await runAgentShareSummary(input);
    const second = await runAgentShareSummary(input);

    expect(mocks.create).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenCalledTimes(2);
    expect(mocks.run).toHaveBeenLastCalledWith(expect.objectContaining({
      hermesToolsets: ["slack"],
      hermesConnector: "slack",
      yuluSessionId: "session-2",
    }));
    expect(second.delivery).toEqual({
      status: "sent",
      channel: "slack",
      destination: "#meetings",
      url: "",
      id: "msg-1",
    });
  });

  it("summarizes the supplied transcript without granting connector toolsets", async () => {
    const transcriptPath = join(root, "transcript.txt");
    writeFileSync(transcriptPath, "existing transcript");

    await runAgentSummarize({
      configDir: root,
      scriptDir: root,
      runtime,
      transcriptPath,
      title: "Weekly sync",
      instructions: "List decisions",
    });

    expect(mocks.run).toHaveBeenCalledWith(expect.objectContaining({
      hermesToolsets: ["yulu_artifact"],
      prompt: expect.stringContaining("existing transcript"),
    }));
    expect(String(mocks.run.mock.calls[0]?.[0]?.prompt)).toContain("do not transcribe audio, contact external services, or call tools");
  });

  it("passes the complete transcript to the summarizer", async () => {
    const transcriptPath = join(root, "long-transcript.txt");
    const transcript = `start-${"x".repeat(90_000)}-end`;
    writeFileSync(transcriptPath, transcript);

    await runAgentSummarize({
      configDir: root,
      scriptDir: root,
      runtime,
      transcriptPath,
      title: "Long meeting",
      instructions: "Summarize everything",
    });

    expect(String(mocks.run.mock.calls[0]?.[0]?.prompt)).toContain("-end");
  });

  it("rejects an unverified share response instead of claiming success", async () => {
    const summaryPath = join(root, "summary.md");
    writeFileSync(summaryPath, "summary");
    mocks.run.mockResolvedValueOnce({ stdout: "sent", stderr: "", code: 0, nativeSessionId: "native-1" });

    await expect(runAgentShareSummary({
      configDir: root,
      scriptDir: root,
      runtime,
      channel: "slack",
      channelLabel: "Slack",
      summaryPath,
      title: "Weekly sync",
      destinationHint: "#meetings",
    })).rejects.toThrow("verifiable JSON delivery receipt");
  });

  it("surfaces an explicit connector failure as a verified no-delivery failure", async () => {
    const summaryPath = join(root, "summary.md");
    writeFileSync(summaryPath, "summary");
    mocks.run.mockResolvedValueOnce({
      stdout: '{"status":"failed","channel":"slack","destination":"#meetings","error":"connector unavailable"}',
      stderr: "",
      code: 0,
      nativeSessionId: "native-1",
    });

    await expect(runAgentShareSummary({
      configDir: root,
      scriptDir: root,
      runtime,
      channel: "slack",
      channelLabel: "Slack",
      summaryPath,
      title: "Weekly sync",
      destinationHint: "#meetings",
    })).rejects.toMatchObject({ name: "AgentDeliveryFailedError", message: "connector unavailable" });
  });
});
