import { describe, it, expect, vi, beforeEach } from "vitest";
import { capabilitiesRouter } from "../../src/routers/capabilities.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

// Same Wave-0 harness as llm.test.ts: hoisted spawn mock + createCaller.
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

// Emit `stdout` then fire `close` with exitCode — mirrors the real spawn surface
// the router consumes (stdout.on("data"), on("close"), kill()).
function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function makeCtx() {
  return { paths: { scriptDir: "/fake/yulu/scripts" } } as unknown as AppContext;
}

// A valid doctor `--json` payload (only the host_capabilities slice the router reads).
const DOCTOR_JSON = JSON.stringify({
  some_other_section: { ok: true },
  host_capabilities: {
    schema_version: 1,
    capabilities: {
      claude: { provenance: "host-path", status: "usable", resolved_path: "/usr/local/bin/claude", detail: "" },
      models: { provenance: "yulu-managed", status: "usable", resolved_path: "/root", detail: "2 models, 3072 bytes" },
    },
  },
});

const MODELS_JSON = JSON.stringify([
  { name: "ggml-base.bin", path: "/root/ggml-base.bin", size: 2048 },
  { name: "ggml-large-v3.bin", path: "/root/ggml-large-v3.bin", size: 1024 },
]);

describe("capabilitiesRouter.host_capabilities", () => {
  it("returns the host_capabilities section from doctor --json (happy path)", async () => {
    mockSpawn(DOCTOR_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const r = await caller.host_capabilities();

    expect(r.schema_version).toBe(1);
    expect(r.capabilities.claude.status).toBe("usable");
    expect(r.error).toBeUndefined();

    // It spawned the python interpreter running doctor.py --json.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]!;
    const joined = (args as string[]).join(" ");
    expect(joined).toContain("doctor.py");
    expect(joined).toContain("--json");
  });

  it("resolves a TYPED error (never throws) when doctor exits non-zero / emits non-JSON", async () => {
    mockSpawn("not json at all", 1, "boom");
    const caller = createCaller(capabilitiesRouter, makeCtx());

    // Must NOT reject — the page never blanks on a doctor failure (SET-01 error path).
    const r = await caller.host_capabilities();
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
    expect(r.schema_version).toBe(1);
    expect(r.capabilities).toEqual({});
  });

  it("resolves a typed error when host_capabilities key is missing from doctor output", async () => {
    mockSpawn(JSON.stringify({ other: true }), 0);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const r = await caller.host_capabilities();
    expect(typeof r.error).toBe("string");
    expect(r.capabilities).toEqual({});
  });
});

describe("capabilitiesRouter.detected_models", () => {
  it("returns the parsed model list on success", async () => {
    mockSpawn(MODELS_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const models = await caller.detected_models();
    expect(Array.isArray(models)).toBe(true);
    expect(models).toHaveLength(2);
    expect(models[0]).toEqual({ name: "ggml-base.bin", path: "/root/ggml-base.bin", size: 2048 });
  });

  it("degrades to [] (no throw) on doctor/list_models failure", async () => {
    mockSpawn("traceback...", 1);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const models = await caller.detected_models();
    expect(models).toEqual([]);
  });
});

describe("capabilitiesRouter trust boundary (TRANS-02 / T-04-EX)", () => {
  it("only ever spawns python running doctor.py / list_models — NEVER a user-configured command", async () => {
    mockSpawn(DOCTOR_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    await caller.host_capabilities();
    mockSpawn(MODELS_JSON);
    await caller.detected_models();

    // Every spawned program is the python interpreter; every argv references Yulu's own
    // detection code (doctor.py or capabilities.list_models) — never config.llm.command /
    // config.transcription.cloud_command values.
    for (const call of spawnMock.mock.calls) {
      const cmd = call[0] as string;
      const args = (call[1] as string[]).join(" ");
      expect(cmd).toMatch(/python3?$/);
      expect(args).toMatch(/doctor\.py|list_models|capabilities/);
    }
  });
});
