import { describe, it, expect, vi, beforeEach } from "vitest";
import { integrationsRouter } from "../../src/routers/integrations.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { basename } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notionMcpPendingPath } from "../../src/notionMcpOAuth.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function ctx(): AppContext {
  return { paths: { scriptDir: "/fake/yulu/scripts", configDir: "/fake/yulu/config" } } as unknown as AppContext;
}

function ctxWithConfigDir(configDir: string): AppContext {
  return { paths: { scriptDir: "/fake/yulu/scripts", configDir } } as unknown as AppContext;
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

describe("integrationsRouter.test", () => {
  it("spawns check_meetings.py with the `json` positional (no --provider) and PYTHONPATH=scriptDir", async () => {
    mockSpawn(JSON.stringify([]));
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.test({ provider: "google" });
    expect(r.ok).toBe(true);

    const call = spawnMock.mock.calls[0]!;
    expect(basename(String(call[0]))).toBe("python3");
    const args = call[1] as string[];
    // Runs Yulu's own check_meetings.py in JSON mode — `json` is a positional command.
    expect(args[0]).toBe("/fake/yulu/scripts/check_meetings.py");
    expect(args).toContain("json");
    // The dead `yulu.calendar.detect` module + the unsupported --provider flag are gone.
    expect(args).not.toContain("--provider");
    expect(args.join(" ")).not.toContain("yulu.calendar.detect");

    // PYTHONPATH is derived from ctx.paths.scriptDir — never a hardcoded/personal path.
    const opts = call[2] as { env?: Record<string, string> };
    expect(opts.env?.PYTHONPATH).toBe("/fake/yulu/scripts");
  });

  it("returns ok=false when check_meetings.py exits non-zero", async () => {
    mockSpawn("", 1, "Config not found");
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.test({ provider: "google" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("Config not found");
  });

  it("includes stdout + stderr in the response", async () => {
    mockSpawn("[]\n", 0, "warning: x\n");
    const caller = createCaller(integrationsRouter, ctx());
    const r = await caller.test({ provider: "google" });
    expect(r.stdout).toBe("[]\n");
    expect(r.stderr).toBe("warning: x\n");
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

describe("integrationsRouter.connectorStatus", () => {
  it("returns connector_capabilities from Yulu's fixed Python collector", async () => {
    mockSpawn(JSON.stringify({
      schema_version: 1,
      connectors: {
        notion: {
          connector_id: "notion",
          display_name: "Notion",
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/agent/plugins/notion",
          detail: "agent plugin detected",
          actions: ["summary.send"],
          config_prefix: "connectors.notion",
        },
      },
    }));
    const caller = createCaller(integrationsRouter, ctx());

    const r = await caller.connectorStatus();

    expect(r.connectors.notion.status).toBe("usable");
    expect(r.connectors.notion.actions).toEqual(["summary.send"]);
    const call = spawnMock.mock.calls[0]!;
    expect(basename(String(call[0]))).toBe("python3");
    const args = call[1] as string[];
    expect(args[0]).toBe("-c");
    expect(args.join(" ")).toContain("_connector_capabilities");
    const opts = call[2] as { env?: Record<string, string> };
    expect(opts.env?.PYTHONPATH).toBe("/fake/yulu/scripts");
  });

  it("degrades to an empty connector report when collector output is invalid", async () => {
    mockSpawn("not json", 1, "boom");
    const caller = createCaller(integrationsRouter, ctx());

    const r = await caller.connectorStatus();

    expect(r.schema_version).toBe(1);
    expect(r.connectors).toEqual({});
    expect(r.error).toContain("no parseable output");
  });
});

describe("integrationsRouter.outputDestinations", () => {
  it("lists Notion identity and destinations through the connector destination module", async () => {
    mockSpawn(JSON.stringify({
      ok: true,
      channel: "notion",
      identity: { label: "Ada Lovelace", detail: "ada@example.com" },
      destinations: [
        { id: "db-1", type: "database", label: "Team Notes", detail: "https://notion.so/db-1" },
      ],
    }));
    const caller = createCaller(integrationsRouter, ctx());

    const r = await caller.outputDestinations({ channel: "notion" });

    expect(r.ok).toBe(true);
    expect(r.identity).toEqual({ label: "Ada Lovelace", detail: "ada@example.com" });
    expect(r.destinations).toEqual([
      { id: "db-1", type: "database", label: "Team Notes", detail: "https://notion.so/db-1" },
    ]);
    const call = spawnMock.mock.calls[0]!;
    expect(basename(String(call[0]))).toBe("python3");
    expect(call[1]).toEqual(["-m", "connectors.destinations", "notion"]);
    const opts = call[2] as { env?: Record<string, string> };
    expect(opts.env?.PYTHONPATH).toBe("/fake/yulu/scripts");
  });

  it("degrades to ok=false when destination output is invalid", async () => {
    mockSpawn("not json", 1, "boom");
    const caller = createCaller(integrationsRouter, ctx());

    const r = await caller.outputDestinations({ channel: "zulip" });

    expect(r.ok).toBe(false);
    expect(r.destinations).toEqual([]);
    expect(r.error).toContain("destination probe exited");
  });
});

describe("integrationsRouter.notionMcpStartAuth", () => {
  it("returns a Notion MCP authorization URL and persists pending OAuth state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notion_mcp_router_"));
    vi.stubGlobal("fetch", async (url: string | URL | Request) => {
      if (String(url).endsWith("/.well-known/oauth-protected-resource")) {
        return { ok: true, status: 200, json: async () => ({ authorization_servers: ["https://auth.notion.test"] }), text: async () => "" };
      }
      if (String(url).endsWith("/.well-known/oauth-authorization-server")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            authorization_endpoint: "https://auth.notion.test/authorize",
            token_endpoint: "https://auth.notion.test/token",
            registration_endpoint: "https://auth.notion.test/register",
          }),
          text: async () => "",
        };
      }
      return { ok: true, status: 200, json: async () => ({ client_id: "client-123" }), text: async () => "" };
    });
    try {
      const caller = createCaller(integrationsRouter, ctxWithConfigDir(dir));
      const r = await caller.notionMcpStartAuth();

      const authUrl = new URL(r.authUrl);
      expect(authUrl.origin + authUrl.pathname).toBe("https://auth.notion.test/authorize");
      expect(authUrl.searchParams.get("client_id")).toBe("client-123");
      expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7777/integrations/notion/callback");
      expect(existsSync(notionMcpPendingPath(dir))).toBe(true);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
