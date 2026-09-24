import { describe, expect, it } from "vitest";
import { DEFAULT_HOTKEYS, HotkeySchema, HotkeysSchema, formatHotkey } from "../src/hotkeys.js";
import { ConfigSchema } from "../src/config.js";

describe("voice shortcuts", () => {
  it("defaults to Fn, Fn+Shift and Fn+Space and preserves existing shortcuts", () => {
    const defaults = ConfigSchema.parse({}).status_agent.hotkeys;
    expect(defaults.dictate).toEqual(DEFAULT_HOTKEYS.dictate);
    expect(defaults.translate).toMatchObject(DEFAULT_HOTKEYS.translate);
    expect(defaults.voice_chat).toEqual(DEFAULT_HOTKEYS.voice_chat);
    const custom = { key: "V", modifiers: ["left_cmd"] };
    expect(ConfigSchema.parse({ status_agent: { hotkeys: { dictate: custom } } }).status_agent.hotkeys.dictate).toEqual(custom);
  });
  it.each(["LeftCommand", "RightCommand", "LeftShift", "RightShift", "LeftControl", "RightControl", "LeftOption", "RightOption", "Fn", "Command"])("accepts %s alone", (key) => {
    expect(HotkeySchema.parse({ key, modifiers: [] })).toEqual({ key, modifiers: [] });
  });
  it("rejects ambiguous bindings including generic versus sided modifiers", () => {
    expect(HotkeysSchema.safeParse({ ...DEFAULT_HOTKEYS, dictate: { key: "Fn", modifiers: ["left_shift"] } }).success).toBe(false);
    expect(ConfigSchema.safeParse({ status_agent: { hotkeys: { dictate: { key: "Fn", modifiers: ["left_shift"] } } } }).success).toBe(false);
    expect(HotkeysSchema.safeParse({ dictate: { key: "LeftCommand", modifiers: [] }, translate: { key: "RightCommand", modifiers: [] } }).success).toBe(true);
    expect(HotkeySchema.safeParse({ key: "Fn", modifiers: ["fn"] }).success).toBe(false);
    expect(HotkeySchema.safeParse({ key: "A", modifiers: ["cmd", "left_cmd"] }).success).toBe(false);
    expect(HotkeySchema.safeParse({ key: "NoSuchKey", modifiers: [] }).success).toBe(false);
  });
  it("formats side and Fn labels in both languages", () => {
    expect(formatHotkey({ key: "Space", modifiers: ["fn", "right_shift"] })).toBe("Fn + 右 ⇧ + Space");
    expect(formatHotkey({ key: "LeftCommand", modifiers: [] }, true)).toBe("Left ⌘");
  });
});
