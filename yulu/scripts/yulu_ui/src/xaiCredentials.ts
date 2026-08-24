import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";

const XAI_OAUTH_DISCOVERY_URL = "https://auth.x.ai/.well-known/openid-configuration";
const XAI_OAUTH_TOKEN_URL = "https://auth.x.ai/oauth2/token";
const XAI_OAUTH_REVOKE_URL = "https://auth.x.ai/oauth2/revoke";
// Public Grok CLI compatibility contract; source tests pin this exact identity and scope subset.
const XAI_OAUTH_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const XAI_OAUTH_SCOPE = "openid profile email offline_access grok-cli:access api:access";
const TOKEN_REFRESH_SKEW_MS = 2 * 60_000;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_HELPER_OUTPUT_BYTES = 128_000;
const MAX_PROVIDER_SECRET_BYTES = 4_096;
const MAX_POLL_NETWORK_FAILURES = 5;
const PROVIDER_SECRET_SLOT_RE = /^(?:direct|gateway)\.[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export type XaiCredentialSource = "oauth" | "api-key";

export interface XaiCredential {
  accessToken: string;
  source: XaiCredentialSource;
}

export interface StoredXaiCredential {
  version: 1;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenEndpoint: string;
}

export interface XaiTokenStore {
  read(): Promise<StoredXaiCredential | null>;
  write(value: StoredXaiCredential): Promise<void>;
  clear(): Promise<void>;
}

export interface XaiApiKeyStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface XaiAuthorizationState {
  status: "idle" | "starting" | "running" | "succeeded" | "failed";
  verificationUrl: string;
  userCode: string;
  message: string;
}

export interface XaiCredentialStatus {
  connected: boolean;
  source: XaiCredentialSource | null;
  oauthConnected: boolean;
  apiKeyConfigured: boolean;
  detail: string;
  authorization: XaiAuthorizationState;
}

interface XaiCredentialManagerOptions {
  store: XaiTokenStore;
  apiKeyStore?: XaiApiKeyStore;
  fetchFn?: typeof fetch;
  now?: () => number;
}

interface DiscoveryDocument {
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
}

interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
}

function jsonObject(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} 返回了无效数据`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string, context: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) throw new Error(`${context} 缺少 ${field}`);
  return text;
}

function positiveNumber(value: unknown, fallback: number, maximum: number): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(number)));
}

function validateXaiUrl(value: string, field: string): string {
  let parsed: URL;
  try { parsed = new URL(value); }
  catch { throw new Error(`xAI OAuth ${field} 不是有效 URL`); }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || (host !== "x.ai" && !host.endsWith(".x.ai"))) {
    throw new Error(`拒绝使用非 xAI HTTPS ${field}`);
  }
  return parsed.toString();
}

async function responseObject(response: Response, context: string): Promise<Record<string, unknown>> {
  try { return jsonObject(await response.json(), context); }
  catch (error) {
    if (error instanceof Error && error.message.includes(context)) throw error;
    throw new Error(`${context} 返回了无效 JSON`);
  }
}

async function wait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function networkFailureMessage(error: unknown): string {
  const cause = error && typeof error === "object" && "cause" in error
    ? (error as { cause?: unknown }).cause
    : undefined;
  const rawCode = cause && typeof cause === "object" && "code" in cause
    ? (cause as { code?: unknown }).code
    : undefined;
  const code = typeof rawCode === "string" && /^[A-Z0-9_]{2,64}$/.test(rawCode) ? rawCode : "";
  return `无法连接 xAI OAuth 服务${code ? `（${code}）` : ""}，请检查网络或代理后重试`;
}

async function runKeychainHelper(
  helperPath: string,
  action: "read" | "write" | "delete",
  slot?: string,
  input = "",
): Promise<{ code: number; stdout: string }> {
  try { await access(helperPath, constants.X_OK); }
  catch { throw new Error("Yulu xAI 钥匙串组件不可用，请重新安装 Yulu"); }
  return await new Promise((resolve) => {
    const child = spawn(helperPath, slot ? [action, slot] : [action], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = `${stdout}${chunk.toString("utf8")}`.slice(-MAX_HELPER_OUTPUT_BYTES);
    });
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(1);
    }, 10_000);
    timer.unref();
    child.once("close", () => clearTimeout(timer));
    child.stdin.once("error", () => finish(1));
    child.stdin.end(input);
  });
}

export class KeychainXaiTokenStore implements XaiTokenStore {
  constructor(private readonly helperPath: string) {}

  async read(): Promise<StoredXaiCredential | null> {
    const result = await this.run("read");
    if (result.code === 44) return null;
    if (result.code !== 0) throw new Error("无法读取 macOS 钥匙串中的 xAI OAuth");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error("macOS 钥匙串中的 xAI OAuth 数据无效"); }
    const value = jsonObject(parsed, "xAI OAuth 凭证");
    const accessToken = requiredString(value.accessToken, "accessToken", "xAI OAuth 凭证");
    const refreshToken = requiredString(value.refreshToken, "refreshToken", "xAI OAuth 凭证");
    const expiresAt = Number(value.expiresAt);
    const tokenEndpoint = validateXaiUrl(
      requiredString(value.tokenEndpoint, "tokenEndpoint", "xAI OAuth 凭证"),
      "token endpoint",
    );
    if (value.version !== 1 || !Number.isFinite(expiresAt)) {
      throw new Error("macOS 钥匙串中的 xAI OAuth 数据版本无效");
    }
    return { version: 1, accessToken, refreshToken, expiresAt, tokenEndpoint };
  }

  async write(value: StoredXaiCredential): Promise<void> {
    const result = await this.run("write", JSON.stringify(value));
    if (result.code !== 0) throw new Error("无法保存 xAI OAuth 到 macOS 钥匙串");
  }

  async clear(): Promise<void> {
    const result = await this.run("delete");
    if (result.code !== 0 && result.code !== 44) {
      throw new Error("无法从 macOS 钥匙串删除 xAI OAuth");
    }
  }

  private async run(action: "read" | "write" | "delete", input = ""): Promise<{ code: number; stdout: string }> {
    return await runKeychainHelper(this.helperPath, action, undefined, input);
  }
}

export class KeychainProviderSecretStore implements XaiApiKeyStore {
  constructor(
    private readonly helperPath: string,
    private readonly slot: string,
  ) {
    if (!PROVIDER_SECRET_SLOT_RE.test(slot)) throw new Error("无效的提供商钥匙串槽位");
  }

  async configured(): Promise<boolean> {
    return (await this.read()) !== null;
  }

  async read(): Promise<string | null> {
    const result = await runKeychainHelper(this.helperPath, "read", this.slot);
    if (result.code === 44) return null;
    if (result.code !== 0) throw new Error("无法读取 macOS 钥匙串中的提供商凭证");
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout); }
    catch { throw new Error("macOS 钥匙串中的提供商凭证无效"); }
    const value = jsonObject(parsed, "提供商凭证");
    const secret = requiredString(value.secret, "secret", "提供商凭证");
    if (value.version !== 1 || Buffer.byteLength(secret, "utf8") > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error("macOS 钥匙串中的提供商凭证版本无效");
    }
    return secret;
  }

  async write(secret: string): Promise<void> {
    if (!secret || Buffer.byteLength(secret, "utf8") > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error("xAI API Key 长度无效");
    }
    const result = await runKeychainHelper(
      this.helperPath,
      "write",
      this.slot,
      JSON.stringify({ version: 1, secret }),
    );
    if (result.code !== 0) throw new Error("无法保存提供商凭证到 macOS 钥匙串");
  }

  async clear(): Promise<void> {
    const result = await runKeychainHelper(this.helperPath, "delete", this.slot);
    if (result.code !== 0 && result.code !== 44) {
      throw new Error("无法从 macOS 钥匙串删除提供商凭证");
    }
  }
}

export class XaiCredentialManager {
  private readonly store: XaiTokenStore;
  private readonly apiKeyStore?: XaiApiKeyStore;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private authorization: XaiAuthorizationState = {
    status: "idle",
    verificationUrl: "",
    userCode: "",
    message: "",
  };
  private authorizationController: AbortController | null = null;
  private authorizationGeneration = 0;
  private refreshPromise: Promise<StoredXaiCredential> | null = null;
  private cachedConnected = false;
  private cachedSource: XaiCredentialSource | null = null;
  private cachedDetail = "正在检查 Yulu xAI OAuth";

  constructor(options: XaiCredentialManagerOptions) {
    this.store = options.store;
    this.apiKeyStore = options.apiKeyStore;
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
  }

  async status(): Promise<XaiCredentialStatus> {
    let apiKeyConfigured = false;
    let apiKeyError: Error | null = null;
    if (this.apiKeyStore) {
      try { apiKeyConfigured = (await this.apiKeyStore.read()) !== null; }
      catch (error) { apiKeyError = error as Error; }
    }
    try {
      const credential = await this.store.read();
      const oauthConnected = credential !== null;
      this.cachedConnected = oauthConnected || apiKeyConfigured;
      this.cachedSource = oauthConnected ? "oauth" : apiKeyConfigured ? "api-key" : null;
      this.cachedDetail = oauthConnected
        ? "xAI OAuth 已连接"
        : apiKeyConfigured
          ? "xAI API Key 已连接"
          : apiKeyError?.message ?? "需要在 Yulu 中连接 xAI";
      return {
        connected: this.cachedConnected,
        source: this.cachedSource,
        oauthConnected,
        apiKeyConfigured,
        detail: this.cachedDetail,
        authorization: { ...this.authorization },
      };
    } catch (error) {
      this.cachedConnected = false;
      this.cachedSource = null;
      this.cachedDetail = error instanceof Error ? error.message : "无法读取 xAI OAuth";
      return {
        connected: false,
        source: null,
        oauthConnected: false,
        apiKeyConfigured,
        detail: this.cachedDetail,
        authorization: { ...this.authorization },
      };
    }
  }

  cachedStatus(): { connected: boolean; source: XaiCredentialSource | null; detail: string } {
    return { connected: this.cachedConnected, source: this.cachedSource, detail: this.cachedDetail };
  }

  async setApiKey(value: string): Promise<XaiCredentialStatus> {
    if (!this.apiKeyStore) throw new Error("xAI API Key 钥匙串不可用");
    const secret = value.trim();
    if (!secret || Buffer.byteLength(secret, "utf8") > MAX_PROVIDER_SECRET_BYTES) {
      throw new Error("xAI API Key 长度无效");
    }
    await this.apiKeyStore.write(secret);
    return await this.status();
  }

  async clearApiKey(): Promise<XaiCredentialStatus> {
    if (!this.apiKeyStore) throw new Error("xAI API Key 钥匙串不可用");
    await this.apiKeyStore.clear();
    return await this.status();
  }

  async authorize(): Promise<XaiAuthorizationState> {
    if (this.authorizationController) throw new Error("已有 xAI OAuth 授权正在进行");
    const controller = new AbortController();
    const generation = ++this.authorizationGeneration;
    this.authorizationController = controller;
    this.authorization = {
      status: "starting",
      verificationUrl: "",
      userCode: "",
      message: "正在向 xAI 请求授权码",
    };
    try {
      const discovery = await this.discovery(controller.signal);
      const device = await this.requestDeviceAuthorization(discovery.deviceAuthorizationEndpoint, controller.signal);
      this.authorization = {
        status: "running",
        verificationUrl: device.verificationUrl,
        userCode: device.userCode,
        message: "请在浏览器完成 xAI 授权",
      };
      void this.pollAuthorization(discovery.tokenEndpoint, device, controller, generation);
      return { ...this.authorization };
    } catch (error) {
      if (this.authorizationGeneration === generation) {
        this.authorizationController = null;
        this.authorization = {
          status: "failed",
          verificationUrl: "",
          userCode: "",
          message: isAbort(error) && controller.signal.aborted
            ? "xAI OAuth 授权已取消"
            : (error as Error).message,
        };
      }
      throw error;
    }
  }

  cancelAuthorization(): XaiAuthorizationState {
    this.authorizationGeneration += 1;
    this.authorizationController?.abort();
    this.authorizationController = null;
    this.authorization = {
      status: "idle",
      verificationUrl: "",
      userCode: "",
      message: "xAI OAuth 授权已取消",
    };
    return { ...this.authorization };
  }

  async logout(): Promise<void> {
    this.cancelAuthorization();
    const credential = await this.store.read().catch(() => null);
    if (credential) {
      try {
        await this.request(XAI_OAUTH_REVOKE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: new URLSearchParams({
            client_id: XAI_OAUTH_CLIENT_ID,
            token: credential.refreshToken,
            token_type_hint: "refresh_token",
          }),
        });
      } catch { /* local logout must still remove the credential */ }
    }
    await this.store.clear();
    this.cachedConnected = false;
    this.cachedSource = null;
    this.cachedDetail = "需要在 Yulu 中授权 xAI";
    this.authorization = { status: "idle", verificationUrl: "", userCode: "", message: "已退出 xAI OAuth" };
  }

  async resolve(): Promise<XaiCredential> {
    const stored = await this.store.read();
    if (stored) {
      if (stored.expiresAt > this.now() + TOKEN_REFRESH_SKEW_MS) {
        return { accessToken: stored.accessToken, source: "oauth" };
      }
      const refreshed = await this.refresh(stored);
      return { accessToken: refreshed.accessToken, source: "oauth" };
    }
    const apiKey = await this.apiKeyStore?.read();
    if (!apiKey) throw new Error("请先在 Yulu 设置中连接 xAI");
    return { accessToken: apiKey, source: "api-key" };
  }

  close(): void {
    this.cancelAuthorization();
  }

  private async discovery(signal: AbortSignal): Promise<DiscoveryDocument> {
    const response = await this.request(XAI_OAUTH_DISCOVERY_URL, {
      headers: { Accept: "application/json" },
      signal,
    });
    if (!response.ok) throw new Error(`xAI OAuth 服务发现失败（HTTP ${response.status}）`);
    const payload = await responseObject(response, "xAI OAuth 服务发现");
    const deviceAuthorizationEndpoint = validateXaiUrl(
      requiredString(payload.device_authorization_endpoint, "device_authorization_endpoint", "xAI OAuth 服务发现"),
      "device authorization endpoint",
    );
    const tokenEndpoint = validateXaiUrl(
      requiredString(payload.token_endpoint, "token_endpoint", "xAI OAuth 服务发现"),
      "token endpoint",
    );
    if (payload.authorization_endpoint) {
      validateXaiUrl(String(payload.authorization_endpoint), "authorization endpoint");
    }
    return { deviceAuthorizationEndpoint, tokenEndpoint };
  }

  private async requestDeviceAuthorization(endpoint: string, signal: AbortSignal): Promise<DeviceAuthorization> {
    const response = await this.request(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope: XAI_OAUTH_SCOPE }),
      signal,
    });
    if (!response.ok) throw new Error(`xAI 授权码请求失败（HTTP ${response.status}）`);
    const payload = await responseObject(response, "xAI 授权码");
    const verificationUrl = validateXaiUrl(
      requiredString(
        payload.verification_uri_complete ?? payload.verification_uri,
        "verification_uri",
        "xAI 授权码",
      ),
      "verification URL",
    );
    return {
      deviceCode: requiredString(payload.device_code, "device_code", "xAI 授权码"),
      userCode: requiredString(payload.user_code, "user_code", "xAI 授权码").slice(0, 32),
      verificationUrl,
      expiresIn: positiveNumber(payload.expires_in, 1_800, 3_600),
      interval: positiveNumber(payload.interval, 5, 30),
    };
  }

  private async pollAuthorization(
    tokenEndpoint: string,
    device: DeviceAuthorization,
    controller: AbortController,
    generation: number,
  ): Promise<void> {
    const deadline = this.now() + device.expiresIn * 1_000;
    let interval = device.interval;
    let networkFailures = 0;
    try {
      while (this.now() < deadline) {
        await wait(interval * 1_000, controller.signal);
        let response: Response;
        try {
          response = await this.request(tokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
              client_id: XAI_OAUTH_CLIENT_ID,
              device_code: device.deviceCode,
            }),
            signal: controller.signal,
          });
        } catch (error) {
          if (controller.signal.aborted) throw error;
          networkFailures += 1;
          if (networkFailures >= MAX_POLL_NETWORK_FAILURES) {
            throw new Error(networkFailureMessage(error));
          }
          if (this.authorizationGeneration === generation) {
            this.authorization = {
              ...this.authorization,
              message: `与 xAI 的连接暂时中断，正在重试（${networkFailures}/${MAX_POLL_NETWORK_FAILURES}）`,
            };
          }
          continue;
        }
        if (networkFailures > 0 && this.authorizationGeneration === generation) {
          this.authorization = {
            ...this.authorization,
            message: "请在浏览器完成 xAI 授权",
          };
        }
        networkFailures = 0;
        const payload = await responseObject(response, "xAI OAuth token");
        if (response.ok) {
          const accessToken = requiredString(payload.access_token, "access_token", "xAI OAuth token");
          const refreshToken = requiredString(payload.refresh_token, "refresh_token", "xAI OAuth token");
          const expiresIn = positiveNumber(payload.expires_in, 900, 24 * 60 * 60);
          await this.store.write({
            version: 1,
            accessToken,
            refreshToken,
            expiresAt: this.now() + expiresIn * 1_000,
            tokenEndpoint,
          });
          this.cachedConnected = true;
          this.cachedSource = "oauth";
          this.cachedDetail = "xAI OAuth 已连接";
          if (this.authorizationGeneration === generation) {
            this.authorization = {
              status: "succeeded",
              verificationUrl: "",
              userCode: "",
              message: "xAI OAuth 已连接",
            };
          }
          return;
        }
        const errorCode = String(payload.error ?? "");
        if (errorCode === "authorization_pending") continue;
        if (errorCode === "slow_down") {
          interval = Math.min(30, interval + 5);
          continue;
        }
        if (errorCode === "access_denied") throw new Error("xAI OAuth 授权已被拒绝");
        if (errorCode === "expired_token") throw new Error("xAI OAuth 授权码已过期，请重试");
        throw new Error(`xAI OAuth 授权失败${errorCode ? `：${errorCode}` : ""}`);
      }
      throw new Error("等待 xAI OAuth 授权超时，请重试");
    } catch (error) {
      if (this.authorizationGeneration === generation && !isAbort(error)) {
        this.authorization = {
          status: "failed",
          verificationUrl: "",
          userCode: "",
          message: error instanceof Error ? error.message : "xAI OAuth 授权失败",
        };
      }
    } finally {
      if (this.authorizationGeneration === generation) this.authorizationController = null;
    }
  }

  private async refresh(stored: StoredXaiCredential): Promise<StoredXaiCredential> {
    if (this.refreshPromise) return await this.refreshPromise;
    this.refreshPromise = this.refreshCredential(stored);
    try { return await this.refreshPromise; }
    finally { this.refreshPromise = null; }
  }

  private async refreshCredential(stored: StoredXaiCredential): Promise<StoredXaiCredential> {
    const tokenEndpoint = validateXaiUrl(stored.tokenEndpoint || XAI_OAUTH_TOKEN_URL, "token endpoint");
    const response = await this.request(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: XAI_OAUTH_CLIENT_ID,
        refresh_token: stored.refreshToken,
      }),
    });
    const payload = await responseObject(response, "xAI OAuth 刷新");
    if (!response.ok) {
      if (response.status === 403) {
        throw new Error("当前 xAI 账号没有 API 或音频转写权限，重新授权不会改变账号权限");
      }
      if (response.status === 400 || response.status === 401) {
        await this.store.clear();
        this.cachedConnected = false;
        this.cachedSource = null;
        this.cachedDetail = "xAI OAuth 已失效，请重新授权";
        throw new Error("xAI OAuth 已失效，请在 Yulu 设置中重新授权");
      }
      throw new Error(`xAI OAuth 刷新失败（HTTP ${response.status}）`);
    }
    const accessToken = requiredString(payload.access_token, "access_token", "xAI OAuth 刷新");
    const refreshToken = typeof payload.refresh_token === "string" && payload.refresh_token.trim()
      ? payload.refresh_token.trim()
      : stored.refreshToken;
    const expiresIn = positiveNumber(payload.expires_in, 900, 24 * 60 * 60);
    const refreshed: StoredXaiCredential = {
      version: 1,
      accessToken,
      refreshToken,
      expiresAt: this.now() + expiresIn * 1_000,
      tokenEndpoint,
    };
    await this.store.write(refreshed);
    return refreshed;
  }

  private async request(url: string, init: RequestInit = {}): Promise<Response> {
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(), REQUEST_TIMEOUT_MS);
    timer.unref();
    const signals = [timeoutController.signal];
    if (init.signal) signals.push(init.signal);
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.any(signals) });
    } finally {
      clearTimeout(timer);
    }
  }
}
