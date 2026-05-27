import { describe, it, expect, vi, beforeEach } from "vitest";
import { integrationsRouter } from "../../src/routers/integrations.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

describe("integrationsRouter.test", () => {
  it("spawns python3 -m yulu.calendar.detect --provider <p> --json", async () => {
    mockSpawn(JSON.stringify({ ok: true }));
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "feishu" });
    expect(r.ok).toBe(true);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--provider");
    expect(args).toContain("feishu");
    expect(args).toContain("--json");
  });

  it("returns ok=false when python exits non-zero", async () => {
    mockSpawn("", 1, "ModuleNotFoundError: yulu.calendar");
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "google" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("ModuleNotFoundError");
  });

  it("includes stdout + stderr in the response", async () => {
    mockSpawn("hello\n", 0, "warning: x\n");
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "feishu" });
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("warning: x\n");
  });
});
