import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

function runSpawn(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? "/Users/liaoyuxing/.yulu/yulu/scripts" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

export const integrationsRouter = router({
  test: publicProcedure
    .input(z.object({ provider: z.enum(["feishu", "google"]) }))
    .mutation(async ({ input }) => {
      const { stdout, stderr, code } = await runSpawn(
        "python3",
        ["-m", "yulu.calendar.detect", "--provider", input.provider, "--json"],
        10_000,
      );
      return { ok: code === 0, stdout, stderr };
    }),
});
