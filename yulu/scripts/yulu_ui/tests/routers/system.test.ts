import { describe, it, expect, beforeEach, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

import { systemRouter } from "../../src/routers/system.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

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

describe("systemRouter", () => {
  it("version() returns the yulu_ui package version", async () => {
    const caller = createCaller(systemRouter, {} as AppContext);
    const v = await caller.version();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.name).toBe("yulu-ui");
  });
});

describe("system.pickFile", () => {
  it("returns the chosen path for mode=folder", async () => {
    mockSpawn("/Users/me/Movies/Yulu\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBe("/Users/me/Movies/Yulu");
    expect(spawnMock.mock.calls[0]![0]).toBe("osascript");
  });

  it("returns the chosen path for mode=file with filter", async () => {
    mockSpawn("/x/y.bin\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "file", filter: "bin" });
    expect(r.path).toBe("/x/y.bin");
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain('"bin"');
  });

  it("returns null on user-cancel (non-zero exit)", async () => {
    mockSpawn("", 1, "User canceled.");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBeNull();
  });
});

describe("system.openInFinder", () => {
  it("spawns `open <path>` when reveal=false", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.openInFinder({ path: "/x/y" });
    expect(r.ok).toBe(true);
    expect(spawnMock.mock.calls[0]![0]).toBe("open");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["/x/y"]);
  });

  it("spawns `open -R <path>` when reveal=true", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    await caller.openInFinder({ path: "/x/y.txt", reveal: true });
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-R", "/x/y.txt"]);
  });
});
