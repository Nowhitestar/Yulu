import { describe, expect, it, vi } from "vitest";
import { AudioTranscriptionService } from "../src/audioTranscription.js";

function setup(engine: "local" | "xai") {
  const configValue = { transcription: { engine, xai_credential_source: "hermes" } };
  const config = { read: () => configValue };
  const local = {
    provider: "local-test",
    status: vi.fn(() => ({ ready: true, error: "" })),
    warm: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    feed: vi.fn(async () => ({ updates: {} })),
    finish: vi.fn(async () => ({ updates: {} })),
    abort: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const xai = {
    provider: "xai-oauth",
    credentialStatus: vi.fn(() => ({ source: "hermes", connected: true, detail: "connected" })),
    warm: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    feed: vi.fn(async () => ({ updates: {} })),
    finish: vi.fn(async () => ({ updates: {} })),
    abort: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    transcribeFile: vi.fn(async () => ({ transcript: "xAI transcript", provider: "xai-oauth:hermes", chunks: 1, language: "zh" as const })),
    testCredential: vi.fn(async () => ({ ok: true as const, provider: "xai-oauth:hermes" })),
  };
  const service = new AudioTranscriptionService(config as never, local as never, xai as never);
  return { configValue, local, xai, service };
}

describe("AudioTranscriptionService", () => {
  it("does not fall back to local when the selected xAI engine fails", async () => {
    const { local, xai, service } = setup("xai");
    xai.transcribeFile.mockRejectedValueOnce(new Error("xAI offline"));

    await expect(service.transcribeFile("/tmp/not-opened.wav", "zh")).rejects.toThrow("xAI offline");
    expect(local.start).not.toHaveBeenCalled();
  });

  it("does not fall back to xAI when the selected local engine is unavailable", async () => {
    const { local, xai, service } = setup("local");
    local.status.mockReturnValueOnce({ ready: false, error: "local model missing" });

    await expect(service.transcribeFile("/tmp/not-opened.wav", "zh")).rejects.toThrow("local model missing");
    expect(xai.transcribeFile).not.toHaveBeenCalled();
  });

  it("locks a realtime session to the engine selected at start", async () => {
    const { configValue, local, xai, service } = setup("local");
    await service.start("zh");
    configValue.transcription.engine = "xai";
    await service.feed({ mic: Buffer.alloc(320) });
    await service.finish();

    expect(local.start).toHaveBeenCalledOnce();
    expect(local.feed).toHaveBeenCalledOnce();
    expect(local.finish).toHaveBeenCalledOnce();
    expect(xai.start).not.toHaveBeenCalled();
  });
});
