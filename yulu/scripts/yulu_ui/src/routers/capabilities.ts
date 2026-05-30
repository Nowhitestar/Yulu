import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

// ── Shapes the UI binds to (Zod-typed). ──
//
// The host_capabilities query mirrors doctor's OWN never-raise contract: it ALWAYS resolves a
// renderable object — either the real Phase 3 report section or a degraded `{error, schema_version,
// capabilities: {}}`. It NEVER throws, so a doctor failure can never blank the settings page (SET-01).

const capabilitySchema = z.object({
  provenance: z.string(),
  status: z.string(),
  resolved_path: z.string(),
  detail: z.string(),
});

// `.passthrough()` + `.partial()` keeps us forward-compatible with the frozen Phase 3 report
// (new capability names flow through untouched) while still typing the known fields.
const hostCapabilitiesSchema = z.object({
  schema_version: z.number(),
  capabilities: z.record(z.string(), capabilitySchema.passthrough()),
  error: z.string().optional(),
});
type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

const modelSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
});
type DetectedModel = z.infer<typeof modelSchema>;

const DEGRADED: HostCapabilities = { schema_version: 1, capabilities: {} };

// doctor probes are subprocess-heavy; cap the wait so a hung/slow doctor never blocks or blanks
// the UI (T-04-DOS). On timeout we SIGKILL the child and the caller falls through to the typed error.
const SPAWN_TIMEOUT_MS = 10_000;

// Resolve python3 the way the other python-shelling routers do (integrations.ts / search.ts):
// bare `python3` on PATH, with PYTHONPATH pointed at scriptDir so `capabilities` is importable.
// doctor.py is stdlib-only, so the bare interpreter is correct — we do NOT bake in a venv path.
const PYTHON = "python3";

function pyEnv(scriptDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: scriptDir };
}

function runSpawn(
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

// A tiny read-only program: import Yulu's OWN list_models() and print it as JSON. Detection stays
// in Python (one-way layer dependency capabilities/ -> UI) — we do NOT re-glob model roots in TS.
const LIST_MODELS_PY =
  "import json,sys; from capabilities.probes import list_models; json.dump(list_models(), sys.stdout)";

export const capabilitiesRouter = router({
  // SET-01 / D-01: shell `doctor.py --json` and return its `host_capabilities` section.
  // Spawns ONLY Yulu's own doctor.py — never a value from config.llm.command /
  // config.transcription.cloud_command (T-04-EX). Degrades to a typed error, never throws.
  host_capabilities: publicProcedure.query(async ({ ctx }): Promise<HostCapabilities> => {
    const doctorPy = join(ctx.paths.scriptDir, "doctor.py");
    const { stdout, code } = await runSpawn(
      PYTHON,
      [doctorPy, "--json"],
      pyEnv(ctx.paths.scriptDir),
      SPAWN_TIMEOUT_MS,
    );
    if (code !== 0) {
      return { ...DEGRADED, error: `doctor.py exited with code ${code}` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      return { ...DEGRADED, error: `doctor.py output was not valid JSON: ${String(e)}` };
    }
    const section = (parsed as { host_capabilities?: unknown })?.host_capabilities;
    if (section === undefined || section === null) {
      return { ...DEGRADED, error: "doctor.py output missing host_capabilities section" };
    }
    const result = hostCapabilitiesSchema.safeParse(section);
    if (!result.success) {
      return { ...DEGRADED, error: `host_capabilities shape mismatch: ${result.error.message}` };
    }
    return result.data;
  }),

  // SET-04 (data half) / D-05: expose per-model name/path/size for the model selector (04-03).
  // Runs the read-only list_models() one-liner; degrades to [] on any failure (no throw).
  detected_models: publicProcedure.query(async ({ ctx }): Promise<DetectedModel[]> => {
    const { stdout, code } = await runSpawn(
      PYTHON,
      ["-c", LIST_MODELS_PY],
      pyEnv(ctx.paths.scriptDir),
      SPAWN_TIMEOUT_MS,
    );
    if (code !== 0) return [];
    try {
      const parsed = JSON.parse(stdout);
      const result = z.array(modelSchema).safeParse(parsed);
      return result.success ? result.data : [];
    } catch {
      return [];
    }
  }),
});
