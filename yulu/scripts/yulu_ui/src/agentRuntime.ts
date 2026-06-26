import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";

export type AgentRuntimeSource = "configured-command" | "auto-detected" | "disabled" | "missing";
export const CODEX_AGENT_COMMAND = ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"] as const;
export const CLAUDE_AGENT_COMMAND = ["claude", "--print"] as const;
export const HERMES_AGENT_COMMAND = ["hermes", "chat", "-Q", "--source", "yulu"] as const;
export const OPENCLAW_AGENT_COMMAND = ["openclaw", "agent", "--json"] as const;
export type AgentRuntimeProvider = "custom" | "codex" | "claude" | "hermes" | "openclaw" | "none";

export interface AgentRuntime {
  provider: AgentRuntimeProvider;
  label: string;
  source: AgentRuntimeSource;
  command: string[];
  cwd: string;
  disabledReason: string | null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
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

function configuredCommand(config: unknown): string[] | null {
  const llm = asRecord(asRecord(config).llm);
  const raw = llm.command;
  if (!Array.isArray(raw)) return null;
  const command = raw.map(String).map((s) => s.trim()).filter(Boolean);
  return command.length > 0 ? normalizeLegacyAgentCommand(command) : null;
}

export function normalizeLegacyAgentCommand(command: string[]): string[] {
  const isLegacyCodexShim = command.some((part) => {
    const pieces = part.split(/[\\/]/);
    return pieces[pieces.length - 1] === "codex_llm.py";
  });
  return isLegacyCodexShim ? [...CODEX_AGENT_COMMAND] : command;
}

function configuredProvider(config: unknown): string {
  const llm = asRecord(asRecord(config).llm);
  const agent = asRecord(llm.agent);
  const provider = String(agent.provider ?? "auto").trim().toLowerCase();
  return provider || "auto";
}

function labelForCommand(command: string[]): string {
  const first = command[0] ?? "Custom Agent";
  if (first.includes("claude")) return "Claude Code";
  if (first.includes("codex")) return "Codex";
  if (first.includes("hermes")) return "Hermes";
  if (first.includes("openclaw")) return "OpenClaw";
  if (first.includes("gemini")) return "Gemini CLI";
  if (first.includes("grok")) return "Grok CLI";
  return first;
}

function providerForCommand(command: string[]): Exclude<AgentRuntimeProvider, "none"> {
  const first = command[0] ?? "";
  if (first.includes("codex")) return "codex";
  if (first.includes("claude")) return "claude";
  if (first.includes("hermes")) return "hermes";
  if (first.includes("openclaw")) return "openclaw";
  return "custom";
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

export function resolveAgentRuntime(config: unknown, opts: { scriptDir: string; moviesDir: string }): AgentRuntime {
  const llm = asRecord(asRecord(config).llm);
  if (llm.enabled === false) {
    return noRuntime(opts.moviesDir, "disabled", "llm.enabled is false");
  }

  const explicit = configuredCommand(config);
  if (explicit) {
    return {
      provider: providerForCommand(explicit),
      label: labelForCommand(explicit),
      source: "configured-command",
      command: explicit,
      cwd: opts.scriptDir,
      disabledReason: null,
    };
  }

  const provider = configuredProvider(config);
  const wantsCodex = provider === "auto" || provider === "codex";
  const wantsClaude = provider === "auto" || provider === "claude" || provider === "claude-code";
  const wantsHermes = provider === "auto" || provider === "hermes";
  const wantsOpenClaw = provider === "auto" || provider === "openclaw";

  if (wantsCodex && executableExists("codex")) {
    return {
      provider: "codex",
      label: "Codex",
      source: "auto-detected",
      command: [...CODEX_AGENT_COMMAND],
      cwd: opts.moviesDir,
      disabledReason: null,
    };
  }

  if (wantsClaude && executableExists("claude")) {
    return {
      provider: "claude",
      label: "Claude Code",
      source: "auto-detected",
      command: [...CLAUDE_AGENT_COMMAND, "--add-dir", opts.moviesDir],
      cwd: opts.moviesDir,
      disabledReason: null,
    };
  }

  if (wantsHermes && executableExists("hermes")) {
    return {
      provider: "hermes",
      label: "Hermes",
      source: "auto-detected",
      command: [...HERMES_AGENT_COMMAND],
      cwd: opts.moviesDir,
      disabledReason: null,
    };
  }

  if (wantsOpenClaw && executableExists("openclaw")) {
    return {
      provider: "openclaw",
      label: "OpenClaw",
      source: "auto-detected",
      command: [...OPENCLAW_AGENT_COMMAND],
      cwd: opts.moviesDir,
      disabledReason: null,
    };
  }

  const requested = provider === "auto" ? "Codex, Claude Code, Hermes, or OpenClaw" : provider;
  return noRuntime(opts.moviesDir, "missing", `${requested} CLI is not available on PATH`);
}

export function commandPreview(runtime: AgentRuntime): string {
  if (runtime.command.length === 0) return "";
  const resolved = resolveExecutable(runtime.command[0]!, process.env);
  return [resolved, ...runtime.command.slice(1)].join(" ");
}
