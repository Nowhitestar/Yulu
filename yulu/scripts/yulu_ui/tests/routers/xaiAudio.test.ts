import { describe, expect, it, vi } from "vitest";
import { xaiAudioRouter } from "../../src/routers/xaiAudio.js";
import { createCaller } from "../../src/trpc.js";

describe("xaiAudio router", () => {
  it("delegates Yulu-owned authorization without accepting an Agent source", async () => {
    const authorization = {
      status: "running" as const,
      verificationUrl: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
      userCode: "ABCD-EFGH",
      message: "请在浏览器完成 xAI 授权",
    };
    const xaiCredentials = {
      status: vi.fn(async () => ({ connected: false, detail: "需要授权", authorization })),
      authorize: vi.fn(async () => authorization),
      cancelAuthorization: vi.fn(() => ({ ...authorization, status: "idle" as const })),
      logout: vi.fn(async () => {}),
    };
    const audioTranscription = {
      testXai: vi.fn(async () => ({ ok: true, provider: "xai-oauth:yulu" })),
    };
    const caller = createCaller(xaiAudioRouter, { xaiCredentials, audioTranscription } as never);

    await expect(caller.status()).resolves.toMatchObject({ connected: false });
    await expect(caller.authorize()).resolves.toEqual(authorization);
    await expect(caller.test()).resolves.toEqual({ ok: true, provider: "xai-oauth:yulu" });
    await caller.cancelAuthorization();
    await caller.logout();

    expect(xaiCredentials.authorize).toHaveBeenCalledWith();
    expect(audioTranscription.testXai).toHaveBeenCalledWith();
    expect(xaiCredentials.logout).toHaveBeenCalledOnce();
  });
});
