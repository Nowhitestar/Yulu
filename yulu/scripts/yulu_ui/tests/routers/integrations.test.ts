import { describe, it, expect, vi, beforeEach } from "vitest";
import { integrationsRouter } from "../../src/routers/integrations.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { basename } from "node:path";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function ctx(): AppContext {
  return {
    uiMutationAuthorized: true,
    paths: { scriptDir: "/fake/yulu/scripts", configDir: "/fake/yulu/config" },
  } as unknown as AppContext;
}

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

describe("integrationsRouter Calendar Source authority", () => {
  it("does not expose the retired direct-script probe", () => {
    expect(Object.keys(integrationsRouter._def.procedures)).not.toContain("test");
  });
});

describe("integrationsRouter.calendarList", () => {
  it("lists Google calendars through fixed gog calendar calendars JSON argv", async () => {
    mockSpawn(JSON.stringify({
      items: [
        { id: "me@example.com", summary: "Primary", primary: true, selected: true },
        { id: "work@example.com", summary: "Work", selected: false },
      ],
    }));
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.calendarList({ account: "me@example.com" });

    expect(r.ok).toBe(true);
    expect(r.calendars).toEqual([
      { id: "primary", summary: "Primary", primary: true },
      { id: "work@example.com", summary: "Work", primary: false },
    ]);

    const call = spawnMock.mock.calls[0]!;
    expect(basename(String(call[0]))).toBe("gog");
    expect(call[1]).toEqual([
      "--json",
      "--results-only",
      "--no-input",
      "--account",
      "me@example.com",
      "calendar",
      "calendars",
      "--all",
    ]);
  });

  it("does not spawn gog when account is empty", async () => {
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.calendarList({ account: "" });

    expect(r.ok).toBe(false);
    expect(r.calendars).toEqual([]);
    expect(r.stderr).toContain("account");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns ok=false with stderr when gog calendar listing fails", async () => {
    mockSpawn("", 1, "not authenticated");
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.calendarList({ account: "me@example.com" });

    expect(r.ok).toBe(false);
    expect(r.calendars).toEqual([]);
    expect(r.stderr).toContain("not authenticated");
  });
});

describe("integrationsRouter.accountList", () => {
  it("lists gog-authenticated Google accounts through fixed auth list JSON argv", async () => {
    mockSpawn(JSON.stringify([
      { email: "me@example.com", services: ["calendar"] },
      { email: "other@example.com", services: ["gmail", "calendar"] },
    ]));
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.accountList();

    expect(r.ok).toBe(true);
    expect(r.accounts).toEqual([
      { email: "me@example.com", services: ["calendar"] },
      { email: "other@example.com", services: ["gmail", "calendar"] },
    ]);

    const call = spawnMock.mock.calls[0]!;
    expect(basename(String(call[0]))).toBe("gog");
    expect(call[1]).toEqual(["auth", "list", "--json", "--results-only", "--no-input"]);
  });

  it("returns ok=false with stderr when gog account listing fails", async () => {
    mockSpawn("", 1, "keyring unavailable");
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.accountList();

    expect(r.ok).toBe(false);
    expect(r.accounts).toEqual([]);
    expect(r.stderr).toContain("keyring unavailable");
  });
});

describe("integrationsRouter Calendar Source authority", () => {
  it("projects source selection and current readiness without changing either", async () => {
    const context = ctx();
    context.calendarSources = {
      view: vi.fn(() => ({
        selectedSource: null,
        sources: [
          { id: "macos", recommended: true, advanced: false, externalRuntime: false },
          { id: "gog", recommended: false, advanced: true, externalRuntime: true },
        ],
        readiness: { status: "untested", source: null, evidence: null },
      })),
    } as unknown as AppContext["calendarSources"];
    const caller = createCaller(integrationsRouter, context);

    await expect(caller.calendarSources()).resolves.toMatchObject({
      selectedSource: null,
      readiness: { status: "untested", source: null },
    });
    expect(context.calendarSources!.view).toHaveBeenCalledOnce();
  });

  it("selects and probes only through explicit UI mutations", async () => {
    const context = ctx();
    context.launchctl = { restart: vi.fn(async () => ({})) } as unknown as AppContext["launchctl"];
    const select = vi.fn(() => ({ selection: { source: "gog", account: "me@example.com" } }));
    const probe = vi.fn(async () => ({
      status: "ready",
      source: "gog",
      evidence: { source: "gog", adapter: "gog-cli", eventCount: 0 },
    }));
    const view = vi.fn(() => ({
      readiness: { status: "untested", source: "gog", evidence: null },
    }));
    context.calendarSources = { select, probe, view } as unknown as AppContext["calendarSources"];
    const caller = createCaller(integrationsRouter, context);

    await expect(caller.selectCalendarSource({ source: "gog", account: "me@example.com" }))
      .resolves.toMatchObject({ selection: { source: "gog" } });
    await expect(caller.probeCalendarSource()).resolves.toMatchObject({
      status: "ready",
      source: "gog",
      evidence: { eventCount: 0 },
    });
    expect(select).toHaveBeenCalledWith({ source: "gog", account: "me@example.com" });
    expect(probe).toHaveBeenCalledOnce();
  });

  it("fails readiness closed when a production polling service cannot restart", async () => {
    const context = ctx();
    context.launchctl = {
      restart: vi.fn(async (label: string) => {
        if (label === "com.yulu.calendar") throw new Error("service not found");
        return {};
      }),
    } as unknown as AppContext["launchctl"];
    const markServiceActivationFailed = vi.fn();
    context.calendarSources = {
      select: vi.fn(() => ({ selection: { source: "macos", account: null } })),
      markServiceActivationFailed,
      view: vi.fn(() => ({
        readiness: {
          status: "failed",
          source: "macos",
          reason: "service_activation_failed",
          evidence: null,
        },
      })),
    } as unknown as AppContext["calendarSources"];
    const caller = createCaller(integrationsRouter, context);

    await expect(caller.selectCalendarSource({ source: "macos" })).resolves.toMatchObject({
      restartErrors: [expect.stringContaining("com.yulu.calendar")],
      readiness: { status: "failed", reason: "service_activation_failed" },
    });
    expect(markServiceActivationFailed).toHaveBeenCalledWith([
      expect.stringContaining("com.yulu.calendar"),
    ]);
  });
});
