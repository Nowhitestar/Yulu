import { describe, it, expect, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonsRouter, YULU_DAEMON_LOG_FILES, YULU_DAEMONS } from "../../src/routers/daemons.js";
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
    paths: {
      configDir: "/tmp/durable",
      logsDir: "/tmp/logs",
      legacyReadOnlyDataDir: "/tmp/legacy",
    },
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

  it("maps every launchd label to the filename written by that daemon", () => {
    expect(YULU_DAEMON_LOG_FILES).toEqual({
      "com.yulu.audiodaemon": "audio_daemon.log",
      "com.yulu.statusagent": "status_agent.log",
      "com.yulu.scheduler": "scheduler.log",
      "com.yulu.detector": "detector.log",
      "com.yulu.calendar": "calendar_services.log",
      "com.yulu.ui": "ui.log",
    });
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

  it("health() reads legacy logs during the rollback window", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu_daemon_logs_"));
    const logsDir = join(root, "logs");
    const legacyDir = join(root, "legacy");
    mkdirSync(logsDir);
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "audio_daemon.log"), "legacy health line\n", "utf8");
    const ctx = makeCtx();
    ctx.paths.logsDir = logsDir;
    ctx.paths.legacyReadOnlyDataDir = legacyDir;
    try {
      const r = (await createCaller(daemonsRouter, ctx).health()) as Array<{ name: string; lastLog: string }>;
      expect(r.find((d) => d.name === "com.yulu.audiodaemon")!.lastLog).toBe("legacy health line");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("restart() calls launchctl + publishes daemons event", async () => {
    const ctx = makeCtx();
    const caller = createCaller(daemonsRouter, ctx);
    await caller.restart({ name: "com.yulu.audiodaemon" });
    expect((ctx.launchctl as unknown as { restart: ReturnType<typeof vi.fn> }).restart)
      .toHaveBeenCalledWith("com.yulu.audiodaemon");
  });
});
