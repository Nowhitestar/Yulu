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
  return { paths: { scriptDir: "/fake/yulu/scripts", configDir: "/fake/home/.config/yulu" } } as unknown as AppContext;
}

// A valid host_capabilities payload from the focused collector the settings UI uses.
const HOST_CAPABILITIES_JSON = JSON.stringify({
  schema_version: 1,
  capabilities: {
    claude: { provenance: "host-path", status: "usable", resolved_path: "/usr/local/bin/claude", detail: "" },
    models: { provenance: "yulu-managed", status: "absent", resolved_path: "", detail: "no whisper models found" },
    whisper_cli: { provenance: "absent", status: "absent", resolved_path: "", detail: "whisper-cli not on login PATH" },
  },
});

const MODELS_JSON = JSON.stringify([
  { name: "ggml-base.bin", path: "/root/ggml-base.bin", size: 2048 },
  { name: "ggml-large-v3.bin", path: "/root/ggml-large-v3.bin", size: 1024 },
]);

describe("capabilitiesRouter.host_capabilities", () => {
  it("returns the host_capabilities section from the focused collector (happy path)", async () => {
    mockSpawn(HOST_CAPABILITIES_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const r = await caller.host_capabilities();

    expect(r.schema_version).toBe(1);
    expect(r.capabilities.claude.status).toBe("usable");
    expect(r.error).toBeUndefined();

    // It spawned the python interpreter running Yulu's host-capability collector only.
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [, args] = spawnMock.mock.calls[0]!;
    const joined = (args as string[]).join(" ");
    expect(joined).toContain("_host_capabilities");
    expect(joined).toContain("/fake/home/.config/yulu");
  });

  it("resolves a TYPED error (never throws) when the collector exits non-zero / emits non-JSON", async () => {
    mockSpawn("not json at all", 1, "boom");
    const caller = createCaller(capabilitiesRouter, makeCtx());

    // Must NOT reject — the page never blanks on a doctor failure (SET-01 error path).
    const r = await caller.host_capabilities();
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
    expect(r.schema_version).toBe(1);
    expect(r.capabilities).toEqual({});
  });

  it("returns the section even when the collector EXITS NON-ZERO but emits a valid report", async () => {
    // The Python collector may degrade internally while still emitting the typed report.
    // The settings page must surface that report; the exit code alone must not blank it.
    mockSpawn(HOST_CAPABILITIES_JSON, 1, "a health check failed");
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const r = await caller.host_capabilities();
    expect(r.error).toBeUndefined();
    expect(r.schema_version).toBe(1);
    expect(r.capabilities.claude.status).toBe("usable");
    expect(r.capabilities.models.status).toBe("absent");
  });

  it("adds stable remediation metadata for missing provisionable and manual capabilities", async () => {
    mockSpawn(HOST_CAPABILITIES_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const r = await caller.host_capabilities();

    expect(r.capabilities.models.remediation).toEqual({
      action: "provision",
      subject: "models",
      reason: "no whisper models found",
    });
    expect(r.capabilities.whisper_cli.remediation).toEqual({
      action: "manual",
      subject: "whisper_cli",
      reason: "whisper-cli not on login PATH",
    });
    expect(r.capabilities.claude.remediation).toBeUndefined();
  });

  it("resolves a typed error when the collector output has the wrong shape", async () => {
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

describe("capabilitiesRouter.verify", () => {
  it("verifies MLX through the fixed stt daemon warm-up path", async () => {
    mockSpawn("warmed mlx\n");
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const result = await caller.verify({ capability: "agent_mlx_whisper" });

    expect(result.ok).toBe(true);
    expect(result.capability).toBe("mlx_whisper");
    expect(result.status).toBe("usable");
    expect(result.detail).toContain("warmed mlx");

    const [, args] = spawnMock.mock.calls[0]!;
    const joined = (args as string[]).join(" ");
    expect(joined).toContain("warm-up");
    expect(joined).toContain("stt_daemon.sock");
  });

  it("returns a typed failed verification result instead of throwing", async () => {
    mockSpawn("", 1, "daemon not reachable");
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const result = await caller.verify({ capability: "mlx_whisper" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("present-but-unverified");
    expect(result.detail).toContain("daemon not reachable");
  });
});

describe("capabilitiesRouter.provision", () => {
  it("provisions diarization by running Yulu's fixed setup_models script", async () => {
    mockSpawn("models ready\n");
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const result = await caller.provision({ capability: "diarization" });

    expect(result.ok).toBe(true);
    expect(result.capability).toBe("diarization");
    expect(result.status).toBe("usable");
    expect(result.detail).toContain("models ready");

    const [cmd, args, options] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("bash");
    expect((args as string[]).join(" ")).toContain("/fake/yulu/scripts/setup_models.sh release");
    expect((options as { env: NodeJS.ProcessEnv }).env.CONFIG_DIR).toBe("/fake/home/.config/yulu");
    expect((options as { env: NodeJS.ProcessEnv }).env.MODEL_DIR).toBe("/fake/home/.config/yulu/models");
  });

  it("provisions MLX by running Yulu's fixed setup_capabilities script", async () => {
    mockSpawn("mlx ready\n");
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const result = await caller.provision({ capability: "agent_mlx_whisper" });

    expect(result.ok).toBe(true);
    expect(result.capability).toBe("mlx_whisper");
    const [cmd, args] = spawnMock.mock.calls[0]!;
    expect(cmd).toBe("bash");
    expect((args as string[]).join(" ")).toContain("/fake/yulu/scripts/setup_capabilities.sh release");
  });

  it("returns a typed failed result for unsupported capabilities without spawning", async () => {
    const caller = createCaller(capabilitiesRouter, makeCtx());
    const result = await caller.provision({ capability: "claude" });

    expect(result.ok).toBe(false);
    expect(result.status).toBe("absent");
    expect(result.detail).toContain("not available");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("capabilitiesRouter trust boundary (TRANS-02 / T-04-EX)", () => {
  it("only ever spawns python running host_capabilities / list_models — NEVER a user-configured command", async () => {
    mockSpawn(HOST_CAPABILITIES_JSON);
    const caller = createCaller(capabilitiesRouter, makeCtx());
    await caller.host_capabilities();
    mockSpawn(MODELS_JSON);
    await caller.detected_models();

    // Every spawned program is the python interpreter; every argv references Yulu's own
    // detection code (_host_capabilities or capabilities.list_models) — never config.llm.command /
    // config.transcription.cloud_command values.
    for (const call of spawnMock.mock.calls) {
      const cmd = call[0] as string;
      const args = (call[1] as string[]).join(" ");
      expect(cmd).toMatch(/python3?$/);
      expect(args).toMatch(/_host_capabilities|list_models|capabilities/);
    }
  });
});
