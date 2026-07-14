import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import {
  RealtimeTranscriptionCoordinator,
  assessRealtimeTranscript,
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
