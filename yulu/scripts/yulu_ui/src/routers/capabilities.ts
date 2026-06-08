import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
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
type Capability = z.infer<typeof capabilitySchema>;

const modelSchema = z.object({
  name: z.string(),
  path: z.string(),
  size: z.number(),
});
type DetectedModel = z.infer<typeof modelSchema>;

const DEGRADED: HostCapabilities = { schema_version: 1, capabilities: {} };
const VERIFICATION_CACHE = "capability-verifications.json";
const VERIFICATION_TTL_MS = 6 * 60 * 60 * 1000;

const verifyResultSchema = z.object({
  capability: z.string(),
  ok: z.boolean(),
  status: z.string(),
  detail: z.string(),
  verified_at: z.string().optional(),
});
type VerifyResult = z.infer<typeof verifyResultSchema>;

type VerificationCacheEntry = {
  status: "usable";
  detail: string;
  verified_at: string;
};

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

// A tiny read-only program: import Yulu's OWN host-capability collector and print only
// that section as JSON. Full doctor.py also checks git, daemons, UI health, and DBs; a
// fresh/preview install can make those slower than the settings panel timeout even when
// the host-capability probes themselves are quick and valid.
const HOST_CAPABILITIES_PY =
  "import json,sys; from pathlib import Path; from doctor import _host_capabilities; json.dump(_host_capabilities(Path(sys.argv[1]), Path.home()/'.yulu'), sys.stdout)";

// A tiny read-only program: import Yulu's OWN list_models() and print it as JSON. Detection stays
// in Python (one-way layer dependency capabilities/ -> UI) — we do NOT re-glob model roots in TS.
const LIST_MODELS_PY =
  "import json,sys; from capabilities.probes import list_models; json.dump(list_models(), sys.stdout)";

// Manual runtime verification: unlike host_capabilities, this is intentionally not a passive
// probe. It asks the running STT daemon to warm MLX once, proving that the installed package can
// actually execute in the daemon context. The socket path is fixed under configDir; no user command
// or config value is executed.
const VERIFY_MLX_PY =
  "import sys; from pathlib import Path; from stt_cli import main; sys.exit(main(['--socket', str(Path(sys.argv[1])/'stt_daemon.sock'), 'warm-up', '--engine', 'mlx', '--timeout', '60']))";

// Diarization verification builds and warms the managed sherpa-onnx pipeline against the fixed
// Yulu model dir. It is the runtime counterpart to probe_diarization's read-only model/import check.
const VERIFY_DIARIZATION_PY =
  "import asyncio,sys; from pathlib import Path; from stt_daemon.backends.diarize import resolve_model_paths, SherpaDiarizeBackend; d=Path(sys.argv[1])/'models'; seg,emb=resolve_model_paths(d); b=SherpaDiarizeBackend(seg_model=str(seg), emb_model=str(emb)); asyncio.run(b.warm_up()); print('diarization runtime warm-up verified')";

function canonicalCapability(name: string): "mlx_whisper" | "diarization" | null {
  if (name === "mlx_whisper" || name.endsWith("_mlx_whisper")) return "mlx_whisper";
  if (name === "diarization") return "diarization";
  return null;
}

function verificationCachePath(configDir: string): string {
  return join(configDir, VERIFICATION_CACHE);
}

function readVerificationCache(configDir: string): Record<string, VerificationCacheEntry> {
  try {
    const path = verificationCachePath(configDir);
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, VerificationCacheEntry>;
  } catch {
    return {};
  }
}

function writeVerificationCache(configDir: string, cache: Record<string, VerificationCacheEntry>): void {
  try {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(verificationCachePath(configDir), JSON.stringify(cache, null, 2) + "\n");
  } catch {
    // Verification still succeeded; a cache write failure only means the next query may show the
    // passive "present, unverified" status again.
  }
}

function overlayVerifiedCapabilities(report: HostCapabilities, configDir: string): HostCapabilities {
  const cache = readVerificationCache(configDir);
  const now = Date.now();
  const capabilities: Record<string, Capability> = { ...report.capabilities };
  for (const [name, cap] of Object.entries(capabilities)) {
    const canonical = canonicalCapability(name);
    if (!canonical || cap.status === "absent") continue;
    const entry = cache[canonical];
    if (!entry || entry.status !== "usable") continue;
    const verifiedAt = Date.parse(entry.verified_at);
    if (!Number.isFinite(verifiedAt) || now - verifiedAt > VERIFICATION_TTL_MS) continue;
    capabilities[name] = {
      ...cap,
      status: "usable",
      detail: entry.detail,
    };
  }
  return { ...report, capabilities };
}

export const capabilitiesRouter = router({
  // SET-01 / D-01: shell Yulu's read-only host-capability collector.
  // Spawns ONLY Yulu's own detection code — never a value from config.llm.command /
  // config.transcription.cloud_command (T-04-EX). Degrades to a typed error, never throws.
  host_capabilities: publicProcedure.query(async ({ ctx }): Promise<HostCapabilities> => {
    const { stdout, code } = await runSpawn(
      PYTHON,
      ["-c", HOST_CAPABILITIES_PY, ctx.paths.configDir],
      pyEnv(ctx.paths.scriptDir),
      SPAWN_TIMEOUT_MS,
    );
    // Do NOT gate on `code`: the Python collector may still emit a valid degraded
    // `{schema_version, capabilities, error}` shape. Parse stdout first and only
    // degrade when it is genuinely absent/unparseable.
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (e) {
      return {
        ...DEGRADED,
        error:
          code !== 0
            ? `host capability probe exited ${code} with no parseable output: ${String(e)}`
            : `host capability output was not valid JSON: ${String(e)}`,
      };
    }
    const result = hostCapabilitiesSchema.safeParse(parsed);
    if (!result.success) {
      return { ...DEGRADED, error: `host_capabilities shape mismatch: ${result.error.message}` };
    }
    return overlayVerifiedCapabilities(result.data, ctx.paths.configDir);
  }),

  verify: publicProcedure
    .input(z.object({ capability: z.string() }))
    .mutation(async ({ ctx, input }): Promise<VerifyResult> => {
      const canonical = canonicalCapability(input.capability);
      if (!canonical) {
        return {
          capability: input.capability,
          ok: false,
          status: "present-but-unverified",
          detail: "runtime verification is not available for this capability",
        };
      }

      const program = canonical === "mlx_whisper" ? VERIFY_MLX_PY : VERIFY_DIARIZATION_PY;
      const timeoutMs = canonical === "mlx_whisper" ? 65_000 : 120_000;
      const { stdout, stderr, code } = await runSpawn(
        PYTHON,
        ["-c", program, ctx.paths.configDir],
        pyEnv(ctx.paths.scriptDir),
        timeoutMs,
      );
      const detail = (stdout || stderr || `verification exited ${code}`).trim();
      if (code !== 0) {
        return {
          capability: canonical,
          ok: false,
          status: "present-but-unverified",
          detail,
        };
      }

      const verifiedAt = new Date().toISOString();
      const cache = readVerificationCache(ctx.paths.configDir);
      cache[canonical] = {
        status: "usable",
        detail: detail || "runtime warm-up verified",
        verified_at: verifiedAt,
      };
      writeVerificationCache(ctx.paths.configDir, cache);

      return verifyResultSchema.parse({
        capability: canonical,
        ok: true,
        status: "usable",
        detail: cache[canonical].detail,
        verified_at: verifiedAt,
      });
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
