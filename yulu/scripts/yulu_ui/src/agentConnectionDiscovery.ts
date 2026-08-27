import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";
import { envWithFallbackPath } from "./executables.js";
import type { DiscoveredAgentRuntime } from "./agentConnections.js";

const RUNTIMES = [
  { adapter: "codex", label: "Codex", command: "codex" },
  { adapter: "claude-code", label: "Claude Code", command: "claude" },
  { adapter: "hermes", label: "Hermes", command: "hermes" },
  { adapter: "openclaw", label: "OpenClaw", command: "openclaw" },
] as const;

export function discoverAgentConnectionCandidates(
  env: NodeJS.ProcessEnv = process.env,
): DiscoveredAgentRuntime[] {
  const path = envWithFallbackPath(env).PATH ?? "";
  return RUNTIMES.flatMap((runtime) => {
    for (const directory of path.split(delimiter)) {
      if (!directory) continue;
      const executable = join(directory, runtime.command);
      try {
        accessSync(executable, constants.X_OK);
        return [{ adapter: runtime.adapter, label: runtime.label, path: executable }];
      } catch {
        // Keep scanning PATH; discovery never invokes the runtime.
      }
    }
    return [];
  });
}
