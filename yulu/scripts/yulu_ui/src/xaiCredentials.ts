import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";

export type XaiCredentialSource = "auto" | "hermes" | "openclaw";
type ConcreteXaiCredentialSource = Exclude<XaiCredentialSource, "auto">;

export interface XaiCredential {
  accessToken: string;
  source: ConcreteXaiCredentialSource;
}

export interface XaiCredentialSourceStatus {
  source: ConcreteXaiCredentialSource;
  installed: boolean;
  oauthSupported: boolean;
  connected: boolean;
  detail: string;
  authorizeCommand: string;
}

export interface XaiAuthorizationState {
  source: ConcreteXaiCredentialSource | null;
  status: "idle" | "running" | "succeeded" | "failed";
  verificationUrl: string;
  userCode: string;
  message: string;
}

export interface XaiCredentialStatus {
  sources: XaiCredentialSourceStatus[];
  authorization: XaiAuthorizationState;
}

interface ProcessResult {
  code: number;
  stdout: string;
}

const HERMES_RESOLVER = [
  "import json",
  "from hermes_cli.auth import resolve_xai_oauth_runtime_credentials",
  "value = resolve_xai_oauth_runtime_credentials()",
  "print(json.dumps({'accessToken': value['api_key']}))",
].join("; ");

const OPENCLAW_RESOLVER = String.raw`
const modulePath = process.argv[1];
const mod = await import(new URL('file://' + modulePath).href);
const store = mod.loadAuthProfileStore();
const order = mod.resolveAuthProfileOrder({ store, provider: 'xai' });
for (const profileId of order) {
  const profile = store.profiles?.[profileId];
  if (!profile || profile.provider !== 'xai' || profile.type !== 'oauth') continue;
  const resolved = await mod.resolveApiKeyForProfile({ store, profileId });
  if (resolved?.apiKey) {
    process.stdout.write(JSON.stringify({ accessToken: resolved.apiKey }));
    process.exit(0);
  }
}
throw new Error('OpenClaw has no usable xAI OAuth profile');
`;

function expandedHome(value: string): string {
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

function commandPath(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const resolved = resolveExecutable(command, envWithFallbackPath(env));
  try {
    accessSync(resolved, constants.X_OK);
    return resolved;
  } catch {
    return null;
  }
}

function hermesHome(env: NodeJS.ProcessEnv = process.env): string {
  return expandedHome(env.YULU_HERMES_HOME?.trim() || env.HERMES_HOME?.trim() || join(homedir(), ".hermes"));
}

function openClawPackageRoot(env: NodeJS.ProcessEnv = process.env): string | null {
  const executable = commandPath("openclaw", env);
  if (!executable || !existsSync(executable)) return null;
  try { return dirname(realpathSync(executable)); }
  catch { return null; }
}

function openClawRuntimePath(env: NodeJS.ProcessEnv = process.env): string | null {
  const root = openClawPackageRoot(env);
  if (!root) return null;
  const path = join(root, "dist", "plugin-sdk", "agent-runtime.js");
  return existsSync(path) ? path : null;
}

export function openClawSupportsXaiOAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  const root = openClawPackageRoot(env);
  if (!root) return false;
  const plugin = join(root, "dist", "extensions", "xai", "index.js");
  if (!existsSync(plugin)) return false;
  try { return /methodId\s*:\s*["']oauth["']/.test(readFileSync(plugin, "utf8")); }
  catch { return false; }
}

function run(command: string, args: string[], options: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const env = envWithFallbackPath(options.env ?? process.env);
    const executable = commandPath(command, env);
    if (!executable) return resolve({ code: 127, stdout: "" });
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    const append = (chunk: Buffer) => { stdout = `${stdout}${chunk.toString("utf8")}`.slice(-128_000); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 15_000);
    timer.unref();
    child.once("error", () => {
      clearTimeout(timer);
      resolve({ code: 1, stdout });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout });
    });
  });
}

function jsonFromOutput(output: string): Record<string, unknown> {
  for (const line of output.trim().split(/\r?\n/).reverse()) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* try the previous line */ }
  }
  throw new Error("Agent credential resolver returned no JSON");
}

function safeAuthorizationUpdate(current: XaiAuthorizationState, output: string): XaiAuthorizationState {
  const url = output.match(/https:\/\/[^\s"'<>]+/i)?.[0] ?? current.verificationUrl;
  const explicitCode = output.match(/(?:user\s*code|verification\s*code|code)\s*[:=]\s*([A-Z0-9-]{4,20})/i)?.[1];
  return {
    ...current,
    verificationUrl: url,
    userCode: explicitCode ?? current.userCode,
    message: url ? "请在浏览器完成 xAI 授权" : "正在等待 xAI 授权",
  };
}

export class XaiCredentialManager {
  private authProcess: ChildProcess | null = null;
  private authorization: XaiAuthorizationState = {
    source: null,
    status: "idle",
    verificationUrl: "",
    userCode: "",
    message: "",
  };
  private cachedSources: XaiCredentialSourceStatus[] = [];

  async status(): Promise<XaiCredentialStatus> {
    const sources = await Promise.all([this.hermesStatus(), this.openClawStatus()]);
    this.cachedSources = sources;
    return { sources, authorization: { ...this.authorization } };
  }

  cachedStatus(source: XaiCredentialSource): XaiCredentialSourceStatus | null {
    const connected = this.cachedSources.filter((item) => item.connected && item.oauthSupported);
    if (source === "auto") return connected.length === 1 ? connected[0]! : null;
    return this.cachedSources.find((item) => item.source === source) ?? null;
  }

  async resolve(source: XaiCredentialSource): Promise<XaiCredential> {
    const selected = await this.selectSource(source);
    return selected === "hermes" ? await this.resolveHermes() : await this.resolveOpenClaw();
  }

  startAuthorization(source: ConcreteXaiCredentialSource): XaiAuthorizationState {
    if (this.authProcess) throw new Error("已有 xAI OAuth 授权正在进行");
    const env = envWithFallbackPath(process.env);
    const command = commandPath(source === "hermes" ? "hermes" : "openclaw", env);
    if (!command) throw new Error(`${source === "hermes" ? "Hermes" : "OpenClaw"} 未安装`);
    if (source === "openclaw" && !openClawSupportsXaiOAuth(env)) {
      throw new Error("当前 OpenClaw 版本不支持 xAI OAuth");
    }
    const args = source === "hermes"
      ? ["auth", "add", "xai-oauth", "--no-browser"]
      : ["models", "auth", "login", "--provider", "xai", "--method", "oauth"];
    const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    this.authProcess = child;
    this.authorization = {
      source,
      status: "running",
      verificationUrl: "",
      userCode: "",
      message: "正在启动 xAI OAuth",
    };
    const inspect = (chunk: Buffer) => {
      this.authorization = safeAuthorizationUpdate(this.authorization, chunk.toString("utf8"));
    };
    child.stdout.on("data", inspect);
    child.stderr.on("data", inspect);
    child.once("error", () => {
      this.authProcess = null;
      this.authorization = { ...this.authorization, status: "failed", message: "无法启动 Agent OAuth" };
    });
    child.once("close", (code) => {
      this.authProcess = null;
      this.authorization = {
        ...this.authorization,
        status: code === 0 ? "succeeded" : "failed",
        message: code === 0 ? "xAI OAuth 已连接" : "xAI OAuth 授权失败或已取消",
      };
      void this.status();
    });
    return { ...this.authorization };
  }

  close(): void {
    this.authProcess?.kill("SIGTERM");
    this.authProcess = null;
  }

  private async selectSource(source: XaiCredentialSource): Promise<ConcreteXaiCredentialSource> {
    if (source !== "auto") return source;
    const { sources } = await this.status();
    const connected = sources.filter((item) => item.connected && item.oauthSupported);
    if (connected.length === 1) return connected[0]!.source;
    if (connected.length === 0) throw new Error("Hermes/OpenClaw 均没有可用的 xAI OAuth");
    throw new Error("检测到多个 xAI OAuth，请明确选择 Hermes 或 OpenClaw");
  }

  private async hermesStatus(): Promise<XaiCredentialSourceStatus> {
    const installed = Boolean(commandPath("hermes"));
    if (!installed) return {
      source: "hermes", installed: false, oauthSupported: false, connected: false,
      detail: "Hermes 未安装", authorizeCommand: "hermes auth add xai-oauth --no-browser",
    };
    const result = await run("hermes", ["auth", "status", "xai-oauth"], { timeoutMs: 8_000 });
    const connected = result.code === 0 && /logged\s+in/i.test(result.stdout);
    return {
      source: "hermes", installed: true, oauthSupported: true, connected,
      detail: connected ? "xAI OAuth 已连接" : "需要授权 xAI OAuth",
      authorizeCommand: "hermes auth add xai-oauth --no-browser",
    };
  }

  private async openClawStatus(): Promise<XaiCredentialSourceStatus> {
    const installed = Boolean(commandPath("openclaw"));
    const oauthSupported = installed && openClawSupportsXaiOAuth();
    let connected = false;
    if (oauthSupported) {
      const result = await run("openclaw", ["models", "auth", "list", "--provider", "xai", "--json"], { timeoutMs: 10_000 });
      try {
        const parsed = JSON.parse(result.stdout) as { profiles?: Array<{ type?: string }> };
        connected = result.code === 0 && Boolean(parsed.profiles?.some((profile) => profile.type === "oauth"));
      } catch { connected = false; }
    }
    return {
      source: "openclaw", installed, oauthSupported, connected,
      detail: !installed ? "OpenClaw 未安装"
        : !oauthSupported ? "当前版本不支持 xAI OAuth"
          : connected ? "xAI OAuth 已连接" : "需要授权 xAI OAuth",
      authorizeCommand: "openclaw models auth login --provider xai --method oauth",
    };
  }

  private async resolveHermes(): Promise<XaiCredential> {
    const home = hermesHome();
    const repo = join(home, "hermes-agent");
    const python = join(repo, "venv", "bin", "python");
    if (!existsSync(python)) throw new Error("Hermes xAI OAuth runtime 不可用");
    const result = await run(python, ["-c", HERMES_RESOLVER], {
      cwd: repo,
      env: { ...process.env, HERMES_HOME: home },
      timeoutMs: 30_000,
    });
    if (result.code !== 0) throw new Error("Hermes 无法解析或刷新 xAI OAuth，请重新授权");
    const parsed = jsonFromOutput(result.stdout);
    const accessToken = String(parsed.accessToken ?? "").trim();
    if (!accessToken) throw new Error("Hermes 返回了空的 xAI OAuth token");
    return { accessToken, source: "hermes" };
  }

  private async resolveOpenClaw(): Promise<XaiCredential> {
    if (!openClawSupportsXaiOAuth()) throw new Error("当前 OpenClaw 版本不支持 xAI OAuth");
    const runtimePath = openClawRuntimePath();
    if (!runtimePath) throw new Error("OpenClaw OAuth runtime 不可用");
    const result = await run(process.execPath, ["--input-type=module", "-e", OPENCLAW_RESOLVER, runtimePath], { timeoutMs: 30_000 });
    if (result.code !== 0) throw new Error("OpenClaw 无法解析或刷新 xAI OAuth，请重新授权");
    const parsed = jsonFromOutput(result.stdout);
    const accessToken = String(parsed.accessToken ?? "").trim();
    if (!accessToken) throw new Error("OpenClaw 返回了空的 xAI OAuth token");
    return { accessToken, source: "openclaw" };
  }
}
