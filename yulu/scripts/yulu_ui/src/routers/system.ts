import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
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

function runSpawn(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export const systemRouter = router({
  version: publicProcedure.query(() => ({
    name: PKG.name,
    version: PKG.version,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
  })),

  pickFile: publicProcedure
    .input(z.object({
      mode: z.enum(["file", "folder"]),
      filter: z.enum(["wav", "bin", "json", "pem"]).optional(),
    }))
    .mutation(async ({ input }) => {
      let script: string;
      if (input.mode === "folder") {
        script = 'POSIX path of (choose folder with prompt "Choose a folder")';
      } else {
        const ofType = input.filter ? ` of type {"${input.filter}"}` : "";
        script = `POSIX path of (choose file with prompt "Choose a file"${ofType})`;
      }
      const { stdout, code } = await runSpawn("osascript", ["-e", script]);
      if (code !== 0) return { path: null };
      const path = stdout.trim();
      return { path: path || null };
    }),

  openInFinder: publicProcedure
    .input(z.object({ path: z.string(), reveal: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const args = input.reveal ? ["-R", input.path] : [input.path];
      await runSpawn("open", args);
      return { ok: true as const };
    }),
});
