import { spawn } from "node:child_process";
import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";

const remediationSchema = z.object({
  action: z.enum(["verify", "provision", "manual"]),
  subject: z.string(),
  reason: z.string(),
});

const capabilitySchema = z.object({
  provenance: z.string(),
  status: z.string(),
  resolved_path: z.string(),
  detail: z.string(),
  remediation: remediationSchema.optional(),
});

const hostCapabilitiesSchema = z.object({
  schema_version: z.number(),
  capabilities: z.record(z.string(), capabilitySchema.passthrough()),
  error: z.string().optional(),
});
type HostCapabilities = z.infer<typeof hostCapabilitiesSchema>;

const DEGRADED: HostCapabilities = { schema_version: 1, capabilities: {} };
const SPAWN_TIMEOUT_MS = 10_000;
const PYTHON = "python3";

const HOST_CAPABILITIES_PY =
  "import json,sys; from pathlib import Path; from doctor import _host_capabilities; json.dump(_host_capabilities(Path(sys.argv[1]), Path.home()/'.yulu'), sys.stdout)";

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
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

function isRetiredLocalTranscriptionCapability(name: string): boolean {
  return name === "models"
    || name === "diarization"
    || name === "mlx_whisper"
    || name === "whisper_cli"
    || name === "whisper-cli"
    || name.endsWith("_mlx_whisper");
}

function withoutRetiredLocalTranscription(report: HostCapabilities): HostCapabilities {
  return {
    ...report,
    capabilities: Object.fromEntries(
      Object.entries(report.capabilities).filter(([name]) => !isRetiredLocalTranscriptionCapability(name)),
    ),
  };
}

export const capabilitiesRouter = router({
  host_capabilities: publicProcedure.query(async ({ ctx }): Promise<HostCapabilities> => {
    const { stdout, code } = await runSpawn(
      PYTHON,
      ["-c", HOST_CAPABILITIES_PY, ctx.paths.durableDataDir],
      pyEnv(ctx.paths.scriptDir),
      SPAWN_TIMEOUT_MS,
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (error) {
      return {
        ...DEGRADED,
        error: code !== 0
          ? `host capability probe exited ${code} with no parseable output: ${String(error)}`
          : `host capability output was not valid JSON: ${String(error)}`,
      };
    }
    const result = hostCapabilitiesSchema.safeParse(parsed);
    if (!result.success) {
      return { ...DEGRADED, error: `host_capabilities shape mismatch: ${result.error.message}` };
    }
    return withoutRetiredLocalTranscription(result.data);
  }),
});
