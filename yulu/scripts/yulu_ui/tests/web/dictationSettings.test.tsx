import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { defaultYuluConfig } from "../../src/config.js";
import { defFor } from "../../src/settingsRegistry.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import { DictationSettings } from "../../web/src/components/settings/DictationSettings.js";
import { FAST_DICTATION_MODEL } from "../../src/dictationPreferences.js";

afterEach(() => localStorage.clear());
function setup(disabled = false) {
  localStorage.setItem("yulu_ui.lang", "zh");
  const preferences = { ...defaultYuluConfig().transcription.dictation, target_language: "Japanese", cleanup_enabled: !disabled };
  const commit = vi.fn();
  render(<LanguageProvider><DictationSettings preferences={preferences} available onCommit={commit} /></LanguageProvider>);
  return { commit, preferences };
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
    expect(commit).toHaveBeenCalledExactlyOnceWith("transcription.dictation.cleanup_model", FAST_DICTATION_MODEL);
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
    render(<LanguageProvider><DictationSettings preferences={preferences} available onCommit={commit} /></LanguageProvider>);
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
    expect(schema.safeParse({ cleanup_model: FAST_DICTATION_MODEL }).success).toBe(true);
    expect(schema.safeParse({ cleanup_model: "unknown-fast-model" }).success).toBe(false);
  });
});
