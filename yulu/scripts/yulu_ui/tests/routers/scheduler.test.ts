import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerRouter } from "../../src/routers/scheduler.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_scheduler_"));
  return {
    dir,
    ctx: {
      paths: { configDir: dir },
      launchctl: {
        status: vi.fn(async (label: string) => label === "com.yulu.scheduler"
          ? { pid: 42, exitStatus: 0, label }
          : null),
      },
    } as unknown as AppContext,
  };
}

describe("schedulerRouter", () => {
  it("reads schedule.json events and daemon status", async () => {
    const { dir, ctx } = makeCtx();
    writeFileSync(join(dir, "schedule.json"), JSON.stringify({
      events: [{ kind: "ask_record", at: "2026-06-25T10:00:00", title: "Design" }],
      meetings: [{ id: "m1", title: "Design", start: "2026-06-25T10:00:00", attendees: ["a@example.com"] }],
    }), "utf8");

    const r = await createCaller(schedulerRouter, ctx).overview();

    expect(r.exists).toBe(true);
    expect(r.events[0].kind).toBe("ask_record");
    expect(r.meetings[0].attendees).toEqual(["a@example.com"]);
    expect(r.schedulerStatus.pid).toBe(42);
  });

  it("reload reports missing pid file without throwing", async () => {
    const { ctx } = makeCtx();
    const r = await createCaller(schedulerRouter, ctx).reload();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pid file");
  });
});
