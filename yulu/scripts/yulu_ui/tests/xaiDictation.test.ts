import { afterEach, describe, expect, it, vi } from "vitest";
import { XaiAudioClient } from "../src/xaiAudio.js";
import type { StreamingCaptionUpdate } from "../src/localCaptionEngine.js";
import { AudioEvidence } from "../src/audioEvidence.js";

const clients: XaiAudioClient[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.abort(); vi.restoreAllMocks(); });
function voice(ms: number, amplitude = 600): Buffer {
  const pcm = Buffer.alloc(ms * 32);
  for (let i = 0; i < pcm.length / 2; i++) pcm.writeInt16LE(Math.round(Math.sin(i * Math.PI / 13) * amplitude), i * 2);
  return pcm;
}
async function setup(dictation = true) {
  const client = new XaiAudioClient({ resolve: vi.fn(async () => ({ accessToken: "test", source: "oauth" })), cachedStatus: () => ({ source: "oauth" }) } as never);
  clients.push(client);
  const send = vi.fn();
  const internal = client as unknown as {
    socket: { readyState: number; send: typeof send; close: () => void };
    done: Promise<void>; doneResolve: () => void;
    connectRealtime(credential: unknown, url: URL): Promise<void>;
    handleMessage(raw: string): void; drain(): StreamingCaptionUpdate;
  };
  let connectedUrl!: URL;
  vi.spyOn(internal, "connectRealtime").mockImplementation(async (_credential, url) => {
    connectedUrl = url;
    internal.done = new Promise((resolve) => { internal.doneResolve = resolve; });
    internal.socket = { readyState: 1, send, close: vi.fn() };
  });
  await client.start("zh", { dictation, glossary: { prompt: "UnspokenOne，UnspokenTwo", replacements: [], summaryInstruction: "" } });
  const event = (fields: object) => internal.handleMessage(JSON.stringify({ type: "transcript.partial", channel_index: 0, ...fields }));
  return { client, internal, send, url: connectedUrl, event };
}

describe("grounded microphone dictation", () => {
  it.each([false, true])("enables the provider speech gate for dictation=%s", async (dictation) => {
    const { url } = await setup(dictation);
    expect(url.searchParams.get("vad_threshold")).toBe("0.3");
  });

  it.each([false, true])("rejects low background noise before any caption or final is published, dictation=%s", async (dictation) => {
    const { client, event, internal } = await setup(dictation);
    await client.feed({ mic: voice(1000, 80), system: Buffer.alloc(32_000) });
    for (const fields of [
      { is_final: false }, { is_final: true, speech_final: true }, { type: "transcript.done" },
    ]) {
      event({ text: "A fictional sentence nobody said.", start: 0, duration: 1, ...fields });
      expect(internal.drain().updates.mic).toMatchObject({ partial: "", stable: [], stableCaption: null });
    }
  });

  it("does not let earlier speech authorize later silence without word timestamps", async () => {
    const { client, event, internal } = await setup(false);
    await client.feed({ mic: Buffer.concat([voice(1000), Buffer.alloc(160_000)]) });
    event({ text: "保留这句", start: 0, duration: 1, is_final: true, speech_final: true });
    expect(internal.drain().updates.mic?.stable[0]?.text).toBe("保留这句");
    for (const timing of [{ start: 0, duration: 6 }, {}]) {
      event({ text: "静音时不该出现的新句子", is_final: false, ...timing });
      expect(internal.drain().updates.mic?.partial).toBe("");
      event({ text: "静音时不该出现的新句子", is_final: true, speech_final: true, ...timing });
      expect(internal.drain().updates.mic).toMatchObject({ stable: [], stableCaption: { text: "保留这句", endMs: 1000 } });
    }
    event({ type: "transcript.done", text: "静音时不该替换原文", duration: 6 });
    expect(internal.drain().updates.mic?.stable).toEqual([]);
    // A delayed whole-session correction with actual word evidence remains valid.
    event({ type: "transcript.done", text: "保留这一句", duration: 6,
      words: [{ text: "保留这一句", start: 0, end: 1 }] });
    expect(internal.drain().updates.mic?.stable[0]?.text).toBe("保留这一句");
  });

  it("keeps quiet short speech and rejects words in the other channel", async () => {
    const { client, event, internal } = await setup(false);
    await client.feed({ mic: voice(80, 240), system: voice(80, 80) });
    event({ text: "不", start: 0, duration: 0.08, is_final: true, speech_final: true });
    event({ channel_index: 1, text: "没有人在说话", start: 0, duration: 0.08, is_final: true, speech_final: true });
    const update = internal.drain();
    expect(update.updates.mic?.stable[0]?.text).toBe("不");
    expect(update.updates.system).toMatchObject({ partial: "", stable: [], stableCaption: null });
  });

  it("keeps evidence aligned with zero-padded channels and reconnect replay offsets", async () => {
    const { client, event, internal } = await setup(false);
    await client.feed({ mic: voice(1000) });
    await client.feed({ system: voice(1000) });
    event({ channel_index: 1, text: "后一句", start: 1, duration: 1, is_final: true, speech_final: true });
    const update = internal.drain();
    expect(update.updates.system).toMatchObject({ audioMs: 2000, stable: [{ text: "后一句", endMs: 2000 }] });
    expect(update.updates.mic?.audioMs).toBe(2000);
    // Replayed provider times start at zero; evidence stays on the WAV timeline.
    (internal as unknown as { sessionBaseMs: number }).sessionBaseMs = 1000;
    event({ channel_index: 1, text: "修正后一句", start: 0, duration: 1, is_final: true, speech_final: true,
      words: [{ text: "修正后一句", start: 0, end: 1 }] });
    expect(internal.drain().updates.system?.stable[0]?.text).toBe("修正后一句");
    event({ channel_index: 0, text: "静音声道", start: 0.3, duration: 0.7, is_final: true, speech_final: true });
    expect(internal.drain().updates.mic?.stable).toEqual([]);
  });

  it("sends a single PCM channel with no vocabulary hint, even when a glossary was supplied", async () => {
    const { client, send, url } = await setup();
    expect(url.searchParams.get("channels")).toBe("1");
    expect(url.searchParams.has("multichannel")).toBe(false);
    expect(url.searchParams.has("keyterm")).toBe(false);
    const mic = voice(100);
    await client.feed({ mic, system: voice(100, 2000) });
    expect(send.mock.calls[0]![0]).toEqual(mic);
  });

  it("rejects a glossary-like list on silence and ignores the disabled system channel", async () => {
    const { client, event, internal } = await setup();
    await client.feed({ mic: Buffer.alloc(32_000) });
    event({ text: "UnspokenOne, UnspokenTwo", start: 0, duration: 1, is_final: true, speech_final: true });
    event({ channel_index: 1, text: "也不能混进听写", start: 0, duration: 1, is_final: true });
    expect(internal.drain().updates.mic?.stable).toEqual([]);
    expect(internal.drain().updates.system?.stable).toEqual([]);
    const result = await client.finish();
    expect(result.updates.mic?.stable).toEqual([]);
  });

  it("rejects text in silent intervals and a whole-session revision with ungrounded word timestamps", async () => {
    const { client, event, internal } = await setup();
    await client.feed({ mic: Buffer.concat([voice(1000), Buffer.alloc(64_000)]) });
    event({ text: "保留这一句", start: 0, duration: 1, is_final: true, speech_final: true });
    event({ text: "没有说出的词表", start: 1.5, duration: 1, is_final: true, speech_final: true });
    event({ type: "transcript.done", text: "保留这一句。没有说出的词表", start: 0, duration: 3,
      words: [{ text: "保留这一句", start: 0, end: 1 }, { text: "没有说出的词表", start: 1.5, end: 2 }] });
    expect(internal.drain().updates.mic?.stable.map((s) => s.text).join("")).toBe("保留这一句");
  });

  it("does not finish until the last voiced audio is finalized, then avoids waiting for a silent channel/done", async () => {
    const { client, event, send } = await setup();
    await client.feed({ mic: voice(1000) });
    event({ text: "不能遗漏", start: 0, duration: 0.5, is_final: true, speech_final: true });
    let finished = false;
    const result = client.finish().then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    expect(send.mock.calls.slice(-2).map((call) => JSON.parse(call[0] as string).type)).toEqual(["Finalize", "audio.done"]);
    event({ text: "不能遗漏最后一个字", start: 0, duration: 1, is_final: true, speech_final: true });
    expect((await result).updates.mic?.stable[0]?.text).toBe("不能遗漏最后一个字");
    expect(finished).toBe(true);
  });

  it("does not mistake a chunk final for a completed utterance", async () => {
    const { client, event } = await setup();
    await client.feed({ mic: voice(1000) });
    event({ text: "三个项目", start: 0, duration: 1, is_final: true, speech_final: false });
    let finished = false;
    const result = client.finish().then((value) => { finished = true; return value; });
    await Promise.resolve();
    expect(finished).toBe(false);
    event({ type: "transcript.done", text: "四个项目", start: 0, duration: 1 });
    expect((await result).updates.mic?.stable[0]?.text).toBe("四个项目");
  });

  it("retains quiet voice while rejecting digital silence and very low background energy", () => {
    const evidence = new AudioEvidence();
    evidence.append(Buffer.alloc(32_000));
    evidence.append(voice(1000, 20));
    expect(evidence.overlaps()).toBe(false);
    evidence.append(voice(1000, 240));
    expect(evidence.overlaps(2100, 2900)).toBe(true);
    expect(evidence.overlaps(200, 800)).toBe(false);
  });
});
