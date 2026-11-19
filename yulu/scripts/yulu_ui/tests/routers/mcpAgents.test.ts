import { beforeEach, describe, expect, it, vi } from "vitest";
import { mcpAgentsRouter } from "../../src/routers/mcpAgents.js";
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
      stdout: { on: (event: string, cb: (buffer: Buffer) => void) => { if (event === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (event: string, cb: (buffer: Buffer) => void) => { if (event === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (event: string, cb: (arg: unknown) => void) => { handlers.set(event, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function caller(authorized = true) {
  return createCaller(mcpAgentsRouter, {
    uiMutationAuthorized: authorized,
    paths: { scriptDir: "/fake/yulu/scripts" },
  } as unknown as AppContext);
}

describe("mcpAgents router", () => {
  it("reports which Agents are present and registered, keeping unknown as null", async () => {
    mockSpawn(JSON.stringify({
      endpoint: "http://127.0.0.1:7777/mcp",
      tokenPresent: true,
      agents: {
        codex: { detected: true, configured: true },
        claude: { detected: true, configured: null },
        openclaw: { detected: false, configured: false },
      },
    }));
    const status = await caller().status();
    expect(status.available).toBe(true);
    expect(status.agents).toEqual([
      { id: "claude", detected: true, configured: null },
      { id: "codex", detected: true, configured: true },
      { id: "openclaw", detected: false, configured: false },
      { id: "hermes", detected: false, configured: null },
    ]);
    expect(spawnMock.mock.calls[0]![1].slice(0, 3)).toEqual(["-m", "provision.mcp", "status"]);
  });

  it("returns structured unavailability instead of throwing when the helper fails", async () => {
    mockSpawn("", 2, "boom");
    expect(await caller().status()).toEqual({ available: false, agents: [] });
    mockSpawn("not json");
    expect(await caller().status()).toEqual({ available: false, agents: [] });
  });

  it("registers exactly the requested Agent and never returns helper output", async () => {
    mockSpawn("Installing Yulu MCP for codex...\nAuthorization: Bearer secret-token", 0, "secret-token");
    const result = await caller().install({ agent: "codex" });
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain("secret-token");
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.slice(0, 5)).toEqual(["-m", "provision.mcp", "install", "--agent", "codex"]);
  });

  it("reports a failed registration or handshake as ok: false", async () => {
    mockSpawn("", 1);
    expect(await caller().install({ agent: "claude" })).toEqual({ ok: false });
    mockSpawn("", 1);
    expect(await caller().test()).toEqual({ ok: false });
  });

  it("rejects an unknown Agent and unauthorized mutations", async () => {
    await expect(caller().install({ agent: "evil; rm -rf" })).rejects.toThrow();
    await expect(caller(false).install({ agent: "codex" })).rejects.toThrow(/UI mutation bearer required/);
    await expect(caller(false).test()).rejects.toThrow(/UI mutation bearer required/);
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
