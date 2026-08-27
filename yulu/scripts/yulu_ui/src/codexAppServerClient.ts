import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { envWithFallbackPath } from "./executables.js";
import type {
  CodexRuntimeClient,
  CodexRuntimeInspection,
  CodexRuntimeTurnResult,
} from "./codexAgentAdapter.js";

type JsonRecord = Record<string, unknown>;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface NotificationWaiter {
  method: string;
  predicate: (message: JsonRecord) => boolean;
  resolve: (message: JsonRecord) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

function asRecord(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

class AppServerSession {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notifications: JsonRecord[] = [];
  private readonly waiters = new Set<NotificationWaiter>();
  private nextId = 1;
  private closed = false;

  constructor(options: { executable: string; cwd: string; env?: NodeJS.ProcessEnv; rpcTimeoutMs: number }) {
    this.process = spawn(options.executable, ["app-server", "--stdio"], {
      cwd: options.cwd,
      env: envWithFallbackPath({ ...process.env, ...options.env }),
      stdio: ["pipe", "pipe", "pipe"],
    });
    const lines = createInterface({ input: this.process.stdout });
    lines.on("line", (line) => this.onLine(line));
    this.process.on("error", (error) => this.fail(error));
    this.process.on("close", () => {
      if (!this.closed) this.fail(new Error("Codex app-server closed before completing the request"));
    });
    this.rpcTimeoutMs = options.rpcTimeoutMs;
  }

  private readonly rpcTimeoutMs: number;

  async initialize(): Promise<void> {
    await this.request("initialize", {
      clientInfo: { name: "yulu", title: "Yulu", version: "1" },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
        optOutNotificationMethods: [],
      },
    });
    this.notify("initialized");
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const pending: PendingRequest = {
        resolve,
        reject,
        timer: setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`Codex app-server ${method} timed out`));
        }, this.rpcTimeoutMs),
      };
      this.pending.set(id, pending);
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string): void {
    this.write({ method });
  }

  waitFor(method: string, predicate: (message: JsonRecord) => boolean, timeoutMs: number): Promise<JsonRecord> {
    const existing = this.notifications.find((message) => message.method === method && predicate(message));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        method,
        predicate,
        resolve: (message) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(waiter.timer);
          this.waiters.delete(waiter);
          reject(error);
        },
        timer: setTimeout(() => {
          waiter.reject(new Error(`Codex app-server ${method} timed out`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  allNotifications(): JsonRecord[] {
    return [...this.notifications];
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.process.stdin.end();
    this.process.kill("SIGTERM");
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Codex app-server session closed"));
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(new Error("Codex app-server session closed"));
    this.waiters.clear();
  }

  private write(message: JsonRecord): void {
    if (this.closed) throw new Error("Codex app-server session is closed");
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onLine(line: string): void {
    let message: JsonRecord;
    try {
      message = asRecord(JSON.parse(line));
    } catch {
      return;
    }
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if ("error" in message) {
        const error = asRecord(message.error);
        pending.reject(new Error(stringValue(error.message) || "Codex app-server request failed"));
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string") return;
    this.notifications.push(message);
    for (const waiter of [...this.waiters]) {
      if (waiter.method === message.method && waiter.predicate(message)) waiter.resolve(message);
    }
  }

  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const waiter of this.waiters) waiter.reject(error);
    this.waiters.clear();
  }
}

function runtimeVersion(executable: string, cwd: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["--version"], {
      cwd,
      env: envWithFallbackPath({ ...process.env, ...env }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.stdout.on("data", (buffer: Buffer) => { stdout += buffer.toString("utf8"); });
    child.stderr.on("data", (buffer: Buffer) => { stderr += buffer.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || "Unable to read Codex runtime version"));
        return;
      }
      const match = /(?:codex-cli\s+)?(\d+\.\d+\.\d+(?:[-+][^\s]+)?)/.exec(stdout.trim());
      if (!match) reject(new Error("Codex runtime returned an invalid version"));
      else resolve(match[1]!);
    });
  });
}

function completedTurn(message: JsonRecord): JsonRecord {
  return asRecord(asRecord(message.params).turn);
}

function turnItems(turn: JsonRecord): JsonRecord[] {
  return Array.isArray(turn.items) ? turn.items.map(asRecord) : [];
}

function toolCalls(items: JsonRecord[]): string[] {
  const safe = new Set(["userMessage", "agentMessage", "reasoning"]);
  return items.map((item) => stringValue(item.type)).filter((type) => type && !safe.has(type));
}

function lastAnswer(items: JsonRecord[]): string {
  return items.filter((item) => item.type === "agentMessage")
    .map((item) => stringValue(item.text).trim())
    .filter(Boolean)
    .at(-1) ?? "";
}

// The probe must not inherit any execution surface from the user's Codex
// configuration. These request-scoped overrides are applied at the highest
// config layer by app-server before the thread is created.
const PROBE_DISABLED_FEATURES = [
  "apps",
  "browser_use",
  "browser_use_external",
  "browser_use_full_cdp_access",
  "computer_use",
  "enable_mcp_apps",
  "goals",
  "hooks",
  "image_generation",
  "in_app_browser",
  "memories",
  "multi_agent",
  "plugins",
  "remote_plugin",
  "shell_tool",
  "skill_mcp_dependency_install",
  "unified_exec",
] as const;

const TOOL_FREE_PROBE_CONFIG: JsonRecord = {
  "features.apps": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.browser_use_full_cdp_access": false,
  "features.computer_use": false,
  "features.enable_mcp_apps": false,
  "features.goals": false,
  "features.hooks": false,
  "features.image_generation": false,
  "features.in_app_browser": false,
  "features.memories": false,
  "features.multi_agent": false,
  "features.plugins": false,
  "features.remote_plugin": false,
  "features.shell_tool": false,
  "features.skill_mcp_dependency_install": false,
  "features.unified_exec": false,
  hooks: {},
  mcp_servers: {},
  project_root_markers: [],
  "skills.bundled.enabled": false,
  "skills.config": [],
  "skills.include_instructions": false,
  "tools.view_image": false,
  "tools.web_search": false,
  web_search: "disabled",
};

async function listAppServerData(
  session: AppServerSession,
  method: string,
  params: JsonRecord,
): Promise<JsonRecord[]> {
  const data: JsonRecord[] = [];
  const cursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < 100; page += 1) {
    const response = asRecord(await session.request(method, { ...params, cursor, limit: 100 }));
    if (!Array.isArray(response.data)) throw new Error(`Codex app-server ${method} returned invalid data`);
    data.push(...response.data.map(asRecord));
    cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
    if (!cursor) return data;
    if (cursors.has(cursor)) throw new Error(`Codex app-server ${method} repeated a cursor`);
    cursors.add(cursor);
  }
  throw new Error(`Codex app-server ${method} exceeded 100 pages`);
}

async function assertNoInheritedMcp(session: AppServerSession, threadId: string | null): Promise<void> {
  const servers = await listAppServerData(session, "mcpServerStatus/list", {
    detail: "toolsAndAuthOnly",
    threadId,
  });
  if (servers.length > 0) {
    throw new Error("Codex probe refused inherited MCP servers before execution");
  }
}

async function assertToolFreeThread(session: AppServerSession, threadId: string): Promise<void> {
  const featureData = await listAppServerData(session, "experimentalFeature/list", { threadId });
  const features = new Map(featureData.map((feature) => [stringValue(feature.name), feature.enabled]));
  if (PROBE_DISABLED_FEATURES.some((name) => features.get(name) !== false)) {
    throw new Error("Codex probe could not prove built-in tools, skills, plugins, and hooks are disabled");
  }
  await assertNoInheritedMcp(session, threadId);
  const apps = await listAppServerData(session, "app/list", { threadId, forceRefetch: false });
  if (apps.some((app) => app.isEnabled !== false)) {
    throw new Error("Codex probe could not prove apps and connector tools are disabled");
  }
}

export class CodexAppServerRuntimeClient implements CodexRuntimeClient {
  private readonly executable: string;
  private readonly cwd: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly rpcTimeoutMs: number;

  constructor(options: { executable: string; cwd: string; env?: NodeJS.ProcessEnv; rpcTimeoutMs?: number }) {
    this.executable = options.executable;
    this.cwd = options.cwd;
    this.env = options.env;
    this.rpcTimeoutMs = options.rpcTimeoutMs ?? 10_000;
  }

  async inspect(): Promise<CodexRuntimeInspection> {
    const version = await runtimeVersion(this.executable, this.cwd, this.env);
    const session = new AppServerSession({
      executable: this.executable,
      cwd: this.cwd,
      env: this.env,
      rpcTimeoutMs: this.rpcTimeoutMs,
    });
    try {
      await session.initialize();
      const accountResponse = asRecord(await session.request("account/read", { refreshToken: false }));
      const authorized = accountResponse.account !== null && accountResponse.account !== undefined;
      const models: string[] = [];
      if (authorized) {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        let pages = 0;
        do {
          if (pages >= 100) throw new Error("Codex app-server model/list exceeded 100 pages");
          pages += 1;
          const response = asRecord(await session.request("model/list", {
            cursor,
            limit: 100,
            includeHidden: false,
          }));
          const page = Array.isArray(response.data) ? response.data.map(asRecord) : [];
          models.push(...page.map((model) => stringValue(model.model) || stringValue(model.id)).filter(Boolean));
          cursor = typeof response.nextCursor === "string" ? response.nextCursor : null;
          if (cursor && cursors.has(cursor)) throw new Error("Codex app-server model/list repeated a cursor");
          if (cursor) cursors.add(cursor);
        } while (cursor);
      }
      return { runtimeVersion: version, authorized, models: [...new Set(models)] };
    } finally {
      session.close();
    }
  }

  async runTurn(input: {
    model: string;
    prompt: string;
    probe: boolean;
    timeoutMs: number;
    nativeSessionId?: string;
  }): Promise<CodexRuntimeTurnResult> {
    const session = new AppServerSession({
      executable: this.executable,
      cwd: this.cwd,
      env: this.env,
      rpcTimeoutMs: this.rpcTimeoutMs,
    });
    let threadId = input.nativeSessionId ?? "";
    let actualProvider = "";
    let actualModel = "";
    let requestId: string | null = null;
    try {
      await session.initialize();
      const threadResponse = asRecord(input.nativeSessionId
        ? await session.request("thread/resume", {
            threadId: input.nativeSessionId,
            model: input.model,
            modelProvider: "openai",
            cwd: this.cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            excludeTurns: true,
          })
        : await session.request("thread/start", {
            model: input.model,
            modelProvider: "openai",
            allowProviderModelFallback: false,
            cwd: this.cwd,
            approvalPolicy: "never",
            sandbox: "read-only",
            ...(input.probe ? {
              ephemeral: true,
              environments: [],
              dynamicTools: [],
              selectedCapabilityRoots: [],
              config: TOOL_FREE_PROBE_CONFIG,
              baseInstructions: "This is a bounded Yulu capability probe. Do not invoke any tool.",
              developerInstructions: "Return only the requested acknowledgement and do not invoke tools.",
            } : {}),
          }));
      if (input.probe) {
        const instructionSources = threadResponse.instructionSources;
        if (!Array.isArray(instructionSources) || instructionSources.length > 0) {
          throw new Error("Codex probe refused inherited instructions before execution");
        }
      }
      const thread = asRecord(threadResponse.thread);
      threadId = stringValue(thread.id);
      actualProvider = stringValue(threadResponse.modelProvider);
      actualModel = stringValue(threadResponse.model);
      if (input.probe) await assertToolFreeThread(session, threadId);
      let start: JsonRecord;
      try {
        start = asRecord(await session.request("turn/start", {
          threadId,
          input: [{ type: "text", text: input.prompt, text_elements: [] }],
          ...(input.probe ? {
            environments: [],
            approvalPolicy: "never",
            sandboxPolicy: { type: "readOnly", networkAccess: false },
          } : {}),
        }));
      } catch {
        // Once turn/start is written, a lost response cannot prove whether the
        // runtime accepted the model request. Preserve the exact thread and do
        // not retry on another thread.
        return {
          answer: "",
          nativeSessionId: threadId,
          actualProvider,
          actualModel,
          requestId: null,
          fallbackOccurred: false,
          toolCalls: [],
          terminalStatus: "unknown",
          cancellationRequested: false,
          cancellationConfirmed: null,
        };
      }
      requestId = stringValue(asRecord(start.turn).id) || null;
      let completion: JsonRecord;
      try {
        completion = await session.waitFor(
          "turn/completed",
          (message) => asRecord(message.params).threadId === threadId,
          input.timeoutMs,
        );
      } catch {
        let cancellationConfirmed: boolean | null = null;
        if (requestId) {
          try {
            await session.request("turn/interrupt", { threadId, turnId: requestId });
            cancellationConfirmed = true;
          } catch {
            // A lost transport cannot prove that remote work stopped.
            cancellationConfirmed = false;
          }
        }
        return {
          answer: "",
          nativeSessionId: threadId,
          actualProvider,
          actualModel,
          requestId,
          fallbackOccurred: false,
          toolCalls: [],
          terminalStatus: "unknown",
          cancellationRequested: Boolean(requestId),
          cancellationConfirmed,
        };
      }
      const turn = completedTurn(completion);
      const items = turnItems(turn);
      const rerouted = session.allNotifications().some((message) => message.method === "model/rerouted" &&
        asRecord(message.params).threadId === threadId);
      return {
        answer: lastAnswer(items),
        nativeSessionId: threadId,
        actualProvider,
        actualModel,
        requestId,
        fallbackOccurred: rerouted || actualProvider !== "openai" || actualModel !== input.model,
        toolCalls: toolCalls(items),
        terminalStatus: turn.status === "completed" ? "completed" : "failed",
        cancellationRequested: false,
        cancellationConfirmed: null,
      };
    } finally {
      session.close();
    }
  }
}
