import { afterEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/trpc.js";
import {
  isMcpRequest,
  isAuthorizedToken,
  recordingArtifactMcpServer,
  recordingDeliveryMcpServer,
  stopRecordingAndEnqueue,
} from "../src/mcp.js";
import { RecordingPipelinePolicyDisabledError } from "../src/recordingPipeline.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MCP token file authority", () => {
  it("rejects symbolic and non-private token files", () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-mcp-token-authority-"));
    roots.push(root);
    const canonicalRoot = realpathSync.native(root);
    const token = "private-mcp-token-value";
    const regular = join(canonicalRoot, "mcp-token.json");
    writeFileSync(regular, JSON.stringify({ token }), { mode: 0o600 });
    expect(isAuthorizedToken(regular, `Bearer ${token}`)).toBe(true);

    chmodSync(regular, 0o644);
    expect(isAuthorizedToken(regular, `Bearer ${token}`)).toBe(false);

    const external = join(canonicalRoot, "external-token.json");
    writeFileSync(external, JSON.stringify({ token }), { mode: 0o600 });
    const alias = join(canonicalRoot, "token-alias.json");
    symlinkSync(external, alias);
    expect(isAuthorizedToken(alias, `Bearer ${token}`)).toBe(false);
  });
});

function context(
  config: Record<string, unknown>,
  enqueueCompletion = vi.fn(() => ({
    task: { id: "task-1", recordingStem: "Team_20260711_120000", state: "queued" },
    created: true,
  })),
) {
  return {
    config: { read: () => config },
    recordingPipeline: { enqueueCompletion },
  } as unknown as AppContext;
}

describe("MCP recording_stop pipeline handoff", () => {
  it("does not enqueue when stopping the recorder fails", async () => {
    const enqueueCompletion = vi.fn();
    const ctx = context({}, enqueueCompletion);

    await expect(stopRecordingAndEnqueue(ctx, async () => {
      throw new Error("stop failed");
    })).rejects.toThrow("stop failed");

    expect(enqueueCompletion).not.toHaveBeenCalled();
  });

  it("does not enqueue when successful stop output lacks FINAL_RECORDING_PATH", async () => {
    const enqueueCompletion = vi.fn();
    const ctx = context({}, enqueueCompletion);

    await expect(stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "recording stopped\n",
      stderr: "",
    }))).rejects.toThrow("FINAL_RECORDING_PATH was missing");

    expect(enqueueCompletion).not.toHaveBeenCalled();
  });

  it("enqueues the final path without legacy automatic Share intent", async () => {
    const enqueueCompletion = vi.fn(() => ({
      task: { id: "task-1", recordingStem: "Team_20260711_120000", state: "queued" },
      created: true,
    }));
    const ctx = context({
      agent_pipeline: { auto_send_notion: false },
    }, enqueueCompletion);
    const onRecordingStopped = vi.fn();

    const result = await stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "done\nFINAL_RECORDING_PATH=/Users/test/Movies/Yulu/Team_20260711_120000.wav\n",
      stderr: "",
    }), onRecordingStopped);

    expect(onRecordingStopped).toHaveBeenCalledWith({
      audioPath: "/Users/test/Movies/Yulu/Team_20260711_120000.wav",
      recordingStem: "Team_20260711_120000",
    });
    expect(enqueueCompletion).toHaveBeenCalledWith({
      audioPath: "/Users/test/Movies/Yulu/Team_20260711_120000.wav",
    });
    expect(result.pipeline).toEqual({
      accepted: true,
      taskId: "task-1",
      recordingStem: "Team_20260711_120000",
      state: "queued",
      created: true,
      sendToNotion: false,
    });
  });

  it.each([
    { agent_pipeline: { auto_send_notion: true } },
    { agent_pipeline: { auto_send_notion: false } },
  ])("never carries legacy automatic-sharing authorization into manual or MCP completion", async (config) => {
    const enqueueCompletion = vi.fn(() => ({
      task: { id: "task-1", recordingStem: "Team_20260711_120000", state: "queued" },
      created: true,
    }));
    const ctx = context(config, enqueueCompletion);

    await stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "FINAL_RECORDING_PATH=/Users/test/Movies/Yulu/Team_20260711_120000.wav\n",
      stderr: "",
    }));

    expect(enqueueCompletion).toHaveBeenCalledWith({
      audioPath: "/Users/test/Movies/Yulu/Team_20260711_120000.wav",
    });
  });

  it.each([
    "Automatic Agent recording processing is paused by policy",
    "Agent recording pipeline is disabled by policy",
  ])("reports a successful stop when automatic pipeline intake is skipped: %s", async (reason) => {
    const enqueueCompletion = vi.fn(() => {
      throw new RecordingPipelinePolicyDisabledError(reason);
    });
    const ctx = context({ agent_pipeline: { auto_send_notion: false } }, enqueueCompletion);

    const result = await stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "FINAL_RECORDING_PATH=/Users/test/Movies/Yulu/Team_20260711_120000.wav\n",
      stderr: "",
    }));

    expect(result).toMatchObject({
      ok: true,
      pipeline: { accepted: false, permanent: true, reason, sendToNotion: false },
    });
  });
});

describe("phase-specific recording MCP capability boundaries", () => {
  function toolNames(server: unknown): string[] {
    return Object.keys((server as { _registeredTools: Record<string, unknown> })._registeredTools).sort();
  }

  it("routes only the general and two dedicated phase endpoints", () => {
    const req = (url: string) => ({ url, headers: { host: "127.0.0.1:7777" } }) as IncomingMessage;
    expect(isMcpRequest(req("/mcp"))).toBe(true);
    expect(isMcpRequest(req("/mcp/recording-artifact"))).toBe(true);
    expect(isMcpRequest(req("/mcp/recording-delivery"))).toBe(true);
    expect(isMcpRequest(req("/mcp/recording-pipeline"))).toBe(false);
  });

  it("exposes no delivery or arbitrary file tools on the artifact server", () => {
    expect(toolNames(recordingArtifactMcpServer({} as AppContext))).toEqual([
      "recording_artifact_commit",
      "recording_task_get",
      "recording_task_progress",
      "recording_task_summary_stage",
      "recording_task_transcript_read",
    ]);
  });

  it("exposes only committed-summary and delivery tools on the delivery server", () => {
    expect(toolNames(recordingDeliveryMcpServer({} as AppContext))).toEqual([
      "recording_begin_notion_delivery",
      "recording_commit_notion_delivery",
      "recording_committed_summary_read",
      "recording_task_get",
    ]);
  });

  it("rejects a Supported Agent identity before replacing committed artifacts", async () => {
    const recordProgress = vi.fn();
    const commitFromWorkspace = vi.fn();
    const server = recordingArtifactMcpServer({
      host: {
        getTask: () => ({
          id: "019f0000-0000-7000-8000-000000000132",
          leaseToken: "019f0000-0000-7000-8000-000000000133",
          summaryProvider: "codex",
          summaryModel: "runtime-managed",
        }),
        recordProgress,
      },
      artifacts: { commitFromWorkspace },
    } as unknown as AppContext);
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools.recording_artifact_commit!;

    await expect(tool.handler({
      taskId: "019f0000-0000-7000-8000-000000000132",
      leaseToken: "019f0000-0000-7000-8000-000000000133",
      summaryProvider: "claude-code",
      summaryModel: "runtime-managed",
    })).rejects.toThrow("different Summary Provider/model identity");
    expect(recordProgress).not.toHaveBeenCalled();
    expect(commitFromWorkspace).not.toHaveBeenCalled();
  });

  it("keeps a valid Supported Agent summary staged until the runtime identity is verified", async () => {
    const recordProgress = vi.fn(() => ({
      id: "019f0000-0000-7000-8000-000000000132",
      state: "transcript_committed",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }));
    const commitFromWorkspace = vi.fn();
    const recordArtifacts = vi.fn();
    const server = recordingArtifactMcpServer({
      host: {
        getTask: () => ({
          id: "019f0000-0000-7000-8000-000000000132",
          leaseToken: "019f0000-0000-7000-8000-000000000133",
          summaryProvider: "codex",
          summaryModel: "runtime-managed",
        }),
        recordProgress,
        recordArtifacts,
      },
      artifacts: { commitFromWorkspace },
    } as unknown as AppContext);
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools.recording_artifact_commit!;

    await expect(tool.handler({
      taskId: "019f0000-0000-7000-8000-000000000132",
      leaseToken: "019f0000-0000-7000-8000-000000000133",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    })).resolves.toBeDefined();
    expect(recordProgress).toHaveBeenCalledOnce();
    expect(commitFromWorkspace).not.toHaveBeenCalled();
    expect(recordArtifacts).not.toHaveBeenCalled();
  });

  it("accounts for Hermes artifacts in Host before publishing the public summary", async () => {
    const order: string[] = [];
    const task = {
      id: "019f0000-0000-7000-8000-000000000132",
      leaseToken: "019f0000-0000-7000-8000-000000000133",
      state: "transcript_committed",
      agentProvider: "hermes",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    };
    const records = [{ kind: "transcript" }, { kind: "summary" }];
    const prepareFromWorkspace = vi.fn(() => { order.push("prepare"); return records; });
    const recordArtifacts = vi.fn(() => { order.push("account"); return { ...task, state: "artifacts_committed" }; });
    const publishPreparedArtifacts = vi.fn(() => { order.push("publish"); });
    const markArtifactsPublished = vi.fn(() => { order.push("published"); });
    const server = recordingArtifactMcpServer({
      host: {
        getTask: () => task,
        recordProgress: () => task,
        recordArtifacts,
        markArtifactsPublished,
      },
      artifacts: { prepareFromWorkspace, publishPreparedArtifacts },
      pubsub: { publish: vi.fn() },
    } as unknown as AppContext);
    const tool = (server as unknown as {
      _registeredTools: Record<string, { handler: (input: Record<string, unknown>) => Promise<unknown> }>;
    })._registeredTools.recording_artifact_commit!;

    await expect(tool.handler({
      taskId: task.id,
      leaseToken: task.leaseToken,
    })).resolves.toBeDefined();

    expect(order).toEqual(["prepare", "account", "publish", "published"]);
  });
});
