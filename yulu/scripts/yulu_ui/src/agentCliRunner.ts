import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import { resolveBundledScriptArgs, runLlmCommand } from "./llmCommand.js";
import type { AgentRuntime } from "./agentRuntime.js";

export interface AgentCliRunResult {
  stdout: string;
  stderr: string;
  code: number;
  nativeSessionId?: string;
  rawStdout?: string;
}

interface CodexSessionIndexEntry {
  id: string;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function codexSessionIndexPath(): string {
  return join(codexHome(), "session_index.jsonl");
}

function readCodexSessionIndex(): CodexSessionIndexEntry[] {
  const path = codexSessionIndexPath();
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      }))
      .filter((row) => UUID_RE.test(row.id));
  } catch {
    return [];
  }
}

function newestAddedCodexSession(before: CodexSessionIndexEntry[], after: CodexSessionIndexEntry[]): string | undefined {
  const seen = new Set(before.map((row) => row.id));
  return after
    .filter((row) => !seen.has(row.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
}

function isCodexRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "codex" && head.includes("codex");
}

function isClaudeRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "claude" && head.includes("claude");
}

function isHermesRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "hermes" && head.includes("hermes");
}

function isOpenClawRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "openclaw" && head.includes("openclaw");
}

function stripCodexOutputFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "-o" || arg === "--output-last-message") {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function stripFlagWithValue(args: string[], flags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (flags.has(arg)) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function stripClaudeSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(["--session-id", "--resume", "-r"]));
}

function stripHermesSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(
    args,
    new Set(["--resume", "-r", "--query", "-q", "--toolsets", "-t"]),
  ).filter((arg) => (
    !/^--(?:resume|query|toolsets)=/.test(arg) &&
    !/^-(?:r|q|t).+/.test(arg)
  ));
}

function stripOpenClawSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(["--session-id", "--message", "-m"]));
}

export function buildCodexSessionCommand(
  command: string[],
  input: { nativeSessionId?: string; outputPath: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripCodexOutputFlags(rawArgs);
  const execIndex = args.findIndex((arg) => arg === "exec" || arg === "e");
  if (execIndex < 0) return command;
  const withOutput = [...args, "--json", "-o", input.outputPath];
  if (input.nativeSessionId) {
    return [head, ...withOutput, "resume", input.nativeSessionId, "-"];
  }
  return [head, ...withOutput, "-"];
}

export function buildClaudeSessionCommand(
  command: string[],
  input: { nativeSessionId: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripClaudeSessionFlags(rawArgs);
  if (!args.includes("--print") && !args.includes("-p")) args.unshift("--print");
  return [head, ...args, "--session-id", input.nativeSessionId];
}

export function buildHermesSessionCommand(
  command: string[],
  input: { nativeSessionId?: string; prompt: string; toolsets?: readonly string[] },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripHermesSessionFlags(rawArgs);
  if (!args.includes("chat")) args.unshift("chat");
  if (!args.includes("-Q") && !args.includes("--quiet")) args.push("-Q");
  if (!args.includes("--source")) args.push("--source", "yulu");
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  if (input.toolsets !== undefined) {
    const toolsets = [...new Set(input.toolsets.map((value) => value.trim()).filter(Boolean))];
    if (toolsets.length === 0) throw new Error("Hermes toolsets must not be empty");
    args.push("--toolsets", toolsets.join(","));
  }
  return [head, ...args, "--query", input.prompt];
}

export function buildOpenClawSessionCommand(
  command: string[],
  input: { nativeSessionId: string; prompt: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripOpenClawSessionFlags(rawArgs);
  if (!args.includes("agent")) args.unshift("agent");
  if (!args.includes("--json")) args.push("--json");
  return [head, ...args, "--session-id", input.nativeSessionId, "--message", input.prompt];
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof raw === "string" &&
      UUID_RE.test(raw) &&
      /(?:session|conversation|thread).*id/i.test(key)
    ) {
      return raw;
    }
    const nested = findSessionId(raw);
    if (nested) return nested;
  }
  return undefined;
}

function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const found = findSessionId(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      // Non-JSON lines are allowed in CLI output.
    }
  }
  return undefined;
}

function extractAnySessionId(text: string): string | undefined {
  UUID_ANYWHERE_RE.lastIndex = 0;
  return UUID_ANYWHERE_RE.exec(text)?.[0];
}

export function extractHermesSessionId(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\s*session_id:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function extractCodexFinalMessage(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text =
        typeof parsed.text === "string" ? parsed.text :
        typeof parsed.message === "string" ? parsed.message :
        typeof parsed.content === "string" ? parsed.content :
        "";
      if (text) last = text;
    } catch {
      // Ignore non-event output.
    }
  }
  return last;
}

function findLikelyText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLikelyText(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["response", "reply", "answer", "message", "text", "content", "output"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  for (const raw of Object.values(record)) {
    const found = findLikelyText(raw);
    if (found) return found;
  }
  return undefined;
}

function extractOpenClawFinalMessage(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "";
  try {
    return findLikelyText(JSON.parse(trimmed)) ?? "";
  } catch {
    return "";
  }
}

function runSpawnCommand(command: string[], input: { cwd: string; stdin: string; timeoutMs: number }): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const [rawCmd, ...args] = resolveBundledScriptArgs(command, input.cwd);
    const spawnEnv = envWithFallbackPath(process.env);
    const cmd = rawCmd ? resolveExecutable(rawCmd, spawnEnv) : "";
    if (!cmd) {
      resolve({ stdout: "", stderr: "agent command is empty", code: 1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const proc = spawn(cmd, args, { cwd: input.cwd, env: spawnEnv });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, input.timeoutMs);
    proc.stdin.write(input.stdin);
    proc.stdin.end();
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr: stderr || err.message, code: 1 });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function runAgentCliCommand(args: {
  runtime: AgentRuntime;
  scriptDir: string;
  prompt: string;
  timeoutMs: number;
  nativeSessionId?: string;
  yuluSessionId?: string;
  configDir?: string;
  hermesToolsets?: readonly string[];
}): Promise<AgentCliRunResult> {
  if (!args.configDir) {
    return runLlmCommand(args.runtime.command, args.scriptDir, args.prompt, args.timeoutMs, args.runtime.cwd);
  }

  if (isClaudeRuntime(args.runtime)) {
    const nativeSessionId = args.nativeSessionId || args.yuluSessionId || randomUUID();
    const command = buildClaudeSessionCommand(args.runtime.command, { nativeSessionId });
    const result = await runSpawnCommand(command, {
      cwd: args.runtime.cwd,
      stdin: args.prompt,
      timeoutMs: args.timeoutMs,
    });
    return { ...result, nativeSessionId };
  }

  if (isHermesRuntime(args.runtime)) {
    const command = buildHermesSessionCommand(args.runtime.command, {
      nativeSessionId: args.nativeSessionId,
      prompt: args.prompt,
      toolsets: args.hermesToolsets,
    });
    const result = await runSpawnCommand(command, {
      cwd: args.runtime.cwd,
      stdin: "",
      timeoutMs: args.timeoutMs,
    });
    const nativeSessionId =
      args.nativeSessionId ||
      extractHermesSessionId(result.stderr) ||
      extractAnySessionId(`${result.stdout}\n${result.stderr}`);
    return { ...result, nativeSessionId };
  }

  if (isOpenClawRuntime(args.runtime)) {
    const nativeSessionId = args.nativeSessionId || args.yuluSessionId || randomUUID();
    const command = buildOpenClawSessionCommand(args.runtime.command, {
      nativeSessionId,
      prompt: args.prompt,
    });
    const result = await runSpawnCommand(command, {
      cwd: args.runtime.cwd,
      stdin: "",
      timeoutMs: args.timeoutMs,
    });
    return {
      ...result,
      stdout: extractOpenClawFinalMessage(result.stdout) || result.stdout,
      nativeSessionId,
      rawStdout: result.stdout,
    };
  }

  if (!isCodexRuntime(args.runtime)) {
    return runLlmCommand(args.runtime.command, args.scriptDir, args.prompt, args.timeoutMs, args.runtime.cwd);
  }

  mkdirSync(args.configDir, { recursive: true });
  const outputPath = join(args.configDir, `codex-last-message.${process.pid}.${Date.now()}.${randomUUID()}.txt`);
  const before = args.nativeSessionId ? [] : readCodexSessionIndex();
  const command = buildCodexSessionCommand(args.runtime.command, {
    nativeSessionId: args.nativeSessionId,
    outputPath,
  });
  const result = await runSpawnCommand(command, {
    cwd: args.runtime.cwd,
    stdin: args.prompt,
    timeoutMs: args.timeoutMs,
  });
  const fileMessage = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
  try {
    if (existsSync(outputPath)) unlinkSync(outputPath);
  } catch {
    // Best effort cleanup only.
  }
  const nativeSessionId =
    args.nativeSessionId ||
    extractCodexSessionId(result.stdout) ||
    newestAddedCodexSession(before, readCodexSessionIndex());
  return {
    stdout: fileMessage || extractCodexFinalMessage(result.stdout) || result.stdout,
    stderr: result.stderr,
    code: result.code,
    nativeSessionId,
    rawStdout: result.stdout,
  };
}
