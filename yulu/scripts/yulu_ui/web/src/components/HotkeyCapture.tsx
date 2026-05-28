import { useEffect, useRef, useState } from "react";
import "./HotkeyCapture.css";

export type ModifierKey = "cmd" | "shift" | "alt" | "ctrl";
export interface HotkeyValue { key: string; modifiers: ModifierKey[]; }

export interface HotkeyCaptureProps {
  value: HotkeyValue;
  onCommit: (v: HotkeyValue) => void;
}

const GLYPHS: Record<ModifierKey, string> = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const ORDER: ModifierKey[] = ["cmd", "ctrl", "shift", "alt"];

export function formatHotkey(v: HotkeyValue): string {
  const mods = ORDER.filter((m) => v.modifiers.includes(m)).map((m) => GLYPHS[m]).join("");
  return `${mods}${v.key}`;
}

export function HotkeyCapture({ value, onCommit }: HotkeyCaptureProps) {
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<HotkeyValue | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (capturing) captureRef.current?.focus(); }, [capturing]);

  const cancel = () => { setCapturing(false); setCaptured(null); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { cancel(); return; }
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;   // ignore modifier-only press
    const mods: ModifierKey[] = [];
    if (e.metaKey) mods.push("cmd");
    if (e.shiftKey) mods.push("shift");
    if (e.altKey) mods.push("alt");
    if (e.ctrlKey) mods.push("ctrl");
    setCaptured({ key: e.key.length === 1 ? e.key.toUpperCase() : e.key, modifiers: mods });
    e.preventDefault();
  };

  if (!capturing) {
    return (
      <div className="hotkey-display" onClick={() => setCapturing(true)}>
        {formatHotkey(value)}
      </div>
    );
  }
  return (
    <div className="hotkey-capture">
      <div
        ref={captureRef}
        role="textbox"
        tabIndex={0}
        className="hotkey-capture-area"
        onKeyDown={onKey}
        onBlur={() => { if (!captured) cancel(); }}
      >
        {captured ? formatHotkey(captured) : "Press your hotkey now…"}
      </div>
      {captured && (
        <button type="button" className="hotkey-btn save" onClick={() => { onCommit(captured); setCapturing(false); setCaptured(null); }}>
          Save
        </button>
      )}
      <button type="button" className="hotkey-btn cancel" onClick={cancel}>Cancel</button>
    </div>
  );
}
