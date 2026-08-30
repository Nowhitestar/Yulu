import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { schedulerRouter } from "../../src/routers/scheduler.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const root = mkdtempSync(join(tmpdir(), "yulu_scheduler_"));
  const dir = join(root, "durable");
  const legacyDir = join(root, "legacy");
  const ipcDir = join(root, "ipc");
  mkdirSync(dir);
  mkdirSync(legacyDir);
  mkdirSync(ipcDir);
  return {
    dir,
    legacyDir,
    ipcDir,
    ctx: {
      paths: {
        configDir: legacyDir,
        durableDataDir: dir,
        legacyReadOnlyDataDir: legacyDir,
        ipcDir,
        scriptDir: root,
      },
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
    const { dir, ipcDir, ctx } = makeCtx();
    writeFileSync(join(dir, "schedule.json"), JSON.stringify({
      events: [{ kind: "ask_record", at: "2026-06-25T10:00:00", title: "Design" }],
      meetings: [{ id: "m1", title: "Design", start: "2026-06-25T10:00:00", attendees: ["a@example.com"] }],
    }), "utf8");
    writeFileSync(join(ipcDir, ".scheduler.pid"), "314", "utf8");

    const r = await createCaller(schedulerRouter, ctx).overview();

    expect(r.exists).toBe(true);
    expect(r.events[0].kind).toBe("ask_record");
    expect(r.meetings[0].attendees).toEqual(["a@example.com"]);
    expect(r.schedulerPid).toBe(314);
    expect(r.schedulerStatus.pid).toBe(42);
  });

  it("reload reports missing pid file without throwing", async () => {
    const { ctx } = makeCtx();
    const r = await createCaller(schedulerRouter, ctx).reload();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("pid file");
  });

  it("reads a legacy schedule only when the standard schedule is missing", async () => {
    const { legacyDir, ctx } = makeCtx();
    writeFileSync(join(legacyDir, "schedule.json"), JSON.stringify({
      events: [{ kind: "remind", at: "2026-06-25T09:55:00", title: "Legacy" }],
      meetings: [],
    }), "utf8");

    const r = await createCaller(schedulerRouter, ctx).overview();

    expect(r.exists).toBe(true);
    expect(r.schedulePath).toBe(join(legacyDir, "schedule.json"));
    expect(r.events[0].title).toBe("Legacy");
  });

  it("returns the current meeting and persists the primary action", async () => {
    const { dir, ctx } = makeCtx();
    const now = Date.now();
    writeFileSync(join(dir, "schedule.json"), JSON.stringify({
      events: [],
      meetings: [{
        id: "m-current",
        title: "Ops Weekly",
        start: new Date(now - 5 * 60_000).toISOString(),
        duration_min: 30,
        link: "https://meet.example/current",
      }],
    }), "utf8");

    const caller = createCaller(schedulerRouter, ctx);
    await caller.setPrimaryAction({ action: "record_join" });
    const r = await caller.current();

    expect(JSON.parse(readFileSync(join(dir, "meeting_prompt.json"), "utf8")).primary_action)
      .toBe("record_join");
    expect(r.primaryAction).toBe("record_join");
    expect(r.meeting.id).toBe("m-current");
    expect(r.meeting.link).toBe("https://meet.example/current");
  });
});
