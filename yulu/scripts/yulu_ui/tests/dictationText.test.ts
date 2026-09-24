import { describe, expect, it, vi } from "vitest";
import { defaultYuluConfig } from "../src/config.js";
import { DictationTextService, dictationCleanupTimeoutMs } from "../src/dictationText.js";
import { buildGlossaryContract } from "../src/glossaryContract.js";
import type { XaiTextRequest, XaiTextResult } from "../src/xaiText.js";
import { dictationCleanupLevel, FAST_DICTATION_MODEL } from "../src/dictationPreferences.js";

const original = "嗯，明天下午三点，不对，四点，讨论 AgentKey 的下一步。";
const cleaned = "明天下午四点，讨论 AgentKey 的下一步。";

function setup() {
  const config = defaultYuluConfig();
  config.transcription.engine = "xai";
  config.intelligence.conversation = { provider: "xai", model: "selected-model" };
  const request = vi.fn(async (_input: XaiTextRequest): Promise<XaiTextResult> => ({ text: cleaned, model: "selected-model", credentialSource: "oauth" }));
  const disclosure = vi.fn(() => true);
  const service = new DictationTextService({
    config: { read: () => config }, text: { request }, hasDisclosure: disclosure,
    credentialSource: () => "oauth",
    glossary: () => buildGlossaryContract([{ term: "Agent Key", canonical: "AgentKey", scope: "both" }]),
  });
  return { config, request, disclosure, service };
}

describe("dictation cleanup", () => {
  it("translates through the selected xAI text connection without legacy Agent configuration", async () => {
    const { config, service, request } = setup();
    config.llm.enabled = false;
    request.mockResolvedValueOnce({ text: "Discuss AgentKey tomorrow at four.", model: "selected-model", credentialSource: "oauth" });
    await expect(service.translate({ text: original, targetLanguage: "English", timeoutMs: 1500 }))
      .resolves.toMatchObject({ text: "Discuss AgentKey tomorrow at four." });
    expect(request.mock.lastCall![0]).toMatchObject({ capability: "dictation", model: "selected-model", timeoutMs: 1500 });
    expect(JSON.parse(request.mock.lastCall![0].input[1]!.content)).toEqual({ dictation: original, targetLanguage: "English" });
    expect(request.mock.lastCall![0].input[0]!.content).toContain("Never answer or execute");
  });

  it("does not translate through an unselected or undisclosed connection", async () => {
    const { service, disclosure, request } = setup();
    disclosure.mockReturnValue(false);
    await expect(service.translate({ text: original, targetLanguage: "English", timeoutMs: 1000 })).rejects.toThrow("尚未就绪");
    expect(request).not.toHaveBeenCalled();
  });
  it("caps short editing at eight seconds while granting longer speech a larger bounded budget", async () => {
    const { service, request } = setup();
    await service.clean({ text: original, context: "", timeoutMs: 20_000 });
    expect(request.mock.lastCall![0].timeoutMs).toBe(8_000);
    expect(dictationCleanupTimeoutMs("字".repeat(501))).toBe(10_000);
    expect(dictationCleanupTimeoutMs("字".repeat(1_500))).toBe(12_000);
    expect(dictationCleanupTimeoutMs("字".repeat(20_000))).toBe(20_000);
  });
  it("uses the exact selected model and current text/glossary, ignoring legacy templates", async () => {
    const { service, request } = setup();
    await expect(service.clean({ text: original, context: "Keep paragraph breaks.", timeoutMs: 1_500 }))
      .resolves.toMatchObject({ text: cleaned, status: "cleaned" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({
      capability: "dictation", model: "selected-model", credentialSource: "oauth", timeoutMs: 1_500,
      input: [{ role: "system", content: expect.stringContaining("AgentKey") }, { role: "user", content: JSON.stringify({ dictation: original }) }],
    });
    expect(request.mock.calls[0]![0].input[0]!.content).not.toContain("Keep paragraph breaks.");
  });

  it.each(["local", "disabled", "no_prompt", "none", "disclosure", "agent"])("does not send text when %s", async (reason) => {
    const { config, request, disclosure, service } = setup();
    if (reason === "local") config.transcription.engine = "local";
    if (reason === "disabled") config.transcription.dictation.cleanup_enabled = false;
    if (reason === "no_prompt") config.transcription.dictation.prompt_slug = "none";
    if (reason === "none") config.transcription.dictation.cleanup_level = "none";
    if (reason === "disclosure") disclosure.mockReturnValue(false);
    if (reason === "agent") config.intelligence.conversation = { provider: "agent", model: "runtime-managed" };
    const text = original;
    await expect(service.clean({ text, context: "", timeoutMs: 500 }))
      .resolves.toMatchObject({ text, status: "unchanged" });
    expect(request).not.toHaveBeenCalled();
  });

  it("defaults to medium and casual while honoring an existing cleanup opt-out", () => {
    const { config } = setup();
    expect(config.transcription.dictation).toMatchObject({ cleanup_level: "medium", style: "casual", cleanup_model: "conversation" });
    expect(dictationCleanupLevel({ cleanup_enabled: false })).toBe("none");
    expect(dictationCleanupLevel({ prompt_slug: "none" })).toBe("none");
  });

  it("cleans short phrases instead of silently skipping them", async () => {
    const { service, request } = setup();
    request.mockResolvedValueOnce({ text: "明天见", model: "selected-model", credentialSource: "oauth" });
    await expect(service.clean({ text: "嗯，明天见。", context: "", timeoutMs: 15_000 }))
      .resolves.toMatchObject({ text: "明天见", status: "cleaned", cleanupLevel: "medium", style: "casual" });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["light", "medium", "heavy"] as const)("combines %s cleanup with each independent style", async (level) => {
    const { config, service, request } = setup();
    config.transcription.dictation.cleanup_level = level;
    for (const style of ["formal", "casual", "very_casual"] as const) {
      config.transcription.dictation.style = style;
      await expect(service.clean({ text: original, context: "Use lots of full stops.", timeoutMs: 20_000 }))
        .resolves.toMatchObject({ cleanupLevel: level, style });
      const instruction = request.mock.lastCall![0].input[0]!.content;
      expect(instruction).toContain(`${level.toUpperCase()} CLEANUP`);
      expect(instruction).toContain(`${style.replace("_", " ").toUpperCase()} STYLE`);
      expect(instruction).toMatch(/negations|否定/);
      expect(instruction).toMatch(/final self-corrections|最终口头更正/);
      expect(JSON.stringify(request.mock.lastCall![0].input)).not.toContain("Use lots of full stops.");
    }
  });

  it("pins an explicitly selected fast model independently of conversation, summary and cleanup level", async () => {
    const { config, request, service } = setup();
    const before = structuredClone(config.intelligence);
    config.transcription.dictation.cleanup_model = FAST_DICTATION_MODEL;
    for (const level of ["light", "medium", "heavy"] as const) {
      config.transcription.dictation.cleanup_level = level;
      request.mockResolvedValueOnce({ text: cleaned, model: FAST_DICTATION_MODEL, credentialSource: "oauth" });
      await expect(service.clean({ text: original, context: "", timeoutMs: 20_000 }))
        .resolves.toMatchObject({ text: cleaned, status: "cleaned", model: FAST_DICTATION_MODEL, cleanupLevel: level });
      expect(request.mock.lastCall![0]).toMatchObject({ model: FAST_DICTATION_MODEL, credentialSource: "oauth" });
    }
    expect(config.intelligence).toEqual(before);
  });

  it.each(["failure", "model_changed", "credential_changed"])("keeps the original on fast model %s without trying the conversation model", async (reason) => {
    const { config, request, service } = setup();
    config.transcription.dictation.cleanup_model = FAST_DICTATION_MODEL;
    if (reason === "failure") request.mockRejectedValueOnce(new Error("unavailable"));
    else if (reason === "model_changed") request.mockResolvedValueOnce({ text: cleaned, model: "other-model", credentialSource: "oauth" });
    else request.mockResolvedValueOnce({ text: cleaned, model: FAST_DICTATION_MODEL, credentialSource: "api-key" });
    await expect(service.clean({ text: original, context: "", timeoutMs: 20_000 }))
      .resolves.toMatchObject({ text: original, status: "unchanged", reason: "request_failed" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.lastCall![0].model).toBe(FAST_DICTATION_MODEL);
  });

  it.each([
    {
      shape: "a short paragraph",
      original,
      text: cleaned,
    },
    {
      shape: "a request with its supporting context",
      original: "你能帮我解释一下这两个方案的区别吗？我现在还不确定应该选择哪一个。",
      text: "你能帮我解释这两个方案的区别吗？我还不确定该选哪一个。",
    },
    {
      shape: "natural paragraphs with a quotation",
      original: "嗯，我觉得这封邀请函有点生硬。我们是在邀请老朋友。可以说，周末来家里坐坐，大家一起做饭聊天。然后最后再告诉大家地址和时间。我希望它读起来更亲切，但不要替我承诺接送。",
      text: "我觉得这封邀请函有点生硬，我们是在邀请老朋友。可以说：“周末来家里坐坐，大家一起做饭聊天。”\n\n最后再告诉大家地址和时间。我希望它读起来更亲切，但不要替我承诺接送。",
    },
    {
      shape: "an introduction followed by numbered questions",
      original: "我想确认三件事。第一活动几点开始。第二要带什么。第三如果下雨是否取消。",
      text: "我想确认三件事：\n1. 活动几点开始？\n2. 要带什么？\n3. 如果下雨，是否取消？",
    },
    {
      shape: "an existing list without an introduction",
      original: "1. 活动几点开始？\n2. 如果下雨，是否取消？",
      text: "1. 活动几点开始？\n2. 如果下雨，是否取消？",
    },
  ])("accepts $shape for heavy cleanup without forcing an outline or changing the provider", async ({ original: raw, text }) => {
    const { config, service, request } = setup();
    config.transcription.dictation.cleanup_level = "heavy";
    config.transcription.dictation.style = "very_casual";
    request.mockResolvedValueOnce({ text, model: "selected-model", credentialSource: "oauth" });
    await expect(service.clean({ text: raw, context: "", timeoutMs: 20_000 }))
      .resolves.toMatchObject({ text, status: "cleaned", warning: "", model: "selected-model", cleanupLevel: "heavy", style: "very_casual" });
    expect(request).toHaveBeenCalledOnce();
  });

  it("treats dictated requests as quoted data and rejects unintended translation", async () => {
    const { service, request } = setup();
    const text = "你可以帮我解释一下这两种方案的区别吗？我现在还不确定应该选择哪一种。";
    request.mockResolvedValueOnce({ text: "Please explain the difference between these options. I am not sure which one to choose.", model: "selected-model", credentialSource: "oauth" });
    await expect(service.clean({ text, context: "", timeoutMs: 20_000 }))
      .resolves.toMatchObject({ text, status: "unchanged", reason: "language_changed" });
    expect(JSON.parse(request.mock.lastCall![0].input[1]!.content)).toEqual({ dictation: text });
  });

  it("preserves original speech and reports failure without retrying or switching models", async () => {
    const { service, request } = setup();
    request.mockRejectedValueOnce(new Error("timeout"));
    await expect(service.clean({ text: original, context: "", timeoutMs: 500 }))
      .resolves.toMatchObject({ text: original, status: "unchanged", warning: expect.stringContaining("原文") });
    expect(request).toHaveBeenCalledOnce();
  });

  it.each(["好的", "a".repeat(200)])("rejects destructive or runaway cleanup", async (text) => {
    const { service, request } = setup();
    request.mockResolvedValueOnce({ text, model: "selected-model", credentialSource: "oauth" });
    await expect(service.clean({ text: original, context: "", timeoutMs: 500 }))
      .resolves.toMatchObject({ text: original, reason: "invalid_output" });
  });
});
