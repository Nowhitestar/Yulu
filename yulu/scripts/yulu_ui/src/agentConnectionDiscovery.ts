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
  platform: NodeJS.Platform = process.platform,
): DiscoveredAgentRuntime[] {
  const path = envWithFallbackPath(env).PATH ?? "";
  const candidates: DiscoveredAgentRuntime[] = RUNTIMES.flatMap((runtime) => {
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
  if (platform === "darwin") {
    for (const app of ["Codex", "ChatGPT"]) {
      const executable = `/Applications/${app}.app/Contents/Resources/codex`;
      if (candidates.some(candidate => candidate.path === executable)) continue;
      try {
        accessSync(executable, constants.X_OK);
        candidates.push({
          candidateId: `candidate:codex:desktop:${app.toLowerCase()}`,
          adapter: "codex", label: `Codex (${app} desktop)`, path: executable,
        });
      } catch { /* The desktop App is optional; do not launch it during discovery. */ }
    }
  }
  return candidates;
}
