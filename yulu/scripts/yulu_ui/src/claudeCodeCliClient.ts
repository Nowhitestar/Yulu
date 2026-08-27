import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { envWithFallbackPath } from "./executables.js";
import type {
  ClaudeCodeRuntimeClient,
  ClaudeCodeRuntimeInspection,
  ClaudeCodeRuntimeConversationResult,
} from "./claudeCodeAdapter.js";

const CLAUDE_SENSITIVE_OR_ROUTING_ENV_NAMES = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
]);

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function runCommand(input: {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  stdin?: string;
  cancelOnTimeout?: boolean;
  cancellationGraceMs?: number;
}): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let cancellationTimer: NodeJS.Timeout | undefined;
    let terminationTimer: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (input.cancelOnTimeout) {
        child.kill("SIGINT");
        cancellationTimer = setTimeout(() => {
          child.kill("SIGTERM");
          terminationTimer = setTimeout(() => child.kill("SIGKILL"), 250);
        }, input.cancellationGraceMs ?? 1_000);
      } else {
        child.kill("SIGKILL");
      }
    }, input.timeoutMs);
    child.stdout.on("data", (buffer: Buffer) => { stdout += buffer.toString("utf8"); });
    child.stderr.on("data", (buffer: Buffer) => { stderr += buffer.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancellationTimer) clearTimeout(cancellationTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
    child.stdin.end(input.stdin ?? "");
  });
}

function parseVersion(output: string): string {
  const match = /(?:Claude Code\s+v?)?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/i.exec(output.trim());
  if (!match) throw new Error("Claude Code returned an invalid version");
  return match[1]!;
}

export class ClaudeCodeCliRuntimeClient implements ClaudeCodeRuntimeClient {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly sessionIdFactory: () => string;
  private readonly cancellationGraceMs: number;

  constructor(options: {
    executable: string;
    cwd: string;
    env?: NodeJS.ProcessEnv;
    sessionIdFactory?: () => string;
    cancellationGraceMs?: number;
  }) {
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.env = options.env;
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 1_000;
  }

  private runtimeEnv(): NodeJS.ProcessEnv {
    const safe: NodeJS.ProcessEnv = {};
    for (const source of [process.env, this.env]) {
      if (!source) continue;
      for (const name of Object.keys(source)) {
        if (CLAUDE_SENSITIVE_OR_ROUTING_ENV_NAMES.has(name)) continue;
        const value = source[name];
        if (value !== undefined) safe[name] = value;
      }
    }
    return envWithFallbackPath(safe);
  }

  async inspect(): Promise<ClaudeCodeRuntimeInspection> {
    const env = this.runtimeEnv();
    const versionResult = await runCommand({
      executable: this.executable,
      args: ["--version"],
      cwd: this.cwd,
      env,
      timeoutMs: 5_000,
    });
    if (versionResult.code !== 0) {
      throw new Error(versionResult.stderr.trim() || "Unable to read Claude Code runtime version");
    }
    const runtimeVersion = parseVersion(versionResult.stdout);
    const helpResult = await runCommand({
      executable: this.executable,
      args: ["--help"],
      cwd: this.cwd,
      env,
      timeoutMs: 5_000,
    });
    if (helpResult.code !== 0) {
      throw new Error(helpResult.stderr.trim() || "Claude Code safe-mode feature is unavailable");
    }
    const help = helpResult.stdout;
    const features = [
      "auth/status",
      ...(help.includes("--safe-mode") ? ["safe-mode"] : []),
      ...(help.includes("--print") && help.includes("--output-format") && help.includes("stream-json")
        ? ["print/stream-json"] : []),
      ...(help.includes("--verbose") ? ["verbose"] : []),
      ...(help.includes("--model") ? ["model"] : []),
      ...(help.includes("--session-id") ? ["session-id"] : []),
      ...(help.includes("--resume") ? ["resume"] : []),
      ...(help.includes("--max-turns") ? ["probe-bounds"] : []),
      ...(help.includes("--tools") && help.includes("--disallowedTools") &&
        help.includes("--strict-mcp-config") && help.includes("--mcp-config") ? ["tools/none"] : []),
      ...(help.includes("--disable-slash-commands") && help.includes("--no-session-persistence")
        ? ["probe-isolation"] : []),
      ...(help.includes("--fallback-model") ? ["fallback-model/opt-in"] : []),
    ];
    const authResult = await runCommand({
      executable: this.executable,
      args: ["auth", "status"],
      cwd: this.cwd,
      env,
      timeoutMs: 5_000,
    });
    if (authResult.code !== 0 && authResult.code !== 1) {
      throw new Error(authResult.stderr.trim() || "Claude Code native authorization status is unavailable");
    }
    let auth: Record<string, unknown>;
    try {
      auth = asRecord(JSON.parse(authResult.stdout));
    } catch {
      throw new Error("Claude Code native authorization status returned invalid JSON");
    }
    const authorizationMethod = typeof auth.authMethod === "string" ? auth.authMethod : null;
    const apiProvider = typeof auth.apiProvider === "string" ? auth.apiProvider : null;
    return {
      runtimeVersion,
      authorized: auth.loggedIn === true && apiProvider === "firstParty",
      authorizationMethod,
      apiProvider,
      features,
    };
  }

  async runConversation(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ClaudeCodeRuntimeConversationResult> {
    const createdSessionId = input.nativeSessionId ?? this.sessionIdFactory();
    const isolatedCwd = input.probe ? mkdtempSync(join(tmpdir(), "yulu-claude-probe-")) : null;
    const args = [
      "--safe-mode",
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", input.model,
      ...(input.nativeSessionId
        ? ["--resume", input.nativeSessionId]
        : ["--session-id", createdSessionId]),
      ...(input.probe ? [
        "--max-turns", "1",
        "--tools", "",
        "--disallowedTools", "*",
        "--strict-mcp-config",
        "--mcp-config", '{"mcpServers":{}}',
        "--disable-slash-commands",
        "--no-session-persistence",
      ] : []),
    ];
    try {
      const result = await runCommand({
        executable: this.executable,
        args,
        cwd: isolatedCwd ?? this.cwd,
        env: this.runtimeEnv(),
        timeoutMs: input.timeoutMs,
        stdin: input.prompt,
        cancelOnTimeout: true,
        cancellationGraceMs: this.cancellationGraceMs,
      });
      const messages = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
        .flatMap((line) => {
          try {
            return [asRecord(JSON.parse(line))];
          } catch {
            return [];
          }
        });
      const init = messages.find((message) => message.type === "system" && message.subtype === "init");
      const terminal = messages.slice().reverse().find((message) => message.type === "result");
      const initSessionId = typeof init?.session_id === "string" ? init.session_id : "";
      const resultSessionId = typeof terminal?.session_id === "string" ? terminal.session_id : "";
      const nativeSessionId = initSessionId && resultSessionId && initSessionId === resultSessionId
        ? resultSessionId
        : !terminal
          ? initSessionId
          : "";
      const initModel = typeof init?.model === "string" ? init.model : "";
      const modelUsage = asRecord(terminal?.modelUsage);
      const usedModels = Object.keys(modelUsage);
      const actualModel = usedModels.length === 1
        ? usedModels[0]!
        : !terminal && usedModels.length === 0
          ? initModel
          : "";
      const toolCalls = messages.flatMap((message) => {
        if (message.type !== "assistant") return [];
        const content = asRecord(message.message).content;
        if (!Array.isArray(content)) return [];
        return content.map(asRecord)
          .filter((item) => item.type === "tool_use")
          .map((item) => typeof item.name === "string" ? item.name : "unknown-tool");
      });
      if (input.probe && Array.isArray(init?.tools)) {
        toolCalls.push(...init.tools.map(String).map((name) => `available:${name}`));
      }
      if (input.probe && Array.isArray(init?.mcp_servers)) {
        toolCalls.push(...init.mcp_servers.map(String).map((name) => `mcp:${name}`));
      }
      const fallbackOccurred = actualModel !== input.model ||
        (Boolean(initModel) && initModel !== input.model) ||
        usedModels.some((model) => model !== input.model);
      const answer = typeof terminal?.result === "string" ? terminal.result : "";
      const completed = result.code === 0 && terminal?.subtype === "success" && terminal.is_error !== true;
      return {
        answer,
        nativeSessionId,
        actualModel,
        requestId: typeof terminal?.uuid === "string"
          ? terminal.uuid
          : !terminal && typeof init?.uuid === "string"
            ? init.uuid
            : null,
        fallbackOccurred,
        toolCalls,
        terminalStatus: !terminal ? "unknown" : completed ? "completed" : "failed",
        cancellationRequested: result.timedOut,
        cancellationConfirmed: result.timedOut || !terminal ? false : null,
      };
    } finally {
      if (isolatedCwd) rmSync(isolatedCwd, { recursive: true, force: true });
    }
  }
}
