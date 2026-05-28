import { spawn } from "node:child_process";
import { router, publicProcedure } from "../trpc.js";

function runSpawnWithStdin(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdin.write(stdin);
    proc.stdin.end();
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

export const llmRouter = router({
  test: publicProcedure.mutation(async ({ ctx }) => {
    const cfg = ctx.config.read();
    if (!cfg.llm?.enabled) {
      return { ok: false, stdout: "", stderr: "llm.enabled is false in config" };
    }
    const command = cfg.llm?.command ?? [];
    if (command.length === 0) {
      return { ok: false, stdout: "", stderr: "llm.command is empty" };
    }
    const [cmd, ...args] = command;
    const { stdout, stderr, code } = await runSpawnWithStdin(cmd!, args, "hello, world\n", 30_000);
    return { ok: code === 0, stdout, stderr };
  }),
});
