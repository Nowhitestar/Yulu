import { beforeEach, describe, expect, it, vi } from "vitest";
import { capabilitiesRouter } from "../../src/routers/capabilities.js";
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
    const process = {
      stdout: { on: (event: string, cb: (buffer: Buffer) => void) => { if (event === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (event: string, cb: (buffer: Buffer) => void) => { if (event === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (event: string, cb: (arg: unknown) => void) => { handlers.set(event, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return process;
  });
}

function context() {
  return {
    paths: {
      scriptDir: "/fake/yulu/scripts",
      configDir: "/fake/home/.config/yulu",
      durableDataDir: "/fake/home/Library/Application Support/Yulu",
    },
  } as unknown as AppContext;
}

const report = JSON.stringify({
  schema_version: 1,
  capabilities: {
    recording_dir: { provenance: "yulu-managed", status: "usable", resolved_path: "/Movies/Yulu", detail: "writable" },
    calendar: { provenance: "host-path", status: "usable", resolved_path: "/usr/bin/osascript", detail: "available" },
    claude: { provenance: "host-path", status: "usable", resolved_path: "/usr/local/bin/claude", detail: "" },
    models: { provenance: "yulu-managed", status: "absent", resolved_path: "", detail: "legacy" },
    whisper_cli: { provenance: "absent", status: "absent", resolved_path: "", detail: "legacy" },
    agent_mlx_whisper: { provenance: "agent-config", status: "usable", resolved_path: "/agent/mlx", detail: "legacy" },
    diarization: { provenance: "yulu-managed", status: "usable", resolved_path: "/models", detail: "legacy" },
  },
});

describe("capabilitiesRouter.host_capabilities", () => {
  it("returns general host capabilities and retires Yulu local transcription capabilities", async () => {
    mockSpawn(report);
    const result = await createCaller(capabilitiesRouter, context()).host_capabilities();

    expect(result.capabilities.recording_dir.status).toBe("usable");
    expect(result.capabilities.calendar.status).toBe("usable");
    expect(result.capabilities.claude.status).toBe("usable");
    expect(result.capabilities.models).toBeUndefined();
    expect(result.capabilities.whisper_cli).toBeUndefined();
    expect(result.capabilities.agent_mlx_whisper).toBeUndefined();
    expect(result.capabilities.diarization).toBeUndefined();

    const [command, args] = spawnMock.mock.calls[0]!;
    expect(command).toBe("python3");
    expect((args as string[]).join(" ")).toContain("_host_capabilities");
  });

  it("reads Host capability configuration from standard durable state, not the divergent legacy rollback", async () => {
    mockSpawn(report);

    await createCaller(capabilitiesRouter, context()).host_capabilities();

    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.at(-1)).toBe("/fake/home/Library/Application Support/Yulu");
    expect(args.at(-1)).not.toBe("/fake/home/.config/yulu");
  });

  it("accepts a valid degraded report even when the collector exits non-zero", async () => {
    mockSpawn(report, 1, "one check failed");
    const result = await createCaller(capabilitiesRouter, context()).host_capabilities();
    expect(result.error).toBeUndefined();
    expect(result.capabilities.recording_dir.status).toBe("usable");
  });

  it("returns a typed degraded result for invalid JSON or shape", async () => {
    mockSpawn("not json", 1, "boom");
    const caller = createCaller(capabilitiesRouter, context());
    await expect(caller.host_capabilities()).resolves.toMatchObject({ schema_version: 1, capabilities: {} });

    mockSpawn(JSON.stringify({ other: true }));
    await expect(caller.host_capabilities()).resolves.toMatchObject({ schema_version: 1, capabilities: {} });
  });
});
