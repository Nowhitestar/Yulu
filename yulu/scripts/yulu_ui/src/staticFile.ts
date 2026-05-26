import { createReadStream, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Readable } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".ico":  "image/x-icon",
  ".map":  "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serve a single file from disk, optionally under a fixed name (used for
 * SPA fallback where the request URL doesn't map to a file). Supports HTTP
 * Range so the audio file routes can keep using the same helper.
 */
export function serveStaticFile(req: Request, baseDir: string, fixedName?: string): Response {
  const url = new URL(req.url);
  const rel = fixedName ?? decodeURIComponent(url.pathname.replace(/^\/(?:assets\/)?/, ""));
  // Guard against ../ traversal
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const path = join(baseDir, rel);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const stat = statSync(path);
  if (!stat.isFile()) return new Response("not found", { status: 404 });

  const type = mimeFor(path);
  const range = req.headers.get("range");
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type":   type,
        "Accept-Ranges":  "bytes",
        // hash-named asset chunks are immutable; index.html should not be cached this long
        "Cache-Control":  fixedName === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
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
      "Content-Type":   type,
    },
  });
}
