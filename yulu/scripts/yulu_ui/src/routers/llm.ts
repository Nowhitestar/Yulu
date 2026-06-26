import { router, publicProcedure } from "../trpc.js";
import { runLlmCommand } from "../llmCommand.js";
import { normalizeLegacyAgentCommand } from "../agentRuntime.js";

export const llmRouter = router({
  test: publicProcedure.mutation(async ({ ctx }) => {
    const cfg = ctx.config.read();
    if (!cfg.llm?.enabled) {
      return { ok: false, stdout: "", stderr: "llm.enabled is false in config" };
    }
    const command = cfg.llm?.command;
    if (command == null) {
      return {
        ok: true,
        stdout: `Agent queue mode: summaries are written to ${ctx.paths.agentQueueJson}; Ask Yulu will auto-detect the local Agent CLI.\n`,
        stderr: "",
      };
    }
    if (!Array.isArray(command) || command.length === 0) {
      return { ok: false, stdout: "", stderr: "llm.command is empty; choose an Agent preset or use agent-queue mode" };
    }
    const normalized = normalizeLegacyAgentCommand(command.map(String));
    const { stdout, stderr, code } = await runLlmCommand(normalized, ctx.paths.scriptDir, "hello, world\n", 30_000);
    return { ok: code === 0, stdout, stderr };
  }),
});
