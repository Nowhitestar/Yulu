import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import type {
  ConversationOnlyAgentKind,
  ConversationOnlyRuntimeClient,
  ConversationOnlyRuntimeInspection,
  ConversationOnlyRuntimeResult,
} from "./conversationOnlyAgentAdapter.js";

export interface CliCommandResult {
  stdout: string;
  stderr: string;
  code: number;
  timedOut: boolean;
  cancellationRequested: boolean;
  cancellationConfirmed: boolean | null;
}

export type CliCommandRunner = (
  command: string[],
  cwd: string,
  timeoutMs: number,
) => Promise<CliCommandResult>;

const MAX_OUTPUT_CHARS = 2_000_000;
const IDENTITY_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function runCliCommand(command: string[], cwd: string, timeoutMs: number): Promise<CliCommandResult> {
  return new Promise((resolve) => {
    const [rawCommand, ...args] = command;
    const env = envWithFallbackPath(process.env);
    const executable = rawCommand ? resolveExecutable(rawCommand, env) : "";
    if (!executable) {
      resolve({
        stdout: "",
        stderr: "runtime command is unavailable",
        code: 1,
        timedOut: false,
        cancellationRequested: false,
        cancellationConfirmed: null,
      });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let cancellationRequested = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;
    const finish = (result: CliCommandResult) => {
      if (settled) return;
      settled = true;
      if (forceKillTimer) clearTimeout(forceKillTimer);
      resolve(result);
    };
    const child = spawn(executable, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => {
      timedOut = true;
      cancellationRequested = true;
      child.kill("SIGTERM");
      forceKillTimer = setTimeout(() => child.kill("SIGKILL"), 100);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stdout.length);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk.toString("utf8").slice(0, MAX_OUTPUT_CHARS - stderr.length);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({
        stdout,
        stderr: stderr || error.message,
        code: 1,
        timedOut,
        cancellationRequested,
        cancellationConfirmed: timedOut ? false : null,
      });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      finish({
        stdout,
        stderr,
        code: code ?? (signal ? 1 : 0),
        timedOut,
        cancellationRequested,
        cancellationConfirmed: timedOut ? false : null,
      });
    });
  });
}

function textField(text: string, label: string): string | null {
  const match = new RegExp(`^\\s*${label}:\\s*(.+?)\\s*$`, "im").exec(text);
  const value = match?.[1]?.trim() ?? "";
  return value && !/not (?:set|configured|logged in)/i.test(value) ? value : null;
}

function parseJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value.trim());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function validIdentity(value: unknown): string | null {
  const candidate = string(value);
  return candidate && IDENTITY_RE.test(candidate) ? candidate : null;
}

function providerIdentity(value: unknown): string | null {
  const candidate = string(value)?.toLowerCase();
  return candidate?.match(/[a-z0-9][a-z0-9_.-]*/)?.[0] ?? null;
}

function runtimeVersion(kind: ConversationOnlyAgentKind, value: string): string {
  const pattern = kind === "hermes"
    ? /Hermes Agent v(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/i
    : /OpenClaw\s+(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/i;
  return pattern.exec(value)?.[1] ?? "";
}

function exactHermesSessionId(stderr: string): string | null {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\s*session_id:\s*(\S+)\s*$/.exec(line);
    const identity = validIdentity(match?.[1]);
    if (identity) return identity;
  }
  return null;
}

function openClawModel(provider: string | null, model: string | null): string | null {
  if (!model) return null;
  if (!provider || model.startsWith(`${provider}/`)) return model;
  return `${provider}/${model}`;
}

function openClawTerminalFailure(root: Record<string, unknown> | null): boolean {
  if (root?.status !== "error") return false;
  const code = string(record(root.error).code)?.toLowerCase() ?? "";
  return new Set([
    "invalid_request",
    "authentication_error",
    "permission_denied",
    "model_not_found",
    "unsupported_model",
    "content_policy",
  ]).has(code);
}

export class ConversationOnlyCliRuntimeClient implements ConversationOnlyRuntimeClient {
  private readonly adapter: ConversationOnlyAgentKind;
  private readonly executable: string;
  private readonly cwd: string;
  private readonly run: CliCommandRunner;
  private readonly sessionIdFactory: () => string;
  private lastRuntimeVersion = "";
  private lastProvider: string | null = null;
  private hermesFallbackDisabled = false;

  constructor(options: {
    adapter: ConversationOnlyAgentKind;
    executable: string;
    cwd: string;
    run?: CliCommandRunner;
    sessionIdFactory?: () => string;
  }) {
    this.adapter = options.adapter;
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.run = options.run ?? runCliCommand;
    this.sessionIdFactory = options.sessionIdFactory ?? randomUUID;
  }

  async inspect(): Promise<ConversationOnlyRuntimeInspection> {
    if (this.adapter === "hermes") return this.inspectHermes();
    return this.inspectOpenClaw();
  }

  private async inspectHermes(): Promise<ConversationOnlyRuntimeInspection> {
    const [version, help, status, fallback] = await Promise.all([
      this.run([this.executable, "--version"], this.cwd, 10_000),
      this.run([this.executable, "chat", "--help"], this.cwd, 10_000),
      this.run([this.executable, "status"], this.cwd, 10_000),
      this.run([this.executable, "fallback", "list"], this.cwd, 10_000),
    ]);
    const parsedVersion = runtimeVersion("hermes", `${version.stdout}\n${version.stderr}`);
    this.lastRuntimeVersion = parsedVersion;
    const helpText = `${help.stdout}\n${help.stderr}`;
    const statusText = `${status.stdout}\n${status.stderr}`;
    const provider = providerIdentity(textField(statusText, "Provider"));
    const model = textField(statusText, "Model");
    const features = [
      ...(status.code === 0 ? ["status"] : []),
      ...(helpText.includes("--model") ? ["model"] : []),
      ...(helpText.includes("--query") ? ["query"] : []),
      ...(helpText.includes("--resume") ? ["resume"] : []),
      ...(helpText.includes("--quiet") ? ["session-id"] : []),
      ...(help.code === 0 ? ["probe-bounds"] : []),
      ...(/no fallback models configured/i.test(`${fallback.stdout}\n${fallback.stderr}`)
        ? ["no-fallback"] : []),
    ];
    this.lastProvider = provider;
    this.hermesFallbackDisabled = features.includes("no-fallback");
    return {
      runtimeVersion: parsedVersion,
      authorized: status.code === 0 && Boolean(provider && model),
      provider,
      model,
      features,
    };
  }

  private async inspectOpenClaw(): Promise<ConversationOnlyRuntimeInspection> {
    const [version, help, status, inferHelp] = await Promise.all([
      this.run([this.executable, "--version"], this.cwd, 10_000),
      this.run([this.executable, "agent", "--help"], this.cwd, 10_000),
      this.run([this.executable, "models", "status", "--json", "--check"], this.cwd, 10_000),
      this.run([this.executable, "infer", "model", "run", "--help"], this.cwd, 10_000),
    ]);
    const parsedVersion = runtimeVersion("openclaw", `${version.stdout}\n${version.stderr}`);
    this.lastRuntimeVersion = parsedVersion;
    const helpText = `${help.stdout}\n${help.stderr}`;
    const inferHelpText = `${inferHelp.stdout}\n${inferHelp.stderr}`;
    const state = parseJson(status.stdout);
    const auth = record(state?.auth);
    const missing = Array.isArray(auth.missingProvidersInUse) ? auth.missingProvidersInUse : [];
    const unusable = Array.isArray(auth.unusableProfiles) ? auth.unusableProfiles : [];
    const fallbacks = Array.isArray(state?.fallbacks) ? state.fallbacks : [];
    const model = string(state?.resolvedDefault) ?? string(state?.defaultModel);
    const features = [
      ...(state ? ["models/status-json"] : []),
      ...(helpText.includes("--model") ? ["model"] : []),
      ...(helpText.includes("--message") ? ["message"] : []),
      ...(helpText.includes("--session-id") ? ["session-id"] : []),
      ...(helpText.includes("--json") ? ["json"] : []),
      ...(help.code === 0 ? ["probe-bounds"] : []),
      ...(inferHelp.code === 0 && ["--gateway", "--model", "--prompt", "--json"].every((flag) => inferHelpText.includes(flag))
        ? ["infer/model-run-tool-free"] : []),
      ...(fallbacks.length === 0 ? ["no-fallback"] : []),
    ];
    return {
      runtimeVersion: parsedVersion,
      authorized: Boolean(status.code === 0 && state && model && missing.length === 0 && unusable.length === 0),
      provider: model?.split("/")[0] ?? null,
      model,
      features,
    };
  }

  async runConversation(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ConversationOnlyRuntimeResult> {
    if (input.probe && this.adapter === "hermes") {
      throw new Error(`${this.adapter} tool-free probe unavailable`);
    }
    if (input.probe) return this.runOpenClawProbe(input);
    if (this.adapter === "hermes") return this.runHermes(input);
    return this.runOpenClaw(input);
  }

  private async runHermes(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ConversationOnlyRuntimeResult> {
    const command = [
      this.executable,
      "chat",
      "-Q",
      "--source",
      "yulu",
      "--model",
      input.model,
      ...(input.nativeSessionId ? ["--resume", input.nativeSessionId] : []),
      "--query",
      input.prompt,
    ];
    const execution = await this.run(command, this.cwd, input.timeoutMs);
    const reportedSessionId = exactHermesSessionId(execution.stderr);
    const candidateSessionId = input.nativeSessionId
      ? reportedSessionId && reportedSessionId !== input.nativeSessionId ? "" : input.nativeSessionId
      : reportedSessionId ?? "";
    let nativeSessionId = "";
    let actualProvider: string | null = null;
    let actualModel: string | null = null;
    if (execution.code === 0 && validIdentity(candidateSessionId)) {
      const exported = await this.run([
        this.executable,
        "sessions",
        "export",
        "--format",
        "jsonl",
        "--redact",
        "--session-id",
        candidateSessionId,
        "-",
      ], this.cwd, 10_000);
      const metadata = parseJson(exported.stdout.split(/\r?\n/).find((line) => line.trim()) ?? "");
      if (
        exported.code === 0 &&
        validIdentity(metadata?.id ?? metadata?.session_id) === candidateSessionId
      ) {
        nativeSessionId = candidateSessionId;
        actualModel = string(metadata?.model);
        actualProvider = providerIdentity(metadata?.billing_provider) ?? providerIdentity(metadata?.provider);
      }
    }
    return {
      runtimeVersion: this.lastRuntimeVersion,
      answer: execution.code === 0 ? execution.stdout.trim() : "",
      nativeSessionId,
      actualProvider,
      actualModel,
      requestId: null,
      fallbackOccurred: actualModel === input.model && actualProvider === this.lastProvider &&
        this.hermesFallbackDisabled ? false : null,
      terminalStatus: execution.timedOut && execution.cancellationConfirmed !== true
        ? "unknown"
        : execution.code === 0 ? "completed" : "unknown",
      cancellationRequested: execution.cancellationRequested,
      cancellationConfirmed: execution.cancellationConfirmed,
    };
  }

  private async runOpenClaw(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<ConversationOnlyRuntimeResult> {
    const requestedSessionId = input.nativeSessionId ?? this.sessionIdFactory();
    const execution = await this.run([
      this.executable,
      "agent",
      "--json",
      "--model",
      input.model,
      "--session-id",
      requestedSessionId,
      "--message",
      input.prompt,
    ], this.cwd, input.timeoutMs);
    const root = parseJson(execution.stdout);
    const result = record(root?.result);
    const meta = record(result.meta);
    const agentMeta = record(meta.agentMeta);
    const payloads = Array.isArray(result.payloads) ? result.payloads : [];
    const answer = payloads
      .map((payload) => string(record(payload).text) ?? "")
      .filter(Boolean)
      .join("\n\n");
    const actualProvider = string(agentMeta.provider);
    const actualModel = openClawModel(actualProvider, string(agentMeta.model));
    const returnedSessionId = validIdentity(agentMeta.sessionId);
    const sessionId = returnedSessionId === requestedSessionId ? returnedSessionId : null;
    const fallbackAttempts = Array.isArray(agentMeta.fallbackAttempts) ? agentMeta.fallbackAttempts : null;
    const transport = string(meta.transport);
    const transportFallback = transport === "embedded" || string(meta.fallbackFrom) === "gateway";
    const completed = execution.code === 0 && root?.status === "ok" &&
      Boolean(answer && sessionId && actualModel);
    const nativeTerminalFailure = openClawTerminalFailure(root);
    return {
      runtimeVersion: this.lastRuntimeVersion,
      answer: completed ? answer : "",
      nativeSessionId: sessionId ?? "",
      actualProvider,
      actualModel,
      requestId: validIdentity(root?.runId),
      fallbackOccurred: transportFallback
        ? true
        : transport === "gateway" && fallbackAttempts ? fallbackAttempts.length > 0 : null,
      terminalStatus: execution.timedOut && execution.cancellationConfirmed !== true
        ? "unknown"
        : completed ? "completed" : nativeTerminalFailure ? "failed" : "unknown",
      cancellationRequested: execution.cancellationRequested,
      cancellationConfirmed: execution.cancellationConfirmed,
    };
  }

  private async runOpenClawProbe(input: {
    model: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<ConversationOnlyRuntimeResult> {
    const execution = await this.run([
      this.executable,
      "infer",
      "model",
      "run",
      "--gateway",
      "--model",
      input.model,
      "--prompt",
      input.prompt,
      "--json",
    ], this.cwd, input.timeoutMs);
    const root = parseJson(execution.stdout);
    const outputs = Array.isArray(root?.outputs) ? root.outputs : [];
    const answer = outputs
      .map((output) => string(record(output).text) ?? "")
      .filter(Boolean)
      .join("\n\n");
    const actualProvider = string(root?.provider);
    const actualModel = openClawModel(actualProvider, string(root?.model));
    const attempts = Array.isArray(root?.attempts) ? root.attempts : null;
    const completed = execution.code === 0 && root?.ok === true &&
      root?.capability === "model.run" && root?.transport === "gateway" &&
      Boolean(answer && actualProvider && actualModel);
    return {
      runtimeVersion: this.lastRuntimeVersion,
      answer: completed ? answer : "",
      nativeSessionId: "",
      actualProvider,
      actualModel,
      requestId: null,
      fallbackOccurred: attempts ? attempts.length > 0 : null,
      terminalStatus: execution.timedOut && execution.cancellationConfirmed !== true
        ? "unknown"
        : completed ? "completed" : root?.ok === false ? "failed" : "unknown",
      cancellationRequested: execution.cancellationRequested,
      cancellationConfirmed: execution.cancellationConfirmed,
    };
  }
}
