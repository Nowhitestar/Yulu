import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XaiCredentialManager,
  type XaiApiKeyStore,
  type StoredXaiCredential,
  type XaiTokenStore,
} from "../src/xaiCredentials.js";

class MemoryTokenStore implements XaiTokenStore {
  value: StoredXaiCredential | null = null;
  read = vi.fn(async () => this.value);
  write = vi.fn(async (value: StoredXaiCredential) => { this.value = value; });
  clear = vi.fn(async () => { this.value = null; });
}

class MemoryApiKeyStore implements XaiApiKeyStore {
  value: string | null = null;
  read = vi.fn(async () => this.value);
  write = vi.fn(async (value: string) => { this.value = value; });
  clear = vi.fn(async () => { this.value = null; });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function discovery() {
  return json({
    authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
    device_authorization_endpoint: "https://auth.x.ai/oauth2/device/code",
    token_endpoint: "https://auth.x.ai/oauth2/token",
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("XaiCredentialManager", () => {
  it("reports credential-store read certainty separately from credential presence", async () => {
    const oauthUnavailable = new MemoryTokenStore();
    oauthUnavailable.read.mockRejectedValueOnce(new Error("OAuth Keychain unavailable"));
    const apiKeyAvailable = new MemoryApiKeyStore();
    apiKeyAvailable.value = "configured-api-key";
    const oauthFailure = new XaiCredentialManager({
      store: oauthUnavailable,
      apiKeyStore: apiKeyAvailable,
    });

    await expect(oauthFailure.status()).resolves.toMatchObject({
      oauthConnected: false,
      apiKeyConfigured: true,
      oauthReadSucceeded: false,
      apiKeyReadSucceeded: true,
    });

    const oauthAvailable = new MemoryTokenStore();
    const apiKeyUnavailable = new MemoryApiKeyStore();
    apiKeyUnavailable.read.mockRejectedValueOnce(new Error("API Keychain unavailable"));
    const apiKeyFailure = new XaiCredentialManager({
      store: oauthAvailable,
      apiKeyStore: apiKeyUnavailable,
    });

    await expect(apiKeyFailure.status()).resolves.toMatchObject({
      oauthConnected: false,
      apiKeyConfigured: false,
      oauthReadSucceeded: true,
      apiKeyReadSucceeded: false,
    });
  });

  it("returns the xAI device URL immediately and persists successful authorization", async () => {
    vi.useFakeTimers();
    const store = new MemoryTokenStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
        expires_in: 1_800,
        interval: 1,
      }))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 900,
        token_type: "Bearer",
      }));
    const manager = new XaiCredentialManager({ store, fetchFn: fetchMock });

    await expect(manager.authorize()).resolves.toMatchObject({
      status: "running",
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(manager.status()).resolves.toMatchObject({
      connected: true,
      authorization: { status: "succeeded", message: "xAI OAuth 已连接" },
    });
    expect(store.write).toHaveBeenCalledWith(expect.objectContaining({
      version: 1,
      accessToken: "access-token",
      refreshToken: "refresh-token",
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    }));
    const deviceBody = fetchMock.mock.calls[1]![1]?.body as URLSearchParams;
    expect(deviceBody.get("client_id")).toBe("b1a00492-073a-47ea-816f-4c329264a828");
    expect(deviceBody.get("scope")).toBe("openid profile email offline_access grok-cli:access api:access");
  });

  it("uses an explicitly saved API key only when OAuth is absent and never reads it back in status", async () => {
    const store = new MemoryTokenStore();
    const apiKeyStore = new MemoryApiKeyStore();
    const manager = new XaiCredentialManager({ store, apiKeyStore });

    await expect(manager.setApiKey("xai-explicit-secret")).resolves.toMatchObject({
      connected: true,
      source: "api-key",
      oauthConnected: false,
      apiKeyConfigured: true,
    });
    const status = await manager.status();
    expect(JSON.stringify(status)).not.toContain("xai-explicit-secret");
    await expect(manager.resolve()).resolves.toEqual({
      accessToken: "xai-explicit-secret",
      source: "api-key",
    });

    await expect(manager.clearApiKey()).resolves.toMatchObject({
      connected: false,
      source: null,
      apiKeyConfigured: false,
    });
  });

  it("keeps OAuth primary and never downgrades to an API key after refresh failure", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "dead-refresh",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const apiKeyStore = new MemoryApiKeyStore();
    apiKeyStore.value = "must-not-be-used";
    const manager = new XaiCredentialManager({
      store,
      apiKeyStore,
      fetchFn: vi.fn(async () => json({ error: "permission_denied" }, 403)),
      now: () => 10_000,
    });

    await expect(manager.resolve()).rejects.toThrow("没有 API 或音频转写权限");
    expect(apiKeyStore.read).not.toHaveBeenCalled();
  });

  it("resolves only the explicitly selected credential source when both are configured", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "oauth-secret",
      refreshToken: "oauth-refresh",
      expiresAt: Date.now() + 60_000,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const apiKeyStore = new MemoryApiKeyStore();
    apiKeyStore.value = "api-key-secret";
    const manager = new XaiCredentialManager({ store, apiKeyStore });

    manager.setPreferredSource("api-key");
    await expect(manager.status()).resolves.toMatchObject({
      connected: true,
      source: "api-key",
      oauthConnected: true,
      apiKeyConfigured: true,
    });
    await expect(manager.resolve()).resolves.toEqual({ accessToken: "api-key-secret", source: "api-key" });

    manager.setPreferredSource(null);
    await expect(manager.resolve()).rejects.toThrow("显式选择");
  });

  it("recovers when one device-token poll has a transport failure", async () => {
    vi.useFakeTimers();
    const store = new MemoryTokenStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        expires_in: 1_800,
        interval: 1,
      }))
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(json({ error: "authorization_pending" }, 400))
      .mockResolvedValueOnce(json({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 900,
      }));
    const manager = new XaiCredentialManager({ store, fetchFn: fetchMock });

    await manager.authorize();
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manager.status()).resolves.toMatchObject({
      connected: false,
      authorization: { status: "running", message: expect.stringContaining("正在重试") },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manager.status()).resolves.toMatchObject({
      connected: false,
      authorization: { status: "running", message: "请在浏览器完成 xAI 授权" },
    });

    await vi.advanceTimersByTimeAsync(1_000);
    await expect(manager.status()).resolves.toMatchObject({
      connected: true,
      authorization: { status: "succeeded" },
    });
    expect(store.write).toHaveBeenCalledOnce();
  });

  it("rejects poisoned OAuth discovery endpoints before sending credentials", async () => {
    const store = new MemoryTokenStore();
    const fetchMock = vi.fn(async () => json({
      authorization_endpoint: "https://auth.x.ai/oauth2/authorize",
      device_authorization_endpoint: "https://evil.example/device",
      token_endpoint: "https://auth.x.ai/oauth2/token",
    }));
    const manager = new XaiCredentialManager({ store, fetchFn: fetchMock });

    await expect(manager.authorize()).rejects.toThrow("拒绝使用非 xAI HTTPS device authorization endpoint");
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.write).not.toHaveBeenCalled();
  });

  it("serializes refresh-token rotation across concurrent callers", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "refresh-old",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const fetchMock = vi.fn(async () => json({
      access_token: "fresh-access",
      refresh_token: "refresh-rotated",
      expires_in: 900,
    }));
    const manager = new XaiCredentialManager({ store, fetchFn: fetchMock, now: () => 10_000 });

    await expect(Promise.all([manager.resolve(), manager.resolve()])).resolves.toEqual([
      { accessToken: "fresh-access", source: "oauth" },
      { accessToken: "fresh-access", source: "oauth" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.value).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "refresh-rotated",
    });
  });

  it("retains invalid OAuth state so a saved API key cannot become an automatic fallback", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "dead-refresh",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const apiKeyStore = new MemoryApiKeyStore();
    apiKeyStore.value = "must-not-be-used";
    const manager = new XaiCredentialManager({
      store,
      apiKeyStore,
      fetchFn: vi.fn(async () => json({ error: "invalid_grant" }, 400)),
      now: () => 10_000,
    });

    await expect(manager.resolve()).rejects.toThrow("xAI OAuth 已失效");
    await expect(manager.resolve()).rejects.toThrow("xAI OAuth 已失效");
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.value?.refreshToken).toBe("dead-refresh");
    expect(apiKeyStore.read).not.toHaveBeenCalled();
  });

  it("keeps credentials when xAI reports an account entitlement failure", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "valid-refresh",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const manager = new XaiCredentialManager({
      store,
      fetchFn: vi.fn(async () => json({ error: "permission_denied" }, 403)),
      now: () => 10_000,
    });

    await expect(manager.resolve()).rejects.toThrow("没有 API 或音频转写权限");
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.value?.refreshToken).toBe("valid-refresh");
  });

  it("cancels a pending authorization without retaining its device code", async () => {
    vi.useFakeTimers();
    const store = new MemoryTokenStore();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(discovery())
      .mockResolvedValueOnce(json({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://accounts.x.ai/oauth2/device",
        expires_in: 1_800,
        interval: 5,
      }));
    const manager = new XaiCredentialManager({ store, fetchFn: fetchMock });
    await manager.authorize();

    expect(manager.cancelAuthorization()).toEqual({
      status: "idle",
      verificationUrl: "",
      userCode: "",
      message: "xAI OAuth 授权已取消",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.write).not.toHaveBeenCalled();
  });
});
