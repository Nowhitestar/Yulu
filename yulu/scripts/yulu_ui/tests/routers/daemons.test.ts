import { describe, it, expect, vi } from "vitest";
import { daemonsRouter, YULU_DAEMONS } from "../../src/routers/daemons.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  return {
    launchctl: {
      status: vi.fn(async (label: string) =>
        label === "com.yulu.audiodaemon"
          ? { pid: 1001, exitStatus: 0, label }
          : null),
      restart: vi.fn(async () => undefined),
      stop:    vi.fn(async () => undefined),
      start:   vi.fn(async () => undefined),
    },
    paths: { configDir: "/tmp" },
    pubsub: { publish: vi.fn() },
  } as unknown as AppContext;
}

describe("daemonsRouter", () => {
  it("knows the 8 yulu daemons (7 existing + yulu_ui)", () => {
    expect(YULU_DAEMONS).toHaveLength(8);
    expect(YULU_DAEMONS).toContain("com.yulu.ui");
  });

  it("health() reports running vs stopped per launchctl", async () => {
    const caller = createCaller(daemonsRouter, makeCtx());
    const r = (await caller.health()) as Array<{ name: string; status: string; pid: number }>;
    const audio = r.find((d) => d.name === "com.yulu.audiodaemon")!;
    const stt   = r.find((d) => d.name === "com.yulu.sttdaemon")!;
    expect(audio.status).toBe("running");
    expect(audio.pid).toBe(1001);
    expect(stt.status).toBe("stopped");
  });

  it("restart() calls launchctl + publishes daemons event", async () => {
    const ctx = makeCtx();
    const caller = createCaller(daemonsRouter, ctx);
    await caller.restart({ name: "com.yulu.audiodaemon" });
    expect((ctx.launchctl as unknown as { restart: ReturnType<typeof vi.fn> }).restart)
      .toHaveBeenCalledWith("com.yulu.audiodaemon");
  });
});
