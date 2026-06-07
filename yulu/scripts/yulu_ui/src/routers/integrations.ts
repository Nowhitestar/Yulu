import { spawn } from "node:child_process";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

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

export const integrationsRouter = router({
  // Test that calendar integration works by running Yulu's OWN check_meetings.py
  // in `json` mode. It reads config.json, queries `gog` for the enabled Google
  // calendars and prints the events as JSON — exactly the path the scheduler uses.
  // PYTHONPATH points at scriptDir (no hardcoded/personal path) so check_meetings
  // and its imports resolve. `json` is a POSITIONAL command, never a --provider flag.
  // Google is the only supported calendar provider (Feishu was a dead stub,
  // removed in P4a-4). The provider is accepted for forward-compat but the test
  // path is provider-agnostic (it runs Yulu's own check_meetings.py).
  test: publicProcedure
    .input(z.object({ provider: z.enum(["google"]) }))
    .mutation(async ({ ctx }) => {
      const { stdout, stderr, code } = await runSpawn(
        "python3",
        [join(ctx.paths.scriptDir, "check_meetings.py"), "json"],
        { ...process.env, PYTHONPATH: ctx.paths.scriptDir },
        10_000,
      );
      return { ok: code === 0, stdout, stderr };
    }),
});
