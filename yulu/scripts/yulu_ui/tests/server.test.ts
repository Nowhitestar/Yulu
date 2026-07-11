import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";
import { startServer, type RunningServer } from "../src/server.js";
import { notionMcpPendingPath, notionMcpTokenPath } from "../src/notionMcpOAuth.js";

function rawHttp(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));

let env: { root: string; cleanup: () => void; server: RunningServer; baseUrl: string };

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "yulu_srv_"));
  const configDir = join(root, ".config", "yulu");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(HERE, "fixtures/config.json"), join(configDir, "config.json"));

  // Stub minimum DBs so lazy openDb doesn't fail if accessed
  for (const f of ["prompts.sqlite", "vocab.sqlite", "search.sqlite"]) {
    const db = new Database(join(configDir, f));
    db.close();
  }

  const moviesDir = join(root, "Movies", "Yulu");
  mkdirSync(moviesDir, { recursive: true });
  process.env.HOME = root;
  process.env.YULU_UI_PORT = "0";
  const server = await startServer({
    configDir,
    configFile: join(configDir, "config.json"),
    promptsDb: join(configDir, "prompts.sqlite"),
    vocabDb: join(configDir, "vocab.sqlite"),
    searchDb: join(configDir, "search.sqlite"),
    moviesDir,
    agentQueueJson: join(configDir, "agent-queue.json"),
    mcpTokenJson: join(configDir, "mcp-token.json"),
  });
  const port = server.address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  env = { root, cleanup: () => rmSync(root, { recursive: true, force: true }), server, baseUrl };
});

afterAll(async () => { await env.server.close(); env.cleanup(); });

describe("server", () => {
  it("/healthz returns ok", async () => {
    const r = await fetch(`${env.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok" });
  });

  it("/trpc/system.version returns version", async () => {
    const r = await fetch(`${env.baseUrl}/trpc/system.version`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { data: { name: string } } };
    expect(body.result.data.name).toBe("yulu-ui");
  });

  it("rejects non-localhost via Host header guard", async () => {
    const r = await rawHttp(env.server.address.port, "/healthz", "evil.com:7777");
    expect(r.status).toBe(403);
  });

  it("/mcp requires the Yulu bearer token", async () => {
    const r = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  it("/mcp rejects a wrong bearer token", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const r = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  it("/mcp initializes with the correct token", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const body = await mcpPost("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    }) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("yulu");
  });

  it("/mcp lists Yulu tools without destructive delete tools", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const body = await mcpPost("tools/list") as { result?: { tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("recording_get");
    expect(names).toContain("recording_summarize");
    expect(names).not.toContain("recording_delete");
  });

  it("/mcp exposes recording text without WAV bytes", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const moviesDir = join(env.root, "Movies", "Yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.wav"), Buffer.alloc(44));
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.transcript.txt"), "hello transcript");
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.summary.md"), "# hello summary");

    const call = await mcpPost("tools/call", { name: "recording_get", arguments: { stem: "McpRec_20260101_120000" } }) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const recording = JSON.parse(call.result?.content?.[0]?.text ?? "{}");
    expect(recording.transcript).toBe("hello transcript");
    expect(recording.summary).toBe("# hello summary");
    expect(recording.wavPath).toBeUndefined();

    const list = await mcpPost("tools/call", { name: "recordings_list", arguments: { limit: 5 } }) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.parse(list.result?.content?.[0]?.text ?? "[]").some((row: { stem?: string }) => row.stem === "McpRec_20260101_120000")).toBe(true);

    const summary = await mcpPost("resources/read", { uri: "yulu://recordings/McpRec_20260101_120000/summary" }) as {
      result?: { contents?: Array<{ text?: string }> };
    };
    expect(summary.result?.contents?.[0]?.text).toBe("# hello summary");
  });

  it("serves /assets/* from dist/web/assets with the right Content-Type", async () => {
    // Bootstrap a fake built UI directory for this test
    const distWeb = join(env.root, "dist/web/assets");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "smoke.css"), ".x{color:red}");
    process.env.YULU_UI_DIST_WEB = join(env.root, "dist/web");

    const r = await fetch(`${env.baseUrl}/assets/smoke.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/css/);
    expect(await r.text()).toContain("color:red");
  });

  it("serves the built favicon instead of the SPA fallback", async () => {
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    process.env.YULU_UI_DIST_WEB = distWeb;

    const r = await fetch(`${env.baseUrl}/favicon.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(await r.text()).toContain("<svg");
  });

  it("falls back to index.html for unknown SPA paths", async () => {
    // Ensure index.html exists
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "index.html"), "<!doctype html><html><body>SPA</body></html>");
    process.env.YULU_UI_DIST_WEB = distWeb;

    const r = await fetch(`${env.baseUrl}/inbox/voicemails`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toContain("SPA");
  });

  it("503s when SPA index.html is missing (dev-without-build scenario)", async () => {
    // Point at a path guaranteed not to contain an index.html so we don't
    // rely on the package's actual `dist/web` being absent (it isn't, in dev).
    process.env.YULU_UI_DIST_WEB = join(env.root, "definitely-no-build-here");
    const r = await fetch(`${env.baseUrl}/some/unknown/path`);
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/UI not built/);
  });

  it("/api/voice-chat/ask creates and continues a chat session", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    config.llm = { enabled: false, command: null };
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));

    const r = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello agent" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; sessionId: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeTruthy();
    expect(body.url).toBe(`/voice-chat?session=${encodeURIComponent(body.sessionId)}`);

    const next = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "second turn", sessionId: body.sessionId }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json() as { ok: boolean; sessionId: string; url: string };
    expect(nextBody.ok).toBe(true);
    expect(nextBody.sessionId).toBe(body.sessionId);
    expect(nextBody.url).toBe(body.url);

    const store = JSON.parse(readFileSync(join(configDir, "agent-sessions.json"), "utf8"));
    const session = store.sessions.find((item: { id: string }) => item.id === body.sessionId);
    expect(session.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("/api/voice-chat/ask can return immediately and answer in the background", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const r = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "deferred hello", defer: true }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; deferred: boolean; sessionId: string; answer: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.deferred).toBe(true);
    expect(body.answer).toBe("");
    expect(body.url).toBe(`/voice-chat?session=${encodeURIComponent(body.sessionId)}`);

    let roles: string[] = [];
    for (let i = 0; i < 20; i++) {
      const store = JSON.parse(readFileSync(join(configDir, "agent-sessions.json"), "utf8"));
      const session = store.sessions.find((item: { id: string }) => item.id === body.sessionId);
      roles = session?.messages.map((m: { role: string }) => m.role) ?? [];
      if (roles.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("falls back to index.html for deep multi-segment SPA paths", async () => {
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "index.html"), "<!doctype html><html><body>SPA</body></html>");
    process.env.YULU_UI_DIST_WEB = distWeb;

    for (const p of ["/inbox/voicemails", "/health/daemons", "/a/b/c/d/e"]) {
      const r = await fetch(`${env.baseUrl}${p}`);
      expect(r.status, `path ${p}`).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      expect(await r.text()).toContain("SPA");
    }
  });

  it("handles Notion MCP OAuth callback without exposing token values", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(notionMcpPendingPath(configDir), JSON.stringify({
      state: "state-123",
      codeVerifier: "verifier",
      clientId: "client",
      redirectUri: `${env.baseUrl}/integrations/notion/callback`,
      tokenEndpoint: "https://auth.notion.test/token",
      authorizationEndpoint: "https://auth.notion.test/authorize",
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }));
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: "access-secret", refresh_token: "refresh-secret", token_type: "Bearer" }),
      text: async () => "",
    })) as unknown as typeof fetch;
    try {
      const r = await rawHttp(env.server.address.port, "/integrations/notion/callback?code=abc&state=state-123", `127.0.0.1:${env.server.address.port}`);

      expect(r.status, r.body).toBe(200);
      expect(r.body).toContain("Notion connected");
      expect(r.body).not.toContain("access-secret");
      expect(existsSync(notionMcpTokenPath(configDir))).toBe(true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

function parseMcpResponse(text: string): unknown {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

async function mcpPost(method: string, params?: unknown): Promise<unknown> {
  const r = await fetch(`${env.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(r.status).toBe(200);
  return parseMcpResponse(await r.text());
}
