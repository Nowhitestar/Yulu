import { describe, expect, it, vi } from "vitest";
import {
  createXaiProviderReadiness,
  providersRouter,
} from "../../src/routers/providers.js";
import { createCaller } from "../../src/trpc.js";
import { XAI_SUMMARY_DISCLOSURE_VERSION } from "../../src/summaryDataDisclosure.js";
import { XAI_TRANSCRIPTION_DISCLOSURE_VERSION } from "../../src/transcriptionConsent.js";

function setup(uiMutationAuthorized = true) {
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
  let transcriptionConsent: { disclosureVersion: string; acceptedAt: string } | null = null;
  let summaryDisclosure: {
    provider: string;
    disclosureVersion: string;
    decision: "accepted" | "declined";
    decidedAt: string;
  } | null = null;
  const host = {
    getCloudTranscriptionConsent: vi.fn(() => transcriptionConsent),
    recordCloudTranscriptionConsent: vi.fn((disclosureVersion: string) => {
      transcriptionConsent = { disclosureVersion, acceptedAt: new Date().toISOString() };
      return transcriptionConsent;
    }),
    getSummaryDataPathDisclosure: vi.fn(() => summaryDisclosure),
    recordSummaryDataPathDisclosure: vi.fn((provider: string, disclosureVersion: string) => {
      summaryDisclosure = {
        provider,
        disclosureVersion,
        decision: "accepted",
        decidedAt: new Date().toISOString(),
      };
      return summaryDisclosure;
    }),
  };
  const ctx = {
    uiMutationAuthorized,
    config: { read: vi.fn(() => selected) },
    host,
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

  it("keeps xAI audio and summary disclosures independent and repairable after activation", async () => {
    const { caller, ctx } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      disclosures: {
        transcription: {
          required: true,
          disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
          data: "recording_audio",
          destination: "xAI",
        },
        summary: {
          required: true,
          disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
          data: "transcript_text",
          destination: "xAI",
        },
      },
    });

    await caller.acceptDataPathDisclosure({ capability: "transcription" });
    expect(ctx.host.recordCloudTranscriptionConsent)
      .toHaveBeenCalledWith(XAI_TRANSCRIPTION_DISCLOSURE_VERSION);
    await expect(caller.status()).resolves.toMatchObject({
      disclosures: {
        transcription: { required: false },
        summary: { required: true },
      },
    });

    await caller.acceptDataPathDisclosure({ capability: "summary" });
    expect(ctx.host.recordSummaryDataPathDisclosure)
      .toHaveBeenCalledWith("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
    await expect(caller.status()).resolves.toMatchObject({
      disclosures: {
        transcription: { required: false },
        summary: { required: false },
      },
    });
  });

  it("does not require xAI disclosures for capabilities that are not selected", async () => {
    const { caller, selected } = setup();
    selected.transcription.engine = "local";
    selected.intelligence.summary = { provider: "agent", model: "runtime-managed" };

    await expect(caller.status()).resolves.toMatchObject({
      disclosures: {
        transcription: { required: false },
        summary: { required: false },
      },
    });
  });

  it("requires an authenticated UI mutation before recording a disclosure", async () => {
    const { caller, ctx } = setup(false);

    await expect(caller.acceptDataPathDisclosure({ capability: "transcription" }))
      .rejects.toThrow("UI mutation bearer required");
    expect(ctx.host.recordCloudTranscriptionConsent).not.toHaveBeenCalled();
  });

  it("requires the same authenticated UI mutation boundary for credential and probe actions", async () => {
    const { caller, ctx } = setup(false);

    await expect(caller.authorize()).rejects.toThrow("UI mutation bearer required");
    await expect(caller.setApiKey({ apiKey: "submitted-once" }))
      .rejects.toThrow("UI mutation bearer required");
    await expect(caller.probe({ capability: "conversation" }))
      .rejects.toThrow("UI mutation bearer required");
    expect(ctx.xaiCredentials.authorize).not.toHaveBeenCalled();
    expect(ctx.xaiCredentials.setApiKey).not.toHaveBeenCalled();
    expect(ctx.xaiText.request).not.toHaveBeenCalled();
  });
});
