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
  delete process.env.FFMPEG_SECOND_CHUNK;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("XaiAudioClient", () => {
  it("keeps partials live while replacing segmented finals with xAI's corrected full transcript", () => {
    const credentials = { resolve: vi.fn(), cachedStatus: vi.fn() };
    const client = new XaiAudioClient(credentials as never);
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

  it("reconnects a half-open realtime stream after voiced audio produces no transcript", async () => {
    const credentials = { resolve: vi.fn(), cachedStatus: vi.fn() };
    const client = new XaiAudioClient(credentials as never);
    const send = vi.fn();
    const reconnectRealtime = vi.fn(async () => {});
    const internal = client as unknown as {
      socket: { readyState: number; send: typeof send };
      realtimeUrl: URL;
      voiceWithoutTranscriptMs: number;
      reconnectRealtime(): Promise<void>;
    };
    internal.socket = { readyState: 1, send };
    internal.realtimeUrl = new URL("wss://api.x.ai/v1/stt");
    internal.voiceWithoutTranscriptMs = 11_900;
    internal.reconnectRealtime = reconnectRealtime;
    const voicedPcm = Buffer.alloc(3_200);
    for (let offset = 0; offset < voicedPcm.length; offset += 2) voicedPcm.writeInt16LE(5_000, offset);

    await client.feed({ mic: voicedPcm });

    expect(reconnectRealtime).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });

  it("keeps a retryable TLS reconnect failure non-terminal and retries after backoff", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "test-oauth-token" })),
      cachedStatus: vi.fn(),
    };
    const client = new XaiAudioClient(credentials as never);
    const connectRealtime = vi.fn()
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockRejectedValueOnce(new Error("Client network socket disconnected before secure TLS connection was established"))
      .mockResolvedValueOnce(undefined);
    const internal = client as unknown as {
      connectRealtime: typeof connectRealtime;
      connectRealtimeWithRetry(url: URL): Promise<boolean>;
      reconnectDelayMs: number;
    };
    internal.connectRealtime = connectRealtime;
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
    const url = new URL("wss://api.x.ai/v1/stt");

    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(false);
    expect(connectRealtime).toHaveBeenCalledTimes(2);

    now.mockReturnValue(10_999);
    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(false);
    expect(connectRealtime).toHaveBeenCalledTimes(2);

    now.mockReturnValue(11_000);
    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(false);
    expect(internal.reconnectDelayMs).toBe(4_000);

    now.mockReturnValue(13_000);
    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(false);
    expect(internal.reconnectDelayMs).toBe(5_000);

    now.mockReturnValue(17_000);
    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(false);
    expect(internal.reconnectDelayMs).toBe(5_000);

    now.mockReturnValue(22_000);
    await expect(internal.connectRealtimeWithRetry(url)).resolves.toBe(true);
    expect(connectRealtime).toHaveBeenCalledTimes(9);
    expect(internal.reconnectDelayMs).toBe(1_000);
    now.mockRestore();
  });

  it("reports the last streaming error when recording finishes disconnected", async () => {
    const client = new XaiAudioClient({} as never);
    const error = new Error("xAI streaming STT connection closed early");
    (client as unknown as { lastStreamingError: Error }).lastStreamingError = error;

    await expect(client.finish()).rejects.toBe(error);
  });

  it("keeps earlier stable text when a replayed realtime session sends an authoritative revision", () => {
    const credentials = { resolve: vi.fn(), cachedStatus: vi.fn() };
    const client = new XaiAudioClient(credentials as never);
    const internal = client as unknown as {
      realtimeGeneration: number;
      sessionBaseMs: number;
      handleMessage(raw: string): void;
      drain(): {
        updates: { mic?: { stable: Array<{ text: string }>; replaceStable?: boolean } };
      };
    };
    internal.handleMessage(JSON.stringify({
      type: "transcript.done",
      text: "one two three four five",
      channel_index: 0,
      start: 0,
      duration: 10,
    }));
    internal.drain();
    internal.realtimeGeneration = 1;
    internal.sessionBaseMs = 5_000;

    internal.handleMessage(JSON.stringify({
      type: "transcript.done",
      text: "three four five six seven",
      channel_index: 0,
      start: 0,
      duration: 10,
    }));

    expect(internal.drain().updates.mic).toMatchObject({
      replaceStable: true,
      stable: [{ text: "one two three four five\nsix seven" }],
    });
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
      "first=$(printf '%s' \"$last\" | sed 's/%04d/0000/')",
      "printf 'fLaC' > \"$first\"",
      "if [ \"$FFMPEG_SECOND_CHUNK\" = 1 ]; then",
      "  second=$(printf '%s' \"$last\" | sed 's/%04d/0001/')",
      "  printf 'fLaC' > \"$second\"",
      "fi",
    ].join("\n"));
    chmodSync(ffmpegPath, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    process.env.FFMPEG_ARGS_FILE = ffmpegArgsPath;
    const credentials = {
      resolve: vi.fn(async () => ({
        accessToken: "test-oauth-token",
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
    const client = new XaiAudioClient(credentials as never);

    await expect(client.transcribeFile(audioPath, "en")).resolves.toEqual({
      transcript: "hello from xAI",
      provider: "xai-oauth:yulu",
      chunks: 1,
      language: "en",
    });
    expect(credentials.resolve).toHaveBeenCalledTimes(2);
    expect(credentials.resolve).toHaveBeenCalledWith();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(readFileSync(ffmpegArgsPath, "utf8")).toContain("-ac\n1\n-ar\n16000\n-c:a\nflac");
    expect(readFileSync(ffmpegArgsPath, "utf8")).toContain("-segment_time\n600");

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

  it("transcribes long recordings as separate requests and merges overlap", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-xai-audio-segments-"));
    roots.push(root);
    const audioPath = join(root, "long.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const ffmpegPath = join(root, "ffmpeg");
    writeFileSync(ffmpegPath, [
      "#!/bin/sh",
      "for last do :; done",
      "first=$(printf '%s' \"$last\" | sed 's/%04d/0000/')",
      "second=$(printf '%s' \"$last\" | sed 's/%04d/0001/')",
      "printf 'fLaC' > \"$first\"",
      "printf 'fLaC' > \"$second\"",
    ].join("\n"));
    chmodSync(ffmpegPath, 0o755);
    process.env.PATH = `${root}:${originalPath ?? ""}`;
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "fresh-token" })),
      cachedStatus: vi.fn(),
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      text: fetchMock.mock.calls.length === 1
        ? "one two three four five"
        : "three four five six seven",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new XaiAudioClient(credentials as never);

    await expect(client.transcribeFile(audioPath, "en")).resolves.toEqual({
      transcript: "one two three four five\nsix seven",
      provider: "xai-oauth:yulu",
      chunks: 2,
      language: "en",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(credentials.resolve).toHaveBeenCalledTimes(2);
  });
});
