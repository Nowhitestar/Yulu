import { describe, expect, it, vi } from "vitest";
import {
  createXaiProviderReadiness,
  providersRouter,
} from "../../src/routers/providers.js";
import { createCaller } from "../../src/trpc.js";

function setup() {
  const selected = {
    transcription: { engine: "xai" },
    intelligence: {
      summary: { provider: "xai", model: "grok-summary-exact" },
      conversation: { provider: "xai", model: "grok-conversation-exact" },
    },
  };
  const connection = {
    connected: true,
    source: "oauth" as const,
    oauthConnected: true,
    apiKeyConfigured: false,
    detail: "xAI OAuth 已连接",
    authorization: { status: "idle" as const, verificationUrl: "", userCode: "", message: "" },
  };
  const xaiCredentials = {
    status: vi.fn(async () => connection),
    authorize: vi.fn(async () => ({ ...connection.authorization, status: "running" as const })),
    cancelAuthorization: vi.fn(() => connection.authorization),
    logout: vi.fn(async () => {}),
    setApiKey: vi.fn(async () => ({ ...connection, source: "api-key" as const, oauthConnected: false, apiKeyConfigured: true })),
    clearApiKey: vi.fn(async () => ({ ...connection, connected: false, source: null, oauthConnected: false, apiKeyConfigured: false })),
  };
  const audioTranscription = {
    testXai: vi.fn(async () => ({ ok: true, provider: "xai-oauth:yulu", credentialSource: "oauth" as const })),
  };
  const xaiText = {
    request: vi.fn(async ({ capability, model }: { capability: "summary" | "conversation"; model: string }) => ({
      text: "ready",
      model,
      credentialSource: "oauth" as const,
      capability,
    })),
  };
  const ctx = {
    config: { read: vi.fn(() => selected) },
    xaiCredentials,
    audioTranscription,
    xaiText,
    xaiReadiness: createXaiProviderReadiness(),
  };
  return { caller: createCaller(providersRouter, ctx as never), ctx, selected };
}

describe("providers router", () => {
  it("reports one shared connection and records three independent real probes", async () => {
    const { caller, ctx } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      connection: { connected: true, source: "oauth" },
      readiness: {
        transcription: { capability: "transcription", status: "untested", model: "speech-to-text", testedAt: null },
        summary: { capability: "summary", status: "untested", model: "grok-summary-exact", testedAt: null },
        conversation: { capability: "conversation", status: "untested", model: "grok-conversation-exact", testedAt: null },
      },
    });

    await expect(caller.probe({ capability: "summary" })).resolves.toMatchObject({
      capability: "summary",
      status: "ready",
      model: "grok-summary-exact",
      credentialSource: "oauth",
      testedAt: expect.any(String),
    });
    expect(ctx.xaiText.request).toHaveBeenCalledWith({
      capability: "summary",
      model: "grok-summary-exact",
      input: [
        { role: "system", content: "Return one short acknowledgement." },
        { role: "user", content: "Yulu xAI summary capability probe." },
      ],
      maxOutputTokens: 32,
    });

    await expect(caller.status()).resolves.toMatchObject({
      readiness: {
        transcription: { status: "untested" },
        summary: { status: "ready" },
        conversation: { status: "untested" },
      },
    });
    await caller.probe({ capability: "transcription" });
    await caller.probe({ capability: "conversation" });
    expect(ctx.audioTranscription.testXai).toHaveBeenCalledOnce();
    expect(ctx.xaiText.request).toHaveBeenCalledTimes(2);
  });

  it("invalidates only a changed model and returns a secret-safe failed result", async () => {
    const { caller, ctx, selected } = setup();
    await caller.probe({ capability: "summary" });
    selected.intelligence.summary.model = "grok-summary-new";

    await expect(caller.status()).resolves.toMatchObject({
      readiness: {
        summary: { status: "untested", model: "grok-summary-new", testedAt: null },
        conversation: { status: "untested", model: "grok-conversation-exact" },
      },
    });

    ctx.xaiText.request.mockRejectedValueOnce(new Error("secret-token private prompt"));
    const failed = await caller.probe({ capability: "conversation" });
    expect(failed).toMatchObject({
      capability: "conversation",
      status: "failed",
      model: "grok-conversation-exact",
      testedAt: expect.any(String),
    });
    expect(JSON.stringify(failed)).not.toMatch(/secret-token|private prompt/);

    ctx.xaiText.request.mockRejectedValueOnce(new Error("xAI summary request failed (HTTP 404)"));
    const invalidModel = await caller.probe({ capability: "summary" });
    expect(invalidModel).toMatchObject({
      capability: "summary",
      status: "failed",
      reason: "invalid_model",
    });
  });

  it("offers credential lifecycle mutations without any secret read procedure or response", async () => {
    const { caller, ctx } = setup();

    const saved = await caller.setApiKey({ apiKey: "submitted-once" });
    expect(ctx.xaiCredentials.setApiKey).toHaveBeenCalledWith("submitted-once");
    expect(JSON.stringify(saved)).not.toContain("submitted-once");
    await caller.clearApiKey();
    await caller.authorize();
    await caller.cancelAuthorization();
    await caller.logoutOAuth();
    expect(ctx.xaiCredentials.clearApiKey).toHaveBeenCalledOnce();
    expect(ctx.xaiCredentials.authorize).toHaveBeenCalledOnce();
    expect(ctx.xaiCredentials.logout).toHaveBeenCalledOnce();
    await expect(caller.readApiKey()).rejects.toThrow('No procedure found on path "readApiKey"');
  });
});
