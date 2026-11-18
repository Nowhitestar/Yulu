import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultYuluConfig } from "../../src/config.js";
import { defFor } from "../../src/settingsRegistry.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import { DictationSettings, type DictationTextStatus } from "../../web/src/components/settings/DictationSettings.js";
import { FAST_DICTATION_MODEL } from "../../src/dictationPreferences.js";

afterEach(() => localStorage.clear());
/** The Host's answer when xAI cleanup is selected, disclosed, connected and running. */
function activeText(overrides: Partial<DictationTextStatus> = {}): DictationTextStatus {
  return {
    provider: "xai",
    model: "grok-4.6",
    audioEngine: "xai",
    credentialSource: "oauth",
    disclosure: { accepted: true, disclosureVersion: "xai-dictation-text-v1" },
    active: true,
    ...overrides,
  };
}
/** Pass `null` for the moment before the Host has answered. */
function setup(disabled = false, text: DictationTextStatus | null = activeText()) {
  localStorage.setItem("yulu_ui.lang", "zh");
  const preferences = { ...defaultYuluConfig().transcription.dictation, target_language: "Japanese", cleanup_enabled: !disabled };
  const commit = vi.fn();
  const acceptDisclosure = vi.fn();
  render(<LanguageProvider>
    <DictationSettings preferences={preferences} text={text ?? undefined} onCommit={commit} onAcceptDisclosure={acceptDisclosure} />
  </LanguageProvider>);
  return { commit, acceptDisclosure, preferences };
}
describe("dictation preferences", () => {
  it("shows the agreed medium and casual defaults, with independent choices", async () => {
    const { commit } = setup();
    expect(screen.getByRole("radio", { name: /^中度/ })).toBeChecked();
    expect(screen.getByRole("radio", { name: /^日常/ })).toBeChecked();
    await userEvent.setup().click(screen.getByRole("radio", { name: /^随意/ }));
    expect(commit).toHaveBeenCalledWith("transcription.dictation.style", "very_casual");
  });
  it("shows an existing opt-out and enables cleanup atomically without losing other preferences", async () => {
    const { commit, preferences } = setup(true);
    expect(screen.getByRole("switch", { name: "自动整理" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: /^重度/ })).toBeDisabled();
    await userEvent.setup().click(screen.getByRole("switch", { name: "自动整理" }));
    expect(commit).toHaveBeenCalledWith("transcription.dictation", { ...preferences, cleanup_enabled: true, cleanup_level: "medium" });
  });
  it("changes only the cleanup model when fast dictation is selected", async () => {
    const { commit } = setup();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "整理模型" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "整理模型" }), FAST_DICTATION_MODEL);
    expect(commit).toHaveBeenCalledExactlyOnceWith("transcription.dictation.text_model", FAST_DICTATION_MODEL);
  });
  it("keeps a model carried over from an earlier selection selectable instead of replacing it", async () => {
    setup(false, activeText({ model: "grok-custom-pinned" }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "整理模型" }));
    const options = screen.getAllByRole("option").map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual([FAST_DICTATION_MODEL, "grok-4.6", "grok-custom-pinned"]);
    expect(screen.getByRole("combobox", { name: "整理模型" })).toHaveValue("grok-custom-pinned");
  });
  it("shows the dictation disclosure before turning xAI cleanup on and sends nothing until it is accepted", async () => {
    const { commit, acceptDisclosure } = setup(false, activeText({
      provider: "none", active: false, disclosure: { accepted: false, disclosureVersion: "xai-dictation-text-v1" },
    }));
    const user = userEvent.setup();
    expect(screen.getByText(/不会发送到任何地方/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "使用 xAI 整理文字" }));
    const disclosure = screen.getByRole("group", { name: /听写文字数据路径说明 · xai-dictation-text-v1/ });
    expect(disclosure).toHaveTextContent("你听写的文字会直接发送给 xAI");
    expect(commit).not.toHaveBeenCalled();
    expect(acceptDisclosure).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "暂不开启" }));
    expect(screen.queryByRole("group", { name: /听写文字数据路径说明/ })).not.toBeInTheDocument();
    expect(commit).not.toHaveBeenCalled();
    expect(acceptDisclosure).not.toHaveBeenCalled();

    await user.click(screen.getByRole("switch", { name: "使用 xAI 整理文字" }));
    await user.click(screen.getByRole("button", { name: "确认并开启" }));
    expect(acceptDisclosure).toHaveBeenCalledOnce();
    expect(commit).toHaveBeenCalledExactlyOnceWith("transcription.dictation.text_provider", "xai");
    expect(acceptDisclosure.mock.invocationCallOrder[0]!).toBeLessThan(commit.mock.invocationCallOrder[0]!);
  });
  it("does not select xAI cleanup when recording the disclosure fails", async () => {
    const { commit, acceptDisclosure } = setup(false, activeText({
      provider: "none", active: false, disclosure: { accepted: false, disclosureVersion: "xai-dictation-text-v1" },
    }));
    acceptDisclosure.mockRejectedValue(new Error("Host unavailable"));
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "使用 xAI 整理文字" }));
    await user.click(screen.getByRole("button", { name: "确认并开启" }));
    expect(commit).not.toHaveBeenCalled();
    expect(screen.getByRole("group", { name: /听写文字数据路径说明/ })).toBeInTheDocument();
  });
  it("turns xAI cleanup on directly once the disclosure is accepted, and off without asking", async () => {
    const off = setup(false, activeText({ provider: "none", active: false }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: "使用 xAI 整理文字" }));
    expect(off.acceptDisclosure).not.toHaveBeenCalled();
    expect(off.commit).toHaveBeenCalledExactlyOnceWith("transcription.dictation.text_provider", "xai");
  });
  it("turns xAI cleanup off without asking", async () => {
    const { commit } = setup();
    expect(screen.getByRole("switch", { name: "使用 xAI 整理文字" })).toBeChecked();
    await userEvent.setup().click(screen.getByRole("switch", { name: "使用 xAI 整理文字" }));
    expect(commit).toHaveBeenCalledExactlyOnceWith("transcription.dictation.text_provider", "none");
  });
  it.each([
    ["local audio", activeText({ audioEngine: "local", active: false }), /仅在使用 xAI 转写引擎时运行/],
    ["a missing xAI connection", activeText({ credentialSource: null, active: false }), /连接 xAI/],
    ["an unaccepted disclosure", activeText({
      active: false, disclosure: { accepted: false, disclosureVersion: "xai-dictation-text-v1" },
    }), /请先确认听写文字如何发送给 xAI/],
  ])("explains that selected cleanup is not running because of %s", (_name, text, note) => {
    setup(false, text);
    expect(screen.getByText(note)).toBeInTheDocument();
  });
  it("shows no unavailable note while cleanup is running and assumes nothing before the Host answers", () => {
    setup();
    expect(document.querySelector(".dictation-settings-note")).toBeNull();
    localStorage.clear();
    document.body.innerHTML = "";
    setup(false, null);
    expect(screen.getByRole("switch", { name: "使用 xAI 整理文字" })).not.toBeChecked();
  });
  it("writes an explicit opt-out when cleanup is turned off", async () => {
    const { commit } = setup();
    await userEvent.setup().click(screen.getByRole("switch", { name: "自动整理" }));
    expect(commit).toHaveBeenCalledWith("transcription.dictation", expect.objectContaining({ cleanup_enabled: false, cleanup_level: "medium" }));
  });
  it("selects structured heavy cleanup independently of style and translation", async () => {
    const { commit, preferences } = setup();
    expect(screen.queryByRole("radio", { name: /^关闭/ })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("radio", { name: /^重度/ }));
    expect(commit).toHaveBeenCalledWith("transcription.dictation", { ...preferences, cleanup_level: "heavy" });
  });
  it("restores legacy none preferences through the independent switch", async () => {
    localStorage.setItem("yulu_ui.lang", "zh");
    const commit = vi.fn();
    const preferences = { ...defaultYuluConfig().transcription.dictation, cleanup_level: "none" as const, prompt_slug: "none" };
    render(<LanguageProvider>
      <DictationSettings preferences={preferences} text={activeText()} onCommit={commit} onAcceptDisclosure={vi.fn()} />
    </LanguageProvider>);
    expect(screen.getByRole("switch", { name: "自动整理" })).not.toBeChecked();
    await userEvent.setup().click(screen.getByRole("switch", { name: "自动整理" }));
    expect(commit).toHaveBeenCalledWith("transcription.dictation", expect.objectContaining({ cleanup_enabled: true, cleanup_level: "medium", prompt_slug: "dictation-cleanup" }));
  });
  it("blocks overlapping saves and restores the controls after a failed save", async () => {
    const { commit } = setup();
    let rejectSave!: (error: Error) => void;
    commit.mockImplementation(() => new Promise((_, reject) => { rejectSave = reject; }));
    const user = userEvent.setup();
    await user.click(screen.getByRole("radio", { name: /^轻度/ }));
    expect(screen.getByRole("radio", { name: /^随意/ })).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /^随意/ }));
    expect(commit).toHaveBeenCalledTimes(1);
    await act(async () => rejectSave(new Error("Save failed")));
    expect(screen.getByRole("radio", { name: /^随意/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /^中度/ })).toBeChecked();
  });
  it("rejects unknown styles and cleanup levels at the settings boundary", () => {
    const schema = defFor("transcription.dictation")!.validate;
    expect(schema.safeParse({ style: "invented" }).success).toBe(false);
    expect(schema.safeParse({ cleanup_level: "rewrite_everything" }).success).toBe(false);
    expect(schema.safeParse({ cleanup_level: "heavy" }).success).toBe(true);
    expect(schema.safeParse({ text_model: FAST_DICTATION_MODEL }).success).toBe(true);
    expect(schema.safeParse({ text_model: "" }).success).toBe(false);
    expect(schema.safeParse({ text_provider: "xai" }).success).toBe(true);
    expect(schema.safeParse({ text_provider: "codex" }).success).toBe(false);
  });
});
