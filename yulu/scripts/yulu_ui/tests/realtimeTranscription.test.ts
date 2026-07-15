import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import {
  RealtimeTranscriptionCoordinator,
  assessRealtimeTranscript,
  dedupeTranscriptSegment,
  segmentCutBytes,
  trailingSilenceMs,
  trustedRealtimeTranscript,
} from "../src/realtimeTranscription.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeStereoWav(path: string, seconds: number, sample = 5000): void {
  const frames = Math.floor(48_000 * seconds);
  const pcm = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i += 1) {
    pcm.writeInt16LE(sample, i * 4);
    pcm.writeInt16LE(sample, i * 4 + 2);
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
    expect(trustedRealtimeTranscript(audioPath, "zh")).toBeNull();
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
        "Hermes transcript violated the requested language contract: requested Chinese but transcript is English-only",
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

    await coordinator.updateOptions({ audioPath, targetLanguage: "日本語", translationEnabled: true });
    await vi.waitFor(() => expect(events.at(-1)?.translationText).toBe("日本語:我们确认下一步"));
    expect(translate).toHaveBeenLastCalledWith("我们确认下一步", "日本語", []);
    await coordinator.updateOptions({ audioPath, targetLanguage: "日本語", translationEnabled: false });
    expect(events.at(-1)).toMatchObject({ translationText: "", translationStatus: "disabled" });
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
