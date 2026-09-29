import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { RealtimeTranscriptionCoordinator } from "../src/realtimeTranscription.js";
import { XaiAudioClient } from "../src/xaiAudio.js";

function writeAudio(path: string, micAmplitude: number, systemAmplitude: number): void {
  const wav = Buffer.alloc(44 + 16_000 * 4);
  wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(16_000, 24); wav.writeUInt32LE(64_000, 28);
  wav.writeUInt16LE(4, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let i = 0; i < 16_000; i++) {
    wav.writeInt16LE(Math.round(Math.sin(i * Math.PI / 13) * micAmplitude), 44 + i * 4);
    wav.writeInt16LE(Math.round(Math.sin(i * Math.PI / 13) * systemAmplitude), 46 + i * 4);
  }
  writeFileSync(path, wav);
}

describe("realtime silence filtering through the Host", () => {
  it.each([
    { mic: 0, system: 0, accepted: "" },
    { mic: 80, system: 80, accepted: "" },
    { mic: 240, system: 0, accepted: "A quiet reply." },
    { mic: 80, system: 600, accepted: "A system reply." },
  ])("publishes and persists only supported audio: $mic/$system", async ({ mic, system, accepted }) => {
    const root = mkdtempSync(join(tmpdir(), "yulu-silence-pipeline-"));
    const audioPath = join(root, "meeting.wav"); writeAudio(audioPath, mic, system);
    const client = new XaiAudioClient({ resolve: async () => ({ accessToken: "fixture", source: "oauth" }),
      cachedStatus: () => ({ source: "oauth" }) } as never);
    const internal = client as unknown as {
      connectRealtime(): Promise<void>;
      socket: { readyState: number; send(data: Buffer | string): void; close(): void };
      done: Promise<void>; doneResolve(): void; handleMessage(raw: string): void;
    };
    const texts = [mic >= 240 ? "A quiet reply." : "An invented microphone sentence.",
      system >= 240 ? "A system reply." : "An invented system sentence."];
    const connect = vi.spyOn(internal, "connectRealtime").mockImplementation(async () => {
      internal.done = new Promise((resolve) => { internal.doneResolve = resolve; });
      internal.socket = { readyState: 1, close() {}, send(data) {
        const type = Buffer.isBuffer(data) ? "transcript.partial" : "transcript.done";
        for (const channel_index of [0, 1]) internal.handleMessage(JSON.stringify({
          type, channel_index, text: texts[channel_index], start: 0, duration: 1,
          is_final: true, speech_final: true,
        }));
      } };
    });
    const pubsub = new PubSub<AppChannels>();
    const events: AppChannels["realtime-transcript"][] = [];
    pubsub.subscribe("realtime-transcript", (event) => events.push(event));
    const translate = vi.fn(async (text: string) => `Translated: ${text}`);
    const coordinator = new RealtimeTranscriptionCoordinator({ pubsub, streaming: client,
      transcribe: vi.fn(), translate, defaultTranslationEnabled: true, pollMs: 60_000 });
    try {
      await coordinator.start({ audioPath, title: "Fixture", language: "en" });
      const result = await coordinator.stop(audioPath);
      expect(result?.stableText).toBe(accepted);
      expect(JSON.stringify(events)).not.toContain("invented");
      const sidecar = audioPath.replace(/\.wav$/, ".realtime.transcript.txt");
      expect(existsSync(sidecar) ? readFileSync(sidecar, "utf8").trim() : "").toBe(accepted);
      if (accepted) expect(translate).toHaveBeenCalledWith(accepted, "English", []);
      else expect(translate).not.toHaveBeenCalled();
    } finally {
      await coordinator.close(); connect.mockRestore(); rmSync(root, { recursive: true, force: true });
    }
  });
});
