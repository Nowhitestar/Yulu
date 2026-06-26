import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { queueRouter } from "../../src/routers/queue.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx(entries: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "yulu_queue_"));
  const queue = join(dir, "agent-queue.json");
  writeFileSync(queue, `${JSON.stringify(entries, null, 2)}\n`, "utf8");
  return {
    queue,
    ctx: { paths: { agentQueueJson: queue } } as unknown as AppContext,
  };
}

describe("queueRouter", () => {
  it("lists queue entries with normalized pending status", async () => {
    const { ctx } = makeCtx([{ id: "a", type: "summary_request", title: "Weekly", prompt_slug: "summary" }]);
    const r = await createCaller(queueRouter, ctx).list();
    expect(r.total).toBe(1);
    expect(r.entries[0].status).toBe("pending");
    expect(r.stats.pending).toBe(1);
  });

  it("retry resets an error entry to pending", async () => {
    const { ctx, queue } = makeCtx([{ id: "a", status: "error", error: "boom", processing_by: "worker" }]);
    await createCaller(queueRouter, ctx).retry({ id: "a" });
    const [entry] = JSON.parse(readFileSync(queue, "utf8"));
    expect(entry.status).toBe("pending");
    expect(entry.error).toBeUndefined();
    expect(entry.processing_by).toBeUndefined();
  });

  it("cancel marks an entry as error", async () => {
    const { ctx, queue } = makeCtx([{ id: "a", status: "processing", processing_at: "2020-01-01T00:00:00" }]);
    await createCaller(queueRouter, ctx).cancel({ id: "a" });
    const [entry] = JSON.parse(readFileSync(queue, "utf8"));
    expect(entry.status).toBe("error");
    expect(entry.error).toContain("cancelled");
  });

  it("clearStale requeues old processing entries", async () => {
    const { ctx, queue } = makeCtx([{ id: "a", status: "processing", processing_at: "2020-01-01T00:00:00" }]);
    const r = await createCaller(queueRouter, ctx).clearStale();
    const [entry] = JSON.parse(readFileSync(queue, "utf8"));
    expect(r.count).toBe(1);
    expect(entry.status).toBe("pending");
    expect(entry.processing_at).toBeUndefined();
  });
});
