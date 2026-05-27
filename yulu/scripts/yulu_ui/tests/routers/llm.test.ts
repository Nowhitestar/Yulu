import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { llmRouter } from "../../src/routers/llm.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { ConfigManager } from "../../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const stdinWrites: string[] = [];
    const proc = {
      stdin: { write: (s: string) => stdinWrites.push(s), end: () => {} },
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
      __stdinWrites: stdinWrites,
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_llm_"));
  const path = join(dir, "config.json");
  cpSync(join(HERE, "../fixtures/config.json"), path);
  return { config: new ConfigManager(path) } as unknown as AppContext;
}

describe("llmRouter.test", () => {
  it("spawns config.llm.command + writes 'hello, world' on stdin", async () => {
    mockSpawn("Hi there\n");
    const caller = createCaller(llmRouter, makeCtx());
    const r = await caller.test();
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("Hi there\n");
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["--print"]);
    // Verify stdin write happened (read from mock instance)
    const procInstance = spawnMock.mock.results[0]!.value as { __stdinWrites: string[] };
    expect(procInstance.__stdinWrites.join("")).toBe("hello, world\n");
  });

  it("returns ok=false without spawning when llm.enabled=false", async () => {
    const ctx = makeCtx();
    ctx.config.update("llm.enabled", false);
    const caller = createCaller(llmRouter, ctx);
    const r = await caller.test();
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("llm.enabled is false");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when llm.command is empty", async () => {
    const ctx = makeCtx();
    ctx.config.update("llm.command", []);
    const caller = createCaller(llmRouter, ctx);
    const r = await caller.test();
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("llm.command is empty");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
