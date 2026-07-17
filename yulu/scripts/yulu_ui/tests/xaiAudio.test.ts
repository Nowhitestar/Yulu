import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { XaiAudioClient } from "../src/xaiAudio.js";

const roots: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.PATH = originalPath;
  delete process.env.FFMPEG_ARGS_FILE;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("XaiAudioClient", () => {
  it("keeps partials live while replacing segmented finals with xAI's corrected full transcript", () => {
    const credentials = { resolve: vi.fn(), cachedStatus: vi.fn() };
    const client = new XaiAudioClient(credentials as never, () => "hermes");
    const internal = client as unknown as {
      handleMessage(raw: string): void;
      drain(): {
        updates: {
          mic?: { partial: string; stable: Array<{ text: string; endMs: number }>; replaceStable?: boolean };
        };
      };
    };

    internal.handleMessage(JSON.stringify({
      type: "transcript.partial",
      text: "大家好",
      is_final: false,
      channel_index: 0,
    }));
    expect(internal.drain().updates.mic).toMatchObject({ partial: "大家好", stable: [] });

    internal.handleMessage(JSON.stringify({
      type: "transcript.partial",
      text: "大家好，今天我们测试雨露的实时字幕，重点比较本",
      is_final: true,
      channel_index: 0,
      start: 0,
      duration: 4,
    }));
    expect(internal.drain().updates.mic).toMatchObject({
      partial: "",
      replaceStable: true,
      stable: [{ text: "大家好，今天我们测试雨露的实时字幕，重点比较本" }],
    });

    internal.handleMessage(JSON.stringify({
      type: "transcript.partial",
      text: "地模型和云端模型的延迟与准确率。",
      is_final: true,
      channel_index: 0,
      start: 4,
      duration: 4,
    }));
    expect(internal.drain().updates.mic?.stable[0]?.text).toBe(
      "大家好，今天我们测试雨露的实时字幕，重点比较本\n地模型和云端模型的延迟与准确率。",
    );

    const corrected = "大家好，今天我们测试语录的实时字幕，重点比较本地模型和云端模型的延迟与准确率。";
    internal.handleMessage(JSON.stringify({
      type: "transcript.partial",
      text: corrected,
      is_final: true,
      channel_index: 0,
      start: 0,
      duration: 8,
    }));
    expect(internal.drain().updates.mic).toMatchObject({
      partial: "",
      replaceStable: true,
      stable: [{ text: corrected }],
    });

    internal.handleMessage(JSON.stringify({ type: "transcript.done", text: corrected, channel_index: 0 }));
    expect(internal.drain().updates.mic).toMatchObject({ partial: "", stable: [] });
  });

  it("compresses meeting audio before REST STT and retries a transient xAI 500", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-xai-audio-"));
    roots.push(root);
    const audioPath = join(root, "probe.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const ffmpegPath = join(root, "ffmpeg");
    const ffmpegArgsPath = join(root, "ffmpeg.args");
    writeFileSync(ffmpegPath, [
      "#!/bin/sh",
      "printf '%s\\n' \"$@\" > \"$FFMPEG_ARGS_FILE\"",
      "for last do :; done",
      "printf 'fLaC' > \"$last\"",
    ].join("\n"));
    chmodSync(ffmpegPath, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    process.env.FFMPEG_ARGS_FILE = ffmpegArgsPath;
    const credentials = {
      resolve: vi.fn(async () => ({
        accessToken: "test-oauth-token",
        source: "hermes" as const,
      })),
      cachedStatus: vi.fn(),
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.x.ai/v1/stt");
      expect(init?.headers).toEqual({ Authorization: "Bearer test-oauth-token" });
      expect(init?.body).toBeInstanceOf(FormData);
      const upload = (init?.body as FormData).get("file") as File;
      expect(upload.name).toBe("audio.flac");
      expect(upload.type).toBe("audio/flac");
      if (fetchMock.mock.calls.length === 1) {
        return new Response(JSON.stringify({ error: { message: "temporary backend failure" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ text: "hello from xAI" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new XaiAudioClient(credentials as never, () => "hermes");

    await expect(client.transcribeFile(audioPath, "en")).resolves.toEqual({
      transcript: "hello from xAI",
      provider: "xai-oauth:hermes",
      chunks: 1,
      language: "en",
    });
    expect(credentials.resolve).toHaveBeenCalledWith("hermes");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(ffmpegArgsPath, "utf8")).toContain("-ac\n1\n-ar\n16000\n-c:a\nflac");

    const persistentFailure = vi.fn(async () => new Response("{}", {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    vi.stubGlobal("fetch", persistentFailure);
    await expect(client.transcribeFile(audioPath, "en")).rejects.toThrow(
      "xAI transcription failed (500): xAI service returned an internal error after retry",
    );
    expect(persistentFailure).toHaveBeenCalledTimes(2);
  });
});
