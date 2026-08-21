import { afterEach, describe, expect, it, vi } from "vitest";
import {
  XaiCredentialManager,
  type StoredXaiCredential,
  type XaiTokenStore,
} from "../src/xaiCredentials.js";

class MemoryTokenStore implements XaiTokenStore {
  value: StoredXaiCredential | null = null;
  read = vi.fn(async () => this.value);
  write = vi.fn(async (value: StoredXaiCredential) => { this.value = value; });
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
    expect(deviceBody.get("scope")).toContain("api:access");
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
      { accessToken: "fresh-access" },
      { accessToken: "fresh-access" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(store.value).toMatchObject({
      accessToken: "fresh-access",
      refreshToken: "refresh-rotated",
    });
  });

  it("clears terminal invalid-grant credentials and requires reauthorization", async () => {
    const store = new MemoryTokenStore();
    store.value = {
      version: 1,
      accessToken: "expired-access",
      refreshToken: "dead-refresh",
      expiresAt: 1,
      tokenEndpoint: "https://auth.x.ai/oauth2/token",
    };
    const manager = new XaiCredentialManager({
      store,
      fetchFn: vi.fn(async () => json({ error: "invalid_grant" }, 400)),
      now: () => 10_000,
    });

    await expect(manager.resolve()).rejects.toThrow("xAI OAuth 已失效");
    expect(store.clear).toHaveBeenCalledOnce();
    expect(store.value).toBeNull();
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
