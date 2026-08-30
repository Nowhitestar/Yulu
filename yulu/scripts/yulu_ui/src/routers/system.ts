import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { openDb } from "../db.js";
import { ipcSend } from "../ipc.js";
import { YULU_DAEMON_LOG_SOURCES } from "../daemonLogs.js";

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

// ── cloud.detect: read-only cloud-sync-root detection (DATA-03) ──
//
// Mirrors capabilities.ts's safe python-spawn idiom: bare `python3` on PATH with
// PYTHONPATH=scriptDir so `yulu_platform` is importable, and a SIGKILL timeout so a
// hung subprocess can never block folder selection. Detection lives in Python (one-way
// layer dependency yulu_platform -> UI); TS never re-derives the path-prefix rules.
const PYTHON = "python3";
const CLOUD_DETECT_TIMEOUT_MS = 10_000;

// Read-only program: import Yulu's OWN is_cloud_root and print its CloudRootResult as
// JSON. Security V5 / T-05-07: the candidate path is USER INPUT — it is read from
// sys.argv[1] (a SEPARATE spawn argv element below), NEVER concatenated into this `-c`
// body or any shell command. is_cloud_root() itself expanduser+resolves and bounds the
// scan; it is metadata-only (os.stat, no open()) so detection never materializes a
// dataless file.
const CLOUD_DETECT_PY =
  "import json,sys; from yulu_platform.macos.cloud_detect import is_cloud_root; " +
  "r=is_cloud_root(sys.argv[1]); " +
  "json.dump({'is_cloud':r.is_cloud,'engine':r.engine,'reason':r.reason,'dataless':r.dataless_sample}, sys.stdout)";

function runSpawnEnv(
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

// The detection result shape the UI binds to, with a typed degraded default so a
// detection failure (spawn error / timeout / bad JSON / off-Darwin) can NEVER block the
// folder picker (Plan 04 calls pickFile then cloud.detect on the chosen path).
const cloudDetectSchema = z.object({
  is_cloud: z.boolean(),
  engine: z.string(),
  reason: z.string(),
  dataless: z.boolean(),
});
type CloudDetect = z.infer<typeof cloudDetectSchema>;

const CLOUD_DETECT_DEGRADED: CloudDetect = {
  is_cloud: false,
  engine: "",
  reason: "detection unavailable",
  dataless: false,
};

const audioDeviceReplySchema = z.object({
  input: z.array(z.object({ uid: z.string().min(1), name: z.string().min(1) })).default([]),
  output: z.array(z.object({ uid: z.string().min(1), name: z.string().min(1) })).default([]),
  error: z.string().optional(),
});

// P3-1 (About block): format the install source the way version.py's
// format_version does — "release <version>" / "dev <branch>" — or null when the
// install file is absent/malformed (e.g. a plain dev checkout).
function formatInstallSource(install: unknown): string | null {
  if (install == null || typeof install !== "object") return null;
  const i = install as Record<string, unknown>;
  if (i.source === "release" && typeof i.version === "string" && i.version) {
    return `release ${i.version}`;
  }
  if (i.source === "dev" && typeof i.branch === "string" && i.branch) {
    return `dev ${i.branch}`;
  }
  return null;
}

export const systemRouter = router({
  version: publicProcedure.query(() => ({
    name: PKG.name,
    version: PKG.version,
    node: process.version,
    uptimeSec: Math.floor(process.uptime()),
  })),

  // The PRODUCT version (repo-root VERSION file), not the yulu_ui package
  // version above. Read-only; never throws — a missing/unreadable VERSION
  // degrades to "unknown" and a missing install file → installSource: null, so
  // the About block always renders.
  yuluVersion: publicProcedure.query(({ ctx }): { version: string; installSource: string | null } => {
    let version = "unknown";
    try {
      const raw = readFileSync(ctx.paths.versionFile, "utf8").trim();
      if (raw) version = raw;
    } catch { /* missing/unreadable → "unknown" */ }

    let installSource: string | null = null;
    try {
      const parsed = JSON.parse(readFileSync(ctx.paths.installJson, "utf8"));
      installSource = formatInstallSource(parsed);
    } catch { /* absent/malformed → null */ }

    return { version, installSource };
  }),

  pickFile: publicProcedure
    .input(z.object({
      mode: z.enum(["file", "folder"]),
      filter: z.enum(["wav", "bin", "json", "pem", "onnx"]).optional(),
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

  audioDevices: publicProcedure.query(async ({ ctx }) => {
    try {
      const parsed = audioDeviceReplySchema.parse(
        await ipcSend(ctx.paths.audioDaemonSock, { action: "audio_devices" }),
      );
      if (parsed.error) return { input: [], output: [], error: parsed.error };
      return { input: parsed.input, output: parsed.output, error: null };
    } catch (error) {
      return {
        input: [],
        output: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }),

  dbStats: publicProcedure.query(({ ctx }) => {
    const entries: Array<{ name: "prompts" | "vocab" | "search"; mainTable: string; path: string }> = [
      { name: "prompts", mainTable: "prompts", path: ctx.paths.promptsDb },
      { name: "vocab",   mainTable: "custom_words", path: ctx.paths.vocabDb },
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
    return YULU_DAEMON_LOG_SOURCES.map(({ shortName, filename }) => ({
      name: shortName,
      path: `${ctx.paths.logsDir}/${filename}`,
    }));
  }),

  // DATA-03: classify a candidate data-folder against the macOS cloud-sync roots so the
  // folder picker (Plan 04) can WARN before accepting it. READ-ONLY (os.stat only, no
  // writes to the user's cloud). Spawns python3 read-only with the path passed as a
  // SEPARATE argv element (Security V5 / T-05-07 — never shell-interpolated), parses the
  // JSON result, and degrades to a typed not-cloud default on ANY failure so detection
  // can never block folder selection.
  cloud: router({
    detect: publicProcedure
      .input(z.object({ path: z.string().min(1) }))
      .query(async ({ input, ctx }): Promise<CloudDetect> => {
        const { stdout, code } = await runSpawnEnv(
          PYTHON,
          // input.path is the LAST argv element (read via sys.argv[1] in the python
          // body) — it is NOT interpolated into CLOUD_DETECT_PY or a shell string.
          ["-c", CLOUD_DETECT_PY, input.path],
          { ...process.env, PYTHONPATH: ctx.paths.scriptDir },
          CLOUD_DETECT_TIMEOUT_MS,
        );
        if (code !== 0) return CLOUD_DETECT_DEGRADED;
        try {
          const parsed = JSON.parse(stdout);
          const result = cloudDetectSchema.safeParse(parsed);
          return result.success ? result.data : CLOUD_DETECT_DEGRADED;
        } catch {
          return CLOUD_DETECT_DEGRADED;
        }
      }),
  }),
});
