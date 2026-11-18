// Registering Yulu's MCP endpoint with the Agents on this Mac.
//
// The Python helper (`provision.mcp`, the same code behind `yulu mcp …`) owns
// the registration and the bearer token. This router only runs it and reports
// booleans: command output can carry the token, so none of it is returned.
import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure, uiMutationProcedure } from "../trpc.js";

const TIMEOUT_MS = 30_000;
export const MCP_AGENTS = ["claude", "codex", "openclaw", "hermes"] as const;
export type McpAgentId = typeof MCP_AGENTS[number];

export interface McpAgentStatus {
  id: McpAgentId;
  /** The Agent's CLI or config was found on this Mac. */
  detected: boolean;
  /** Whether Yulu is registered with it; null when the Agent offers no way to tell. */
  configured: boolean | null;
}

function endpoint(): string {
  return `http://127.0.0.1:${Number(process.env.YULU_UI_PORT ?? 7777)}/mcp`;
}

function runHelper(args: string[], scriptDir: string): Promise<{ stdout: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(process.env.YULU_PYTHON || "python3", ["-m", "provision.mcp", ...args], {
      cwd: scriptDir,
      env: { ...process.env, PYTHONPATH: scriptDir },
    });
    let stdout = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), TIMEOUT_MS);
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    proc.stderr.on("data", () => { /* may echo credentials; never kept */ });
    proc.on("error", () => { clearTimeout(timer); resolve({ stdout: "", code: 999 }); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, code: code ?? 1 }); });
  });
}

export const mcpAgentsRouter = router({
  /** Which Agents are on this Mac and whether Yulu is registered with each. Never throws. */
  status: publicProcedure.query(async ({ ctx }): Promise<{ available: boolean; agents: McpAgentStatus[] }> => {
    const result = await runHelper(["status", "--endpoint", endpoint()], ctx.paths.scriptDir);
    if (result.code !== 0) return { available: false, agents: [] };
    try {
      const report = JSON.parse(result.stdout) as { agents?: Record<string, { detected?: unknown; configured?: unknown }> };
      return {
        available: true,
        agents: MCP_AGENTS.map((id) => ({
          id,
          detected: report.agents?.[id]?.detected === true,
          configured: typeof report.agents?.[id]?.configured === "boolean" ? report.agents[id]!.configured as boolean : null,
        })),
      };
    } catch {
      return { available: false, agents: [] };
    }
  }),

  /** Register Yulu with one Agent. The Agent picks it up the next time it starts. */
  install: uiMutationProcedure
    .input(z.object({ agent: z.enum(MCP_AGENTS) }))
    .mutation(async ({ ctx, input }) => {
      const result = await runHelper(["install", "--agent", input.agent, "--endpoint", endpoint()], ctx.paths.scriptDir);
      return { ok: result.code === 0 };
    }),

  /** Check that the endpoint answers an authenticated MCP handshake. */
  test: uiMutationProcedure.mutation(async ({ ctx }) => {
    const result = await runHelper(["test", "--endpoint", endpoint()], ctx.paths.scriptDir);
    return { ok: result.code === 0 };
  }),
});
