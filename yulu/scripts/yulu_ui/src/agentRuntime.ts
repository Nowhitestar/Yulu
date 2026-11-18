import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { envWithFallbackPath } from "./executables.js";

export type AgentRuntimeSource = "configured-command" | "auto-detected" | "disabled" | "missing";
export type AgentRuntimeProvider = "custom" | "codex" | "claude" | "hermes" | "openclaw" | "none";

export interface AgentRuntime {
  provider: AgentRuntimeProvider;
  label: string;
  source: AgentRuntimeSource;
  command: string[];
  cwd: string;
  disabledReason: string | null;
}

function executableExists(cmd: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!cmd) return false;
  if (isAbsolute(cmd)) {
    try {
      accessSync(cmd, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }

  const pathEnv = envWithFallbackPath(env).PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    try {
      accessSync(join(dir, cmd), constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH.
    }
  }
  return false;
}

function noRuntime(cwd: string, source: AgentRuntimeSource, reason: string): AgentRuntime {
  return {
    provider: "none",
    label: "No Agent",
    source,
    command: [],
    cwd,
    disabledReason: reason,
  };
}

/** Resolve the Hermes runtime of the legacy recording workflow. It is found
 * only as the direct `hermes` executable; `llm.*` does not govern this path.
 */
export function resolveHermesAgentRuntime(
  _config: unknown,
  opts: { scriptDir: string; moviesDir: string },
): AgentRuntime {
  if (executableExists("hermes")) {
    return {
      provider: "hermes",
      label: "Hermes",
      source: "auto-detected",
      // Keep both `hermes serve` and phase workflows on the same direct
      // executable; llm.command wrappers/profiles do not govern this path.
      command: ["hermes"],
      cwd: opts.moviesDir,
      disabledReason: null,
    };
  }

  return noRuntime(opts.moviesDir, "missing", "Hermes CLI is not available on PATH");
}
