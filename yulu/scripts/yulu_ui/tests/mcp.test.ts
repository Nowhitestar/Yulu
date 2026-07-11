import { describe, expect, it, vi } from "vitest";
import type { IncomingMessage } from "node:http";
import type { AppContext } from "../src/trpc.js";
import {
  isMcpRequest,
  recordingArtifactMcpServer,
  recordingDeliveryMcpServer,
  stopRecordingAndEnqueue,
} from "../src/mcp.js";
import { RecordingPipelinePolicyDisabledError } from "../src/recordingPipeline.js";

function context(
  config: Record<string, unknown>,
  enqueueCompletion = vi.fn(() => ({ task: { id: "task-1", state: "queued" }, created: true })),
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

  it("enqueues the final path and prefers explicit Agent pipeline Notion consent", async () => {
    const enqueueCompletion = vi.fn(() => ({ task: { id: "task-1", state: "queued" }, created: true }));
    const ctx = context({
      agent_pipeline: { auto_send_notion: false },
    }, enqueueCompletion);

    const result = await stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "done\nFINAL_RECORDING_PATH=/Users/test/Movies/Yulu/Team_20260711_120000.wav\n",
      stderr: "",
    }));

    expect(enqueueCompletion).toHaveBeenCalledWith({
      audioPath: "/Users/test/Movies/Yulu/Team_20260711_120000.wav",
      sendToNotion: false,
    });
    expect(result.pipeline).toEqual({ taskId: "task-1", state: "queued", created: true, sendToNotion: false });
  });

  it.each([
    [{ agent_pipeline: { auto_send_notion: true } }, true],
    [{ agent_pipeline: { auto_send_notion: false } }, false],
  ])("uses the migrated Agent pipeline consent", async (config, expected) => {
    const enqueueCompletion = vi.fn(() => ({ task: { id: "task-1", state: "queued" }, created: true }));
    const ctx = context(config, enqueueCompletion);

    await stopRecordingAndEnqueue(ctx, async () => ({
      ok: true,
      stdout: "FINAL_RECORDING_PATH=/Users/test/Movies/Yulu/Team_20260711_120000.wav\n",
      stderr: "",
    }));

    expect(enqueueCompletion).toHaveBeenCalledWith(expect.objectContaining({ sendToNotion: expected }));
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
});
