import { describe, expect, it, vi } from "vitest";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { startRecordingNotifications } from "../src/recordingNotifications.js";
import type { AgentTask, ArtifactRecord } from "../src/hostStore.js";

function setup(state: AgentTask["state"] = "completed") {
  const pubsub = new PubSub<AppChannels>();
  const task = { id: "task1", state, title: "Product Sync", recordingStem: "sync_20260918", attempt: 1 } as AgentTask;
  const store = {
    getTask: vi.fn(() => task),
    listArtifacts: vi.fn(() => [{ kind: "summary" }] as ArtifactRecord[]),
    isArtifactPublishPending: vi.fn(() => false),
  };
  const send = vi.fn(async () => ({ ok: true }));
  const warn = vi.fn();
  const stop = startRecordingNotifications({ store, pubsub, send, warn, socketPath: "/unused" });
  const publish = (state: AppChannels["jobs"]["state"] = "done") =>
    pubsub.publish("jobs", { jobId: task.id, stem: task.recordingStem, state, error: "private provider trace" });
  return { pubsub, task, store, send, warn, stop, publish };
}

describe("native recording notifications", () => {
  it("only announces committed summaries, deduplicates, and removes the listener on shutdown", () => {
    const s = setup();
    s.publish(); s.publish();
    expect(s.send).toHaveBeenCalledExactlyOnceWith({
      action: "notify", kind: "summary_ready", id: "task1:1:summary_ready", title: "Product Sync", stem: "sync_20260918",
    });
    s.stop();
    s.task.attempt++;
    s.publish();
    expect(s.send).toHaveBeenCalledTimes(1);
  });

  it.each(["running", "artifacts_committed", "failed", "cancelled"] as const)("does not trust a done event in durable state %s", (state) => {
    const s = setup(state); s.publish(); expect(s.send).not.toHaveBeenCalled();
  });

  it("requires an actual summary commit with publication complete", () => {
    const s = setup();
    s.store.listArtifacts.mockReturnValue([]);
    s.publish(); expect(s.send).not.toHaveBeenCalled();
    s.store.listArtifacts.mockReturnValue([{ kind: "summary" }] as ArtifactRecord[]);
    s.store.isArtifactPublishPending.mockReturnValue(true);
    s.publish(); expect(s.send).not.toHaveBeenCalled();
  });

  it("keeps progress and automatic recovery silent, and ignores mismatched recordings", () => {
    const s = setup("awaiting_agent");
    s.publish("failed"); s.publish("transcribing"); s.publish("summarizing");
    s.task.state = "completed";
    s.pubsub.publish("jobs", { jobId: s.task.id, stem: "other", state: "done" });
    expect(s.send).not.toHaveBeenCalled();
  });

  it.each(["failed", "awaiting_provider", "execution_unverified"] as const)("surfaces actionable %s without leaking provider traces", (state) => {
    const s = setup(state); s.publish("failed"); s.publish("failed");
    expect(s.send).toHaveBeenCalledTimes(1);
    expect(s.send.mock.calls[0]).toEqual([{ action: "notify", kind: "processing_attention", id: "task1:1:processing_attention", title: "Product Sync", stem: "sync_20260918" }]);
  });

  it("does not replay historical status on subscription or fail committed work if App IPC is unavailable", async () => {
    const s = setup();
    s.send.mockRejectedValueOnce(new Error("private socket path"));
    expect(s.send).not.toHaveBeenCalled();
    s.publish();
    await vi.waitFor(() => expect(s.warn).toHaveBeenCalledWith("[notifications] Yulu App notification unavailable"));
    expect(s.task.state).toBe("completed");
  });
  it("isolates notification lookup failures from the publishing task", () => {
    const s = setup();
    s.store.getTask.mockImplementation(() => { throw new Error("private database path"); });
    expect(() => s.publish()).not.toThrow();
    expect(s.send).not.toHaveBeenCalled();
    expect(s.task.state).toBe("completed");
    expect(s.warn).toHaveBeenCalledWith("[notifications] Yulu App notification unavailable");
  });

});
