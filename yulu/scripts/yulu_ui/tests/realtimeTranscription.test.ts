import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import type { StreamingCaptionEngine, StreamingCaptionUpdate } from "../src/localCaptionEngine.js";
import {
  RealtimeTranscriptionCoordinator,
  assessRealtimeTranscript,
  captionsLikelyDuplicate,
  dedupeTranscriptSegment,
  segmentCutBytes,
  sourceSeparated16kPcm,
  trailingSilenceMs,
} from "../src/realtimeTranscription.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeStereoWav(path: string, seconds: number, sample = 5000, systemSample = sample): void {
  const frames = Math.floor(48_000 * seconds);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(systemSample, i * 4 + 2);
  }
  const wav = Buffer.alloc(44 + pcm.length);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(48_000, 24);
  wav.writeUInt32LE(48_000 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  writeFileSync(path, wav);
}

function monoPcm(seconds: number, sample: number): Buffer {
  const pcm = Buffer.alloc(Math.floor(16_000 * seconds) * 2);
  for (let offset = 0; offset < pcm.length; offset += 2) pcm.writeInt16LE(sample, offset);
  return pcm;
}

describe("RealtimeTranscriptionCoordinator", () => {
  it("streams source-separated PCM, exposes mutable partials, and persists stable text only", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-streaming-"));
    roots.push(root);
    const audioPath = join(root, "流式会议_20260716_190000.wav");
    writeStereoWav(audioPath, 0.05, 1_000, 2_000);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          mic: { partial: "正在讨论", stable: [], audioMs: 50 },
          system: { partial: "远端方案", stable: [], audioMs: 50 },
        },
      })),
      finish: vi.fn(async () => ({
        updates: {
          system: { partial: "", stable: [{ text: "远端方案已经确认", endMs: 640 }], audioMs: 50 },
          mic: { partial: "", stable: [{ text: "远端方案已经确认", endMs: 1_000 }], audioMs: 50 },
        },
      })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "流式会议", language: "zh" });

    expect(engine.start).toHaveBeenCalledWith("zh");
    expect(engine.feed).toHaveBeenCalledOnce();
    const chunks = vi.mocked(engine.feed).mock.calls[0]![0];
    expect(chunks.mic?.readInt16LE(0)).toBe(1_000);
    expect(chunks.system?.readInt16LE(0)).toBe(2_000);
    expect(events.at(-1)).toMatchObject({
      captionMode: "streaming",
      captionProvider: "test-streaming",
      stableText: "",
      partialText: "远端方案\n正在讨论",
    });
    expect(existsSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"))).toBe(false);

    const result = await coordinator.stop(audioPath);

    expect(result).toMatchObject({
      status: "finished",
      text: "远端方案已经确认",
      stableText: "远端方案已经确认",
      partialText: "",
    });
    expect(readFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "utf8"))
      .toBe("远端方案已经确认\n");
    await coordinator.close();
  });

  it("shows one live caption when mic and system partials differ only cosmetically", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-partial-dedupe-"));
    roots.push(root);
    const audioPath = join(root, "重复字幕_20260721_140551.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          system: { partial: "嗯。所以这是我们学院的主要课程", stable: [], audioMs: 50 },
          mic: { partial: "嗯，所以这是我们学院的主要课程", stable: [], audioMs: 50 },
        },
      })),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "重复字幕", language: "zh" });

    expect(events.at(-1)?.partialText).toBe("嗯。所以这是我们学院的主要课程");
    await coordinator.close();
  });

  it("keeps the remaining channel visible when the active partial clears", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-partial-clear-"));
    roots.push(root);
    const audioPath = join(root, "单路字幕_20260722_120000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn()
        .mockResolvedValueOnce({
          updates: {
            system: { partial: "系统声音", stable: [], audioMs: 50 },
            mic: { partial: "麦克风仍在说", stable: [], audioMs: 50 },
          },
        })
        .mockResolvedValueOnce({
          updates: {
            system: { partial: "", stable: [], audioMs: 100 },
            mic: { partial: "麦克风仍在说", stable: [], audioMs: 100 },
          },
        }),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "单路字幕", language: "zh" });
    writeStereoWav(audioPath, 0.1);
    const result = await coordinator.stop(audioPath);

    expect(result?.partialText).toBe("麦克风仍在说");
    await coordinator.close();
  });

  it("shows the current revision instead of stacking it under the previous stable sentence", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-revision-display-"));
    roots.push(root);
    const audioPath = join(root, "修订显示_20260721_170601.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const stable = "然后所有的分配等等，比如说你，比如说我占了我";
    const partial = "然后所有的分配等等，比如说你，比如说我站在我的角度";
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          system: {
            partial,
            stable: [{ text: stable, endMs: 40 }],
            audioMs: 50,
          },
        },
      })),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "修订显示", language: "zh" });

    expect(events.at(-1)).toMatchObject({ text: partial, stableText: stable, partialText: partial });
    await coordinator.close();
  });

  it("deduplicates long cross-channel stable revisions despite timestamp drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-stable-dedupe-"));
    roots.push(root);
    const audioPath = join(root, "稳定字幕_20260721_140551.wav");
    writeStereoWav(audioPath, 0.05);
    const shared = "我们继续讨论实时字幕的稳定性，确保系统声音和麦克风收进来的同一句话不会在最终结果里完整重复一遍。";
    const pubsub = new PubSub<AppChannels>();
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          system: { partial: "", stable: [{ text: shared, endMs: 4_000 }], audioMs: 50, replaceStable: true },
          mic: { partial: "", stable: [{ text: shared.replace("同一句话", "同样一句话"), endMs: 9_000 }], audioMs: 50, replaceStable: true },
        },
      })),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "稳定字幕", language: "zh" });
    const result = await coordinator.stop(audioPath);

    expect(result?.stableText).toBe(shared);
    await coordinator.close();
  });

  it("replaces an xAI stable revision instead of appending the corrected transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-revision-"));
    roots.push(root);
    const audioPath = join(root, "修订会议_20260717_120000.wav");
    writeStereoWav(audioPath, 0.05);
    const engine: StreamingCaptionEngine = {
      provider: "xai-oauth:hermes",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          mic: {
            partial: "实时字",
            stable: [{ text: "测试雨露的实时字幕", endMs: 500 }],
            audioMs: 50,
            replaceStable: true,
          },
        },
      })),
      finish: vi.fn(async () => ({
        updates: {
          mic: {
            partial: "",
            stable: [{ text: "测试语录的实时字幕", endMs: 1_000 }],
            audioMs: 50,
            replaceStable: true,
          },
        },
      })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub: new PubSub<AppChannels>(),
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "修订会议", language: "zh" });
    const result = await coordinator.stop(audioPath);

    expect(result).toMatchObject({ text: "测试语录的实时字幕", partialText: "" });
    expect(readFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "utf8"))
      .toBe("测试语录的实时字幕\n");
    await coordinator.close();
  });

  it("fails the selected streaming engine without switching to segmented transcription", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-stream-fallback-"));
    roots.push(root);
    const audioPath = join(root, "回退会议_20260716_191000.wav");
    writeStereoWav(audioPath, 0.05);
    const transcribe = vi.fn(async () => ({ transcript: "兼容回退正常", provider: "test", chunks: 1, language: "zh" as const }));
    const engine: StreamingCaptionEngine = {
      provider: "broken-stream",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn()
        .mockRejectedValueOnce(new Error("xAI streaming STT connection closed early"))
        .mockRejectedValueOnce(new Error("实时字幕引擎尚未启动")),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub: new PubSub<AppChannels>(),
      streaming: engine,
      transcribe,
      minSegmentMs: 1,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "回退会议", language: "zh" });
    writeStereoWav(audioPath, 0.1);
    const result = await coordinator.stop(audioPath);

    expect(engine.abort).toHaveBeenCalledOnce();
    expect(engine.feed).toHaveBeenCalledOnce();
    expect(transcribe).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: "failed",
      captionMode: "streaming",
      captionProvider: "broken-stream",
      reason: "realtime transcription failed: xAI streaming STT connection closed early",
      text: "",
    });
  });

  it("tails a growing Yulu WAV, freezes the selected language, and persists partial text", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-"));
    roots.push(root);
    const audioPath = join(root, "中文会议_20260714_160000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const transcribe = vi.fn(async (_path: string, language: "zh" | "en" | "ja" | "auto") => ({
      transcript: "这是中文，with an English term",
      provider: "hermes-whispercpp-server",
      chunks: 1,
      language,
    }));
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "中文会议", language: "zh" });
    await coordinator.stop(audioPath);

    expect(transcribe).toHaveBeenCalledWith(expect.stringMatching(/\.wav$/), "zh");
    expect(readFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "utf8"))
      .toContain("这是中文，with an English term");
    expect(events.at(-1)).toMatchObject({
      status: "finished",
      language: "zh",
      text: "这是中文，with an English term",
      trusted: true,
    });
    await coordinator.close();
  });

  it("never trusts a realtime transcript after a chunk transcription failure", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-failed-"));
    roots.push(root);
    const audioPath = join(root, "失败会议_20260714_170000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe: vi.fn(async () => { throw new Error("provider unavailable"); }),
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "失败会议", language: "zh" });
    const result = await coordinator.stop(audioPath);

    expect(result).toMatchObject({
      status: "failed",
      trusted: false,
      error: "provider unavailable",
    });
  });

  it("drops per-chunk language drift and known caption hallucinations without failing the session", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-quality-"));
    roots.push(root);
    const audioPath = join(root, "中文会议_20260715_171311.wav");
    writeStereoWav(audioPath, 0.2);
    const pubsub = new PubSub<AppChannels>();
    const transcribe = vi.fn()
      .mockResolvedValueOnce({
        transcript: [
          "﹑Cindy，Azure﹑Key﹑Key﹑Key﹑偶尔可能会回条消息",
          "我们讨论 Alpha 社区的方案，以及下一步的 FDE 安排。",
        ].join("\n"), provider: "test", chunks: 1, language: "zh",
      })
      .mockResolvedValueOnce({
        transcript: [
          "﹑Aaron﹑Aaron﹑Aaron﹑我们再怎么样去参与",
          "李宗盛﹑李宗盛﹑",
          "※字幕志愿者:刘文贵",
        ].join("\n"), provider: "test", chunks: 1, language: "zh",
      })
      .mockRejectedValueOnce(new Error(
        "selected audio engine transcript violated the requested language contract: requested Chinese but transcript is English-only",
      ))
      .mockResolvedValue({
        transcript: "我们继续讨论项目安排", provider: "test", chunks: 1, language: "zh",
      });
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe,
      minSegmentMs: 1,
      chunkSec: 0.05,
      overlapMs: 0,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "中文会议", language: "zh" });
    const result = await coordinator.stop(audioPath);

    expect(transcribe).toHaveBeenCalledTimes(4);
    expect(result).toMatchObject({
      status: "finished",
      trusted: true,
      text: [
        "偶尔可能会回条消息",
        "我们讨论 Alpha 社区的方案，以及下一步的 FDE 安排。",
        "我们再怎么样去参与",
        "我们继续讨论项目安排",
      ].join("\n"),
    });
    expect(readFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "utf8"))
      .toBe([
        "偶尔可能会回条消息",
        "我们讨论 Alpha 社区的方案，以及下一步的 FDE 安排。",
        "我们再怎么样去参与",
        "我们继续讨论项目安排\n",
      ].join("\n"));
    await coordinator.close();
  });

  it("does not publish a new event for an unchanged audio poll", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-idle-poll-"));
    roots.push(root);
    const audioPath = join(root, "安静会议_20260714_170500.wav");
    writeStereoWav(audioPath, 0.05, 0);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const warm = vi.fn(async () => {});
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      warm,
      transcribe: vi.fn(async (_path: string, language: "zh" | "en" | "ja" | "auto") => ({
        transcript: "", provider: "test", chunks: 1, language,
      })),
      pollMs: 5,
    });

    await coordinator.start({ audioPath, title: "安静会议", language: "zh" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(warm).toHaveBeenCalledOnce();
    expect(events).toHaveLength(1);
    await coordinator.stop(audioPath);
  });

  it("publishes source and bounded translation fields and updates the target language", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-translation-"));
    roots.push(root);
    const audioPath = join(root, "双语会议_20260714_180000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const translate = vi.fn(async (text: string, target: string) => `${target}:${text}`);
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe: vi.fn(async (_path: string, language: "zh" | "en" | "ja" | "auto") => ({
        transcript: "我们确认下一步", provider: "test", chunks: 1, language,
      })),
      translate,
      defaultTargetLanguage: () => "English",
      defaultTranslationEnabled: true,
      minSegmentMs: 1,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "双语会议", language: "zh" });
    await vi.waitFor(() => expect(events.some((event) => event.translationStatus === "ready")).toBe(true));
    expect(events.at(-1)).toMatchObject({
      sourceText: "我们确认下一步",
      sourceLanguage: "zh",
      targetLanguage: "English",
      translationText: "English:我们确认下一步",
      translationStatus: "ready",
    });
    expect(events.at(-1)?.sequence).toBeGreaterThan(0);

    const translationCalls = translate.mock.calls.length;
    const unchanged = await coordinator.updateOptions({
      audioPath,
      targetLanguage: "English",
      translationEnabled: true,
    });
    expect(unchanged).toMatchObject({
      translationText: "English:我们确认下一步",
      translationStatus: "ready",
    });
    expect(translate).toHaveBeenCalledTimes(translationCalls);

    await coordinator.updateOptions({ audioPath, targetLanguage: "日本語", translationEnabled: true });
    await vi.waitFor(() => expect(events.at(-1)?.translationText).toBe("日本語:我们确认下一步"));
    expect(translate).toHaveBeenLastCalledWith("我们确认下一步", "日本語", []);
    await coordinator.updateOptions({ audioPath, targetLanguage: "日本語", translationEnabled: false });
    expect(events.at(-1)).toMatchObject({ translationText: "", translationStatus: "disabled" });
    await coordinator.stop(audioPath);
  });

  it("keeps the previous translation visible while the next caption is translating", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-translation-pending-"));
    roots.push(root);
    const audioPath = join(root, "连续翻译_20260722_120000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    let resolveNext: ((value: string) => void) | undefined;
    const nextTranslation = new Promise<string>((resolve) => { resolveNext = resolve; });
    const translate = vi.fn()
      .mockResolvedValueOnce("First translation")
      .mockReturnValueOnce(nextTranslation);
    const engine: StreamingCaptionEngine = {
      provider: "test-streaming",
      warm: vi.fn(async () => {}),
      start: vi.fn(async () => {}),
      feed: vi.fn(async () => ({
        updates: {
          mic: { partial: "", stable: [{ text: "第一句", endMs: 50 }], audioMs: 50 },
        },
      })),
      finish: vi.fn(async () => ({ updates: {} })),
      abort: vi.fn(async () => {}),
      close: vi.fn(async () => {}),
    };
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      streaming: engine,
      transcribe: vi.fn(async () => ({ transcript: "unused", provider: "test", chunks: 1, language: "zh" as const })),
      translate,
      defaultTranslationEnabled: true,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "连续翻译", language: "zh" });
    await vi.waitFor(() => expect(events.at(-1)?.translationText).toBe("First translation"));
    const internal = coordinator as unknown as {
      active: object;
      applyStreamingUpdate(session: object, response: StreamingCaptionUpdate): void;
    };
    internal.applyStreamingUpdate(internal.active, {
      updates: {
        mic: { partial: "", stable: [{ text: "第二句", endMs: 100 }], audioMs: 100 },
      },
    });

    expect(events.at(-1)).toMatchObject({
      sourceText: "第二句",
      translationText: "First translation",
      translationStatus: "pending",
    });
    resolveNext?.("Second translation");
    await vi.waitFor(() => expect(events.at(-1)?.translationText).toBe("Second translation"));
    await coordinator.stop(audioPath);
  });

  it("keeps translation off until the user explicitly enables it", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-source-only-"));
    roots.push(root);
    const audioPath = join(root, "仅原文_20260715_180000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const translate = vi.fn(async () => "must not run");
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe: vi.fn(async () => ({ transcript: "默认仅显示原文", provider: "test", chunks: 1, language: "zh" as const })),
      translate,
      minSegmentMs: 1,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "仅原文", language: "zh" });
    await coordinator.stop(audioPath);

    expect(translate).not.toHaveBeenCalled();
    expect(events.at(-1)).toMatchObject({
      sourceText: "默认仅显示原文",
      translationText: "",
      translationStatus: "disabled",
    });
  });

  it("publishes translation failure without losing the source caption", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-translation-failure-"));
    roots.push(root);
    const audioPath = join(root, "翻译失败_20260715_181000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe: vi.fn(async () => ({ transcript: "原文仍然可用", provider: "test", chunks: 1, language: "zh" as const })),
      translate: vi.fn(async () => { throw new Error("Hermes unavailable"); }),
      defaultTranslationEnabled: true,
      minSegmentMs: 1,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "翻译失败", language: "zh" });
    await vi.waitFor(() => expect(events.at(-1)?.translationStatus).toBe("failed"));

    expect(events.at(-1)).toMatchObject({ sourceText: "原文仍然可用", translationText: "" });
    await coordinator.stop(audioPath);
  });

  it("discards stale translations and coalesces rapid target changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-realtime-translation-stale-"));
    roots.push(root);
    const audioPath = join(root, "快速切换_20260715_182000.wav");
    writeStereoWav(audioPath, 0.05);
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    let resolveFirst: ((value: string) => void) | undefined;
    const first = new Promise<string>((resolve) => { resolveFirst = resolve; });
    const translate = vi.fn(async (_text: string, target: string) => {
      if (translate.mock.calls.length === 1) return first;
      return `${target}:最新翻译`;
    });
    const coordinator = new RealtimeTranscriptionCoordinator({
      pubsub,
      transcribe: vi.fn(async () => ({ transcript: "快速切换目标语言", provider: "test", chunks: 1, language: "zh" as const })),
      translate,
      defaultTranslationEnabled: true,
      minSegmentMs: 1,
      chunkSec: 0.01,
      pollMs: 60_000,
    });

    await coordinator.start({ audioPath, title: "快速切换", language: "zh" });
    await vi.waitFor(() => expect(translate).toHaveBeenCalledTimes(1));
    await coordinator.updateOptions({ audioPath, targetLanguage: "日本語", translationEnabled: true });
    await coordinator.updateOptions({ audioPath, targetLanguage: "한국어", translationEnabled: true });
    resolveFirst?.("English:过期翻译");
    await vi.waitFor(() => expect(events.at(-1)?.translationText).toBe("한국어:最新翻译"));

    expect(translate).toHaveBeenCalledTimes(2);
    expect(translate).toHaveBeenLastCalledWith("快速切换目标语言", "한국어", []);
    expect(events.some((event) => event.translationText === "English:过期翻译")).toBe(false);
    await coordinator.stop(audioPath);
  });
});

describe("realtime caption segmentation", () => {
  it("keeps source channels separate and removes delayed cross-channel duplicates", () => {
    const source = Buffer.alloc(48 * 4);
    for (let frame = 0; frame < 48; frame += 1) {
      source.writeInt16LE(1_000, frame * 4);
      source.writeInt16LE(2_000, frame * 4 + 2);
    }
    const separated = sourceSeparated16kPcm(source, {
      dataOffset: 44,
      channels: 2,
      sampleRate: 48_000,
      blockAlign: 4,
      bitsPerSample: 16,
    });
    expect(separated.chunks.mic).toHaveLength(16 * 2);
    expect(separated.chunks.system).toHaveLength(16 * 2);
    expect(separated.chunks.mic?.readInt16LE(0)).toBe(1_000);
    expect(separated.chunks.system?.readInt16LE(0)).toBe(2_000);
    expect(captionsLikelyDuplicate("我们继续讨论实时转录方案", "我们继续讨论实时转录的方案")).toBe(true);
    expect(captionsLikelyDuplicate("我同意这个方向", "接下来检查安装步骤")).toBe(false);
  });

  it("cuts after trailing silence and removes overlap text", () => {
    const voice = monoPcm(1.3, 5_000);
    const silence = monoPcm(0.5, 0);
    const pcm = Buffer.concat([voice, silence]);
    expect(trailingSilenceMs(pcm)).toBeGreaterThanOrEqual(450);
    expect(segmentCutBytes(pcm)).toBe(pcm.length);
    expect(dedupeTranscriptSegment("hello world", "world again")).toBe("again");
  });

  it("cuts an overlong segment at the quietest recent frame", () => {
    const pcm = Buffer.concat([
      monoPcm(2, 5_000),
      monoPcm(0.05, 50),
      monoPcm(0.95, 5_000),
    ]);

    const cut = segmentCutBytes(pcm, {
      minSegmentMs: 1_000,
      tailSilenceMs: 450,
      maxSegmentMs: 2_000,
    });

    expect(cut).toBeGreaterThanOrEqual(2_000 * 32);
    expect(cut).toBeLessThan(pcm.length);
    expect(cut % 2).toBe(0);
  });

  it("force-flushes only complete PCM samples", () => {
    expect(segmentCutBytes(Buffer.alloc(101), { force: true })).toBe(100);
  });
});

describe("assessRealtimeTranscript", () => {
  it("rejects an English-only result for a Chinese recording", () => {
    expect(assessRealtimeTranscript({
      text: "This is an English hallucination from a Chinese meeting.",
      language: "zh",
      coveredMs: 60_000,
      totalMs: 60_000,
    }).trusted).toBe(false);
  });

  it("accepts Chinese with occasional English terminology", () => {
    expect(assessRealtimeTranscript({
      text: "我们讨论 Alpha 社区的方案，以及下一步的 FDE 安排。",
      language: "zh",
      coveredMs: 58_000,
      totalMs: 60_000,
    }).trusted).toBe(true);
  });
});
