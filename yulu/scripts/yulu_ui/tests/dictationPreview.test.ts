import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationPreview, dictationSegments, normalizeDictationText, speculativeDictationText } from "../src/dictationPreview.js";
import { DictationTextService } from "../src/dictationText.js";
import { defaultYuluConfig } from "../src/config.js";
import { buildGlossaryContract } from "../src/glossaryContract.js";
import type { XaiTextRequest, XaiTextResult } from "../src/xaiText.js";

const raw = "嗯，明天下午三点，不对，四点讨论这个方案。";
const edited = "明天下午四点讨论这个方案。";
const previews: DictationPreview[] = [];
afterEach(() => { previews.splice(0).forEach((preview) => preview.close()); vi.useRealTimers(); });

function setup() {
  let clock = 0;
  const config = defaultYuluConfig();
  config.transcription.engine = "xai";
  config.intelligence.conversation = { provider: "xai", model: "chosen" };
  const request = vi.fn(async (_request: XaiTextRequest): Promise<XaiTextResult> => ({ text: edited, model: "chosen", credentialSource: "oauth" }));
  const disclosure = vi.fn(() => true);
  const glossary = vi.fn(() => buildGlossaryContract([]));
  const service = new DictationTextService({ config: { read: () => config }, text: { request },
    credentialSource: () => "oauth", hasDisclosure: disclosure, glossary });
  const preview = new DictationPreview(service, () => clock);
  previews.push(preview);
  const observe = (text = raw, partialText = "", quietMs = 700) => preview.observe("session", { text, partialText, quietMs });
  const clean = (text = raw, sessionId = "session") => preview.clean({ text, sessionId, context: "", timeoutMs: 20_000 });
  preview.start("session");
  return { config, request, disclosure, glossary, preview, observe, clean, advance: (ms: number) => { clock += ms; } };
}

describe("pause-time dictation cleanup", () => {
  it("joins cumulative partials without the old 160-character overlap limit", () => {
    const sentence = "这一段尚未结束，需要继续保留它的全部内容".repeat(25);
    expect(speculativeDictationText("前一段。\n" + sentence, sentence + "，还有最后一句。"))
      .toBe("前一段。\n" + sentence + "，还有最后一句。");
    expect(speculativeDictationText("", sentence)).toBe(sentence);
    expect(speculativeDictationText(sentence, "")).toBe(sentence);
  });

  it("can prepare continuous Chinese speech when ASR only emits commas before a new request", () => {
    const prefix = "我们希望把活动安排解释清楚，让第一次参加的人也能理解相关背景和限制，".repeat(8);
    const source = prefix + "请说明接下来应该怎么准备，以及怎么收集反馈";
    const pieces = dictationSegments(source);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join("")).toBe(source);
  });
  it("stops remaining paragraph requests if the user cancels while final editing is pending", async () => {
    const { preview, observe, clean, request } = setup();
    const prefix = dictationSegments("活动的安排需要兼顾不同参与者的时间和兴趣，大家都可以提出自己的建议。".repeat(10))[0]!;
    let resolve!: (result: XaiTextResult) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    const final = prefix + "最后请告诉我具体怎么报名。";
    observe(final, "继续", 0);
    preview.finish("session", final, true);
    const result = clean(final);
    const rejected = expect(result).rejects.toThrow("cancelled");
    preview.cancel("session");
    resolve({ text: prefix, model: "chosen", credentialSource: "oauth" });
    await rejected;
    expect(request).toHaveBeenCalledOnce();
  });
  it("retains finished paragraphs while speech continues and edits only the new tail at stop", async () => {
    const { preview, observe, clean, request, advance } = setup();
    const paragraph = "我们希望保留所有背景和限制，同时让结果更容易阅读。".repeat(11);
    const prefix = dictationSegments(paragraph)[0]!;
    const first = prefix + "接下来讨论第二件事";
    request.mockImplementation(async (input) => ({ text: JSON.parse(input.input.at(-1)!.content).dictation, model: "chosen", credentialSource: "oauth" }));
    observe(first, "还在继续说话", 0);
    await Promise.resolve(); await Promise.resolve();
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(request.mock.calls[0]![0].input[1]!.content).dictation).toBe(prefix);
    const prefixSignal = request.mock.calls[0]![0].signal!;
    advance(5_000);
    const final = prefix + "接下来讨论第二件事。需要哪些准备，以及怎么评估？";
    observe(final, "", 700);
    expect(prefixSignal.aborted).toBe(false);
    preview.finish("session", final, true);
    const result = await clean(final);
    expect(result.cleanupSource).toBe("incremental");
    expect(result.text).toContain(prefix);
    expect(result.text).toContain("怎么评估");
    expect(request).toHaveBeenCalledTimes(2);
    const second = JSON.parse(request.mock.calls[1]![0].input.at(-1)!.content);
    expect(second.dictation).not.toContain(prefix);
    expect(request.mock.calls[1]![0].input[1]).toEqual({ role: "assistant", content: prefix });
  });

  it("revisits prior paragraphs for later corrections instead of pasting a stale prefix", async () => {
    const { preview, observe, clean, request } = setup();
    const prefix = dictationSegments("这个会议暂定在星期一，我们需要先确认所有参会人的时间。".repeat(11))[0]!;
    request.mockImplementation(async (input) => ({ text: JSON.parse(input.input.at(-1)!.content).dictation, model: "chosen", credentialSource: "oauth" }));
    observe(prefix + "接下来", "继续", 0);
    const final = prefix + "等等，前面说错了，把会议改到星期五。";
    preview.finish("session", final, true);
    await clean(final);
    expect(request.mock.calls[0]![0].signal!.aborted).toBe(true);
    expect(JSON.parse(request.mock.lastCall![0].input[1]!.content).dictation).toBe(final);
  });
  it("reuses completed whole-text editing after trusted finalization without another model call", async () => {
    const { preview, observe, clean, request, advance } = setup();
    observe();
    advance(1_500);
    await vi.waitFor(() => expect(request.mock.results[0]?.type).toBe("return"));
    await Promise.resolve();
    preview.finish("session", raw, true);
    advance(1_000);
    await expect(clean()).resolves.toMatchObject({ text: edited, cleanupSource: "preview", previewSavedMs: 1_500 });
    expect(request).toHaveBeenCalledOnce();
  });

  it("joins an identical in-flight request, preserving the last correction and full original input", async () => {
    const { preview, observe, clean, request } = setup();
    let resolve!: (result: XaiTextResult) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    observe();
    preview.finish("session", raw, true);
    const result = clean();
    expect(request).toHaveBeenCalledOnce();
    expect(JSON.parse(request.mock.calls[0]![0].input[1]!.content)).toEqual({ dictation: raw });
    resolve({ text: edited, model: "chosen", credentialSource: "oauth" });
    await expect(result).resolves.toMatchObject({ text: edited, cleanupSource: "preview" });
  });

  it.each(["last correction", "final punctuation"])("re-edits the full final transcript after a %s", async (kind) => {
    const { preview, observe, clean, request } = setup();
    observe();
    const final = kind === "last correction" ? `${raw}等等，改到后天。` : raw.replace("。", "！");
    preview.finish("session", final, true);
    await expect(clean(final)).resolves.toMatchObject({ cleanupSource: "final" });
    expect(request).toHaveBeenCalledTimes(2);
    expect(JSON.parse(request.mock.lastCall![0].input[1]!.content)).toEqual({ dictation: final });
  });

  it("aborts superseded work and ignores its late result", async () => {
    const { preview, observe, clean, request, advance } = setup();
    let resolve!: (result: XaiTextResult) => void;
    request.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    observe();
    const signal = request.mock.calls[0]![0].signal!;
    const final = `${raw}不过也可以线上讨论。`;
    advance(5_000);
    observe(final);
    expect(signal.aborted).toBe(true);
    resolve({ text: "这个旧结果不应该被使用", model: "chosen", credentialSource: "oauth" });
    preview.finish("session", final, true);
    await expect(clean(final)).resolves.toMatchObject({ text: edited, cleanupSource: "preview" });
  });

  it.each(["model", "style", "level", "glossary", "disabled", "disclosure"])("invalidates the preview after %s changes", async (change) => {
    const { preview, observe, clean, request, config, glossary, disclosure } = setup();
    observe();
    if (change === "model") config.transcription.dictation.cleanup_model = "grok-4.20-0309-non-reasoning";
    if (change === "style") config.transcription.dictation.style = "formal";
    if (change === "level") config.transcription.dictation.cleanup_level = "heavy";
    if (change === "glossary") glossary.mockReturnValue(buildGlossaryContract([{ term: "方案", canonical: "提案", scope: "both" }]));
    if (change === "disabled") config.transcription.dictation.cleanup_enabled = false;
    if (change === "disclosure") disclosure.mockReturnValue(false);
    preview.finish("session", raw, true);
    const result = await clean();
    expect(result.cleanupSource).toBe("final");
    if (change === "disabled" || change === "disclosure") {
      expect(result.text).toBe(raw);
      expect(request).toHaveBeenCalledOnce();
    } else expect(request).toHaveBeenCalledTimes(2);
  });

  it("waits for microphone silence and stable text, bounds calls, and never replays unchanged input", async () => {
    const { observe, request, advance } = setup();
    observe(raw, "仍在说话");
    observe(raw, "", 100);
    expect(request).not.toHaveBeenCalled();
    observe();
    observe();
    expect(request).toHaveBeenCalledOnce();
    observe(`${raw}第二点。`);
    expect(request).toHaveBeenCalledOnce();
    advance(5_000);
    observe(`${raw}第二点。`);
    expect(request).toHaveBeenCalledTimes(2);
    for (let index = 0; index < 80; index++) { advance(5_000); observe(`${raw}补充第${index}点。`); }
    expect(request).toHaveBeenCalledTimes(64);
  });

  it.each(["cancel", "untrusted", "new_session", "wrong_session", "expired"])("does not reuse speech after %s", async (reason) => {
    vi.useFakeTimers();
    const { preview, observe, clean } = setup();
    observe();
    preview.finish("session", raw, reason !== "untrusted");
    if (reason === "cancel") preview.cancel("session");
    if (reason === "new_session") preview.start("other");
    if (reason === "expired") await vi.advanceTimersByTimeAsync(60_000);
    await expect(clean(raw, reason === "wrong_session" ? "other" : "session")).resolves.toMatchObject({ cleanupSource: "final" });
  });

  it("never speculates for local, disabled, or unapproved connections", () => {
    const { observe, request, config, disclosure } = setup();
    config.transcription.engine = "local";
    observe();
    config.transcription.engine = "xai";
    config.transcription.dictation.cleanup_enabled = false;
    observe();
    config.transcription.dictation.cleanup_enabled = true;
    disclosure.mockReturnValue(false);
    observe();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a failed identical preview as the original without a duplicate provider retry", async () => {
    const { preview, observe, clean, request } = setup();
    request.mockRejectedValueOnce(new DOMException("Deadline", "TimeoutError"));
    observe();
    preview.finish("session", raw, true);
    await expect(clean()).resolves.toMatchObject({ text: raw, reason: "request_timeout", cleanupSource: "preview" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("normalizes capture spacing while preserving paragraph, punctuation and code differences", () => {
    expect(normalizeDictationText("  明 天 ， 见 。\r\n\r\n\r\n run  --dry-run ")).toBe("明天，见。\n\nrun --dry-run");
    expect(normalizeDictationText("三点。\n不对，四点。" )).not.toBe(normalizeDictationText("三点。不对，四点。"));
  });
});
