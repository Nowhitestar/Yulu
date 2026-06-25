import { router, publicProcedure } from "../trpc.js";
import { runLlmCommand } from "../llmCommand.js";
import { normalizeLegacyAgentCommand } from "../agentRuntime.js";

export const llmRouter = router({
  test: publicProcedure.mutation(async ({ ctx }) => {
    const cfg = ctx.config.read();
    if (!cfg.llm?.enabled) {
      return { ok: false, stdout: "", stderr: "llm.enabled is false in config" };
    }
    const command = cfg.llm?.command ?? null;
    if (!Array.isArray(command) || command.length === 0) {
      return { ok: false, stdout: "", stderr: "llm.command is not configured; Ask Yulu will auto-detect the local Agent CLI" };
    }
    const normalized = normalizeLegacyAgentCommand(command.map(String));
    const { stdout, stderr, code } = await runLlmCommand(normalized, ctx.paths.scriptDir, "hello, world\n", 30_000);
    return { ok: code === 0, stdout, stderr };
  }),
});
