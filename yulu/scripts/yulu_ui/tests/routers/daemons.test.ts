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
  it("knows the 6 current yulu daemons", () => {
    expect(YULU_DAEMONS).toHaveLength(6);
    expect(YULU_DAEMONS).toContain("com.yulu.ui");
    expect(YULU_DAEMONS).not.toContain("com.yulu.agentqueue");
    expect(YULU_DAEMONS).not.toContain("com.yulu.sttdaemon");
  });

  it("health() reports running vs stopped per launchctl", async () => {
    const caller = createCaller(daemonsRouter, makeCtx());
    const r = (await caller.health()) as Array<{ name: string; status: string; pid: number }>;
    const audio = r.find((d) => d.name === "com.yulu.audiodaemon")!;
    const statusAgent = r.find((d) => d.name === "com.yulu.statusagent")!;
    expect(audio.status).toBe("running");
    expect(audio.pid).toBe(1001);
    expect(statusAgent.status).toBe("stopped");
  });

  it("health() treats a daemon with a pid as running even when launchctl has a stale non-zero status", async () => {
    const ctx = makeCtx();
    (ctx.launchctl as unknown as { status: ReturnType<typeof vi.fn> }).status.mockImplementation(async (label: string) =>
      label === "com.yulu.audiodaemon"
        ? { pid: 4242, exitStatus: 1, label }
        : null,
    );
    const r = (await createCaller(daemonsRouter, ctx).health()) as Array<{ name: string; status: string }>;
    expect(r.find((d) => d.name === "com.yulu.audiodaemon")!.status).toBe("running");
  });

  it("restart() calls launchctl + publishes daemons event", async () => {
    const ctx = makeCtx();
    const caller = createCaller(daemonsRouter, ctx);
    await caller.restart({ name: "com.yulu.audiodaemon" });
    expect((ctx.launchctl as unknown as { restart: ReturnType<typeof vi.fn> }).restart)
      .toHaveBeenCalledWith("com.yulu.audiodaemon");
  });
});
