import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Hono } from "hono";
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Readable } from "node:stream";
import { appRouter } from "./routers/_app.js";
import { ConfigManager } from "./config.js";
import { LaunchctlClient } from "./launchctl.js";
import { openDb } from "./db.js";
import { appPubSub } from "./pubsub.js";
import { paths } from "./paths.js";
import { mountWsMultiplexer } from "./ws.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { startLogTailer } from "./logTailer.js";
import { startRealtimeTailer } from "./realtimeTailer.js";
import { serveStaticFile } from "./staticFile.js";
import { homedir } from "node:os";
import type { AppContext } from "./trpc.js";
import { JobRegistry } from "./jobStatus.js";
import { exchangeCodeForTokens } from "./notionMcpOAuth.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunningServer {
  http: HttpServer;
  address: { port: number };
  close: () => Promise<void>;
}

type RuntimePaths = typeof paths;

export async function startServer(pathOverrides: Partial<RuntimePaths> = {}): Promise<RunningServer> {
  const port = Number(process.env.YULU_UI_PORT ?? 7777);
  const host = "127.0.0.1";
  const launchAgents = join(homedir(), "Library", "LaunchAgents");
  const runtimePaths = { ...paths, ...pathOverrides } as RuntimePaths;

  // Lazy DB getters so /healthz works even when the SQLite files aren't present yet
  let _prompts: ReturnType<typeof openDb> | null = null;
  let _vocab: ReturnType<typeof openDb> | null = null;
  let _search: ReturnType<typeof openDb> | null = null;
  const dbProxy: AppContext["db"] = {
    get prompts() { return (_prompts ??= openDb(runtimePaths.promptsDb)); },
    get vocab()   { return (_vocab ??= openDb(runtimePaths.vocabDb)); },
    get search()  { return (_search ??= openDb(runtimePaths.searchDb)); },
  };

  const jobRegistry = new JobRegistry();

  const ctx: AppContext = {
    config:    new ConfigManager(runtimePaths.configFile),
    launchctl: new LaunchctlClient(launchAgents),
    pubsub:    appPubSub,
    paths:     runtimePaths,
    jobs:      jobRegistry,
    db:        dbProxy,
  };

  const app = new Hono();

  // Host header guard — even though we listen on 127.0.0.1 only, browsers
  // can rebind via DNS. Refuse anything but localhost/127.0.0.1.
  app.use("*", async (c, next) => {
    const h = c.req.header("host") ?? "";
    const hostname = h.split(":")[0] ?? "";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return c.text("forbidden", 403);
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok", uptime: process.uptime() }));

  app.get("/integrations/notion/callback", async (c) => {
    try {
      await exchangeCodeForTokens({
        configDir: runtimePaths.configDir,
        callbackUrl: c.req.url,
      });
      return c.html("<!doctype html><html><body><h1>Notion connected</h1><p>You can close this window and return to Yulu.</p></body></html>");
    } catch (exc) {
      const message = (exc as Error).message;
      return c.html(`<!doctype html><html><body><h1>Notion connection failed</h1><p>${escapeHtml(message)}</p></body></html>`, 400);
    }
  });

  app.all("/trpc/*", (c) => fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => ctx,
    onError: ({ error, path }) => console.error(`[trpc] ${path}: ${error.message}`),
  }));

  app.get("/files/meetings/*",   (c) => streamAudio(c.req.raw, runtimePaths.moviesDir));

  // Looked up dynamically so tests can flip YULU_UI_DIST_WEB between cases.
  const distWebDir = () => process.env.YULU_UI_DIST_WEB ?? join(__dirname, "../dist/web");

  app.get("/assets/*", (c) => serveStaticFile(c.req.raw, join(distWebDir(), "assets")));

  // SPA fallback — return index.html for any unmatched GET path so React
  // Router can handle client-side routing (e.g. /inbox, /health/daemons).
  // `app.notFound` catches everything not handled above, including deep
  // multi-segment paths where `app.get("*")` can be unreliable across Hono versions.
  app.notFound((c) => {
    if (c.req.method !== "GET") return c.text("not found", 404);
    const indexPath = join(distWebDir(), "index.html");
    if (!existsSync(indexPath)) {
      return c.text("UI not built — run `npm run build` or use `npm run dev:web`", 503);
    }
    return serveStaticFile(c.req.raw, distWebDir(), "index.html");
  });

  const http = createServer((req, res) => bridgeNodeToFetch(req, res, (r) => Promise.resolve(app.fetch(r))));
  mountWsMultiplexer(http, appPubSub);

  const inboxWatcher = startInboxWatcher({
    moviesDir: runtimePaths.moviesDir,
    pubsub: appPubSub,
  });

  const logTailer = startLogTailer({
    configDir: runtimePaths.configDir,
    pubsub: appPubSub,
  });

  const realtimeTailer = startRealtimeTailer({
    moviesDir: runtimePaths.moviesDir,
    pubsub: appPubSub,
  });

  await new Promise<void>((resolve) => http.listen(port, host, resolve));
  const addr = http.address() as { port: number };
  return {
    http,
    address: addr,
    close: () => new Promise<void>((resolve) => {
      realtimeTailer.stop();
      logTailer.stop();
      inboxWatcher.stop();
      http.close(() => resolve());
    }),
  };
}

/**
 * Stream an audio file by name from baseDir, honoring HTTP Range requests
 * so the browser <audio> element can seek without re-downloading.
 */
function streamAudio(req: Request, baseDir: string): Response {
  const url = new URL(req.url);
  const file = basename(url.pathname);
  const path = join(baseDir, file);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const stat = statSync(path);
  const range = req.headers.get("range");
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      },
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end   = m && m[2] ? Number(m[2]) : stat.size - 1;
  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type":   "audio/wav",
      "Cache-Control":  "no-cache",
    },
  });
}

/**
 * Bridge Node's IncomingMessage/ServerResponse to a fetch-style handler.
 * Forwards method, headers, and body (for non-GET/HEAD).
 */
async function bridgeNodeToFetch(
  req: IncomingMessage,
  res: ServerResponse,
  fetchHandler: (req: Request) => Promise<Response>,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((vi) => headers.append(k, vi));
      else headers.set(k, v);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = { method, headers };
    if (hasBody) {
      init.body = Readable.toWeb(req) as unknown as ReadableStream;
      init.duplex = "half";
    }
    const request = new Request(url.toString(), init);
    const response = await fetchHandler(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end((e as Error).message);
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((s) => console.log(`[yulu_ui] listening on http://127.0.0.1:${s.address.port}`));
}
