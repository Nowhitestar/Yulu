import { describe, expect, it, vi } from "vitest";
import { defaultYuluConfig } from "../src/config.js";
import { DictationTextService } from "../src/dictationText.js";
import { buildGlossaryContract } from "../src/glossaryContract.js";
import type { XaiTextRequest } from "../src/xaiText.js";

const original = "嗯，明天下午三点，不对，四点，讨论 AgentKey 的下一步。";
const cleaned = "明天下午四点，讨论 AgentKey 的下一步。";

function setup() {
  const config = defaultYuluConfig();
  config.transcription.engine = "xai";
  config.intelligence.conversation = { provider: "xai", model: "selected-model" };
  const request = vi.fn(async (_input: XaiTextRequest) => ({ text: cleaned, model: "selected-model", credentialSource: "oauth" as const }));
  const disclosure = vi.fn(() => true);
  const service = new DictationTextService({
    config: { read: () => config }, text: { request }, hasDisclosure: disclosure,
    credentialSource: () => "oauth",
    glossary: () => buildGlossaryContract([{ term: "Agent Key", canonical: "AgentKey", scope: "both" }]),
  });
  return { config, request, disclosure, service };
}

describe("dictation cleanup", () => {
  it("uses the exact selected model and only the current text, template and glossary", async () => {
    const { service, request } = setup();
    await expect(service.clean({ text: original, context: "Keep paragraph breaks.", timeoutMs: 1_500 }))
      .resolves.toMatchObject({ text: cleaned, status: "cleaned" });
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toMatchObject({
      capability: "dictation", model: "selected-model", credentialSource: "oauth", timeoutMs: 1_500,
      input: [{ role: "system", content: expect.stringContaining("AgentKey") }, { role: "user", content: original }],
    });
  });

  it.each(["local", "disabled", "no_prompt", "short", "disclosure", "agent"])("does not send text when %s", async (reason) => {
    const { config, request, disclosure, service } = setup();
    if (reason === "local") config.transcription.engine = "local";
    if (reason === "disabled") config.transcription.dictation.cleanup_enabled = false;
    if (reason === "no_prompt") config.transcription.dictation.prompt_slug = "none";
    if (reason === "disclosure") disclosure.mockReturnValue(false);
    if (reason === "agent") config.intelligence.conversation = { provider: "agent", model: "runtime-managed" };
    const text = reason === "short" ? "明天见" : original;
    await expect(service.clean({ text, context: "", timeoutMs: 500 }))
      .resolves.toMatchObject({ text, status: "unchanged" });
    expect(request).not.toHaveBeenCalled();
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
