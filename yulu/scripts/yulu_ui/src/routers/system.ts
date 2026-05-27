import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { openDb } from "../db.js";

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

  audioDevices: publicProcedure.query(async () => {
    const { stdout, code } = await runSpawn("system_profiler", ["SPAudioDataType", "-json"]);
    if (code !== 0) return { input: [], output: [] };
    try {
      const parsed = JSON.parse(stdout) as { SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }> };
      const items = parsed.SPAudioDataType?.[0]?._items ?? [];
      const input: Array<{ uid: string; name: string }> = [];
      const output: Array<{ uid: string; name: string }> = [];
      for (const item of items) {
        const name = String(item._name ?? "");
        const uid = String(item.coreaudio_device_uid ?? "");
        if (!name || !uid) continue;
        if (item.coreaudio_device_input !== undefined) input.push({ uid, name });
        if (item.coreaudio_device_output !== undefined) output.push({ uid, name });
      }
      return { input, output };
    } catch {
      return { input: [], output: [] };
    }
  }),

  dbStats: publicProcedure.query(({ ctx }) => {
    const entries: Array<{ name: "prompts" | "vocab" | "search"; mainTable: string; path: string }> = [
      { name: "prompts", mainTable: "prompts", path: ctx.paths.promptsDb },
      { name: "vocab",   mainTable: "vocab",   path: ctx.paths.vocabDb },
      { name: "search",  mainTable: "docs",    path: ctx.paths.searchDb },
    ];
    return entries.map(({ name, mainTable, path }) => {
      if (!existsSync(path)) return { name, path, size: 0, rows: null as number | null };
      let size = 0; try { size = statSync(path).size; } catch { /* ignore */ }
      let rows: number | null = null;
      try {
        const db = openDb(path);
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${mainTable}`).get() as { n: number };
          rows = row?.n ?? 0;
        } finally { db.close(); }
      } catch { rows = null; }
      return { name, path, size, rows };
    });
  }),

  logPaths: publicProcedure.query(({ ctx }) => {
    const names = ["audiodaemon", "sttdaemon", "agentqueue", "statusagent", "scheduler", "detector", "calendar", "ui"];
    return names.map((name) => ({ name, path: `${ctx.paths.configDir}/${name}.log` }));
  }),
});
