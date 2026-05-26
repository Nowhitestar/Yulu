import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { router, publicProcedure } from "../trpc.js";

// esbuild inlines these via `define` at build time. In dev (tsx) the
// identifiers are undefined and we fall back to reading package.json.
declare const __YULU_UI_NAME__: string | undefined;
declare const __YULU_UI_VERSION__: string | undefined;

const PKG = resolvePkg();

function resolvePkg(): { name: string; version: string } {
  if (typeof __YULU_UI_NAME__ === "string" && typeof __YULU_UI_VERSION__ === "string") {
    return { name: __YULU_UI_NAME__, version: __YULU_UI_VERSION__ };
  }
  // Dev fallback: walk up from this file until we find package.json.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const rel of ["package.json", "../package.json", "../../package.json"]) {
    const p = join(here, rel);
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8")) as { name: string; version: string };
  }
  return { name: "yulu-ui", version: "0.0.0" };
}

export const systemRouter = router({
  version: publicProcedure.query(() => ({
    name: PKG.name,
    version: PKG.version,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
  })),
});
