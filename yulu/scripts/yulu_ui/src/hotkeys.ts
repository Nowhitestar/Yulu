import { z } from "zod";

export const MODIFIERS = ["fn", "cmd", "left_cmd", "right_cmd", "shift", "left_shift", "right_shift", "alt", "left_alt", "right_alt", "ctrl", "left_ctrl", "right_ctrl"] as const;
export const MODIFIER_KEYS: Record<string, typeof MODIFIERS[number]> = {
  Fn: "fn", Command: "cmd", LeftCommand: "left_cmd", RightCommand: "right_cmd",
  Shift: "shift", LeftShift: "left_shift", RightShift: "right_shift",
  Option: "alt", LeftOption: "left_alt", RightOption: "right_alt",
  Control: "ctrl", LeftControl: "left_ctrl", RightControl: "right_ctrl",
};
export const HOTKEY_KEYS = ["Fn", "Command", "LeftCommand", "RightCommand", "Shift", "LeftShift", "RightShift", "Option", "LeftOption", "RightOption", "Control", "LeftControl", "RightControl", "Space", "Tab", "Return", "Escape", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789", ...Array.from({ length: 20 }, (_, i) => `F${i + 1}`)];
export interface HotkeyValue { key: string; modifiers: string[] }
export const DEFAULT_HOTKEYS = {
  dictate: { key: "Fn", modifiers: [] },
  translate: { key: "Fn", modifiers: ["shift"] },
  voice_chat: { key: "Space", modifiers: ["fn"] },
} satisfies Record<string, { key: string; modifiers: typeof MODIFIERS[number][] }>;

const group = (modifier: string) => modifier.split("_").at(-1)!;
const tokens = (spec: HotkeyValue) => [...spec.modifiers, ...(MODIFIER_KEYS[spec.key] ? [MODIFIER_KEYS[spec.key]!] : [])];
export const HotkeySchema = z.object({
  key: z.string().refine((key) => HOTKEY_KEYS.includes(key), "Unsupported shortcut key"),
  modifiers: z.array(z.enum(MODIFIERS)).default([]),
  target_language: z.string().optional(),
}).passthrough().refine((spec) => {
  const all = tokens(spec);
  return new Set(all).size === all.length && all.every((token) =>
    token === group(token) || !all.includes(group(token)));
}, "Do not combine a modifier with itself or its any-side variant");

export function hotkeysOverlap(a: HotkeyValue, b: HotkeyValue) {
  if (Boolean(MODIFIER_KEYS[a.key]) !== Boolean(MODIFIER_KEYS[b.key])) return false;
  if (!MODIFIER_KEYS[a.key] && a.key !== b.key) return false;
  const left = tokens(a), right = tokens(b);
  const groups = [...new Set(left.map(group))].sort();
  if (groups.join() !== [...new Set(right.map(group))].sort().join()) return false;
  return groups.every((item) => left.includes(item) || right.includes(item) ||
    left.filter((token) => group(token) === item).sort().join() === right.filter((token) => group(token) === item).sort().join());
}

export function validateHotkeyConflicts(hotkeys: Record<string, HotkeyValue>, ctx: z.RefinementCtx) {
  const actions = ["dictate", "translate", "voice_chat"];
  for (let i = 0; i < actions.length; i++) for (let j = i + 1; j < actions.length; j++) {
    const a = hotkeys[actions[i]!], b = hotkeys[actions[j]!];
    if (a && b && hotkeysOverlap(a, b)) ctx.addIssue({ code: "custom", message: "Voice shortcuts must be different", path: [actions[j]!] });
  }
}
export const HotkeysSchema = z.record(HotkeySchema).superRefine(validateHotkeyConflicts);

export function formatHotkey(spec: HotkeyValue, english = false) {
  const symbols: Record<string, string> = { fn: "Fn", cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
  const label = (token: string) => {
    const side = token.startsWith("left_") ? (english ? "Left " : "左 ") : token.startsWith("right_") ? (english ? "Right " : "右 ") : "";
    return side + (symbols[group(token)] ?? token);
  };
  const modifiers = MODIFIERS.filter((token) => spec.modifiers.includes(token));
  if (spec.key === "Fn") return ["Fn", ...modifiers.map(label)].join(" + ");
  return [...modifiers.map(label), MODIFIER_KEYS[spec.key] ? label(MODIFIER_KEYS[spec.key]!) : spec.key].join(" + ");
}
