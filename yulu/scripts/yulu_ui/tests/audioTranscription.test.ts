import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AudioTranscriptionService } from "../src/audioTranscription.js";

function setup(engine: "local" | "xai") {
  const configValue = { transcription: { engine } };
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
    provider: "xai-oauth:yulu",
    credentialStatus: vi.fn(() => ({ connected: true, detail: "connected" })),
    warm: vi.fn(async () => {}),
    start: vi.fn(async () => {}),
    feed: vi.fn(async () => ({ updates: {} })),
    finish: vi.fn(async () => ({ updates: {} })),
    abort: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    transcribeFile: vi.fn(async () => ({ transcript: "xAI transcript", provider: "xai-oauth:yulu", chunks: 1, language: "zh" as const })),
    testCredential: vi.fn(async () => ({ ok: true as const, provider: "xai-oauth:yulu" })),
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

  it("uses a finished trusted realtime transcript when final xAI transcription fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu-audio-transcription-"));
    const audioPath = join(dir, "Demo_20260805_140009.wav");
    writeFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "完整的实时转写");
    writeFileSync(audioPath.replace(/\.wav$/, ".realtime.coverage.json"), JSON.stringify({
      provider: "xai-oauth:yulu",
      chunks: 231,
      trusted: true,
      finished: true,
    }));
    const { local, xai, service } = setup("xai");
    xai.transcribeFile.mockRejectedValueOnce(new Error("xAI returned an empty transcript"));

    try {
      await expect(service.transcribeFile(audioPath, "zh")).resolves.toEqual({
        transcript: "完整的实时转写",
        provider: "xai-oauth:yulu",
        chunks: 231,
        language: "zh",
      });
      expect(local.start).not.toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
