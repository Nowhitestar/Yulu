import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
