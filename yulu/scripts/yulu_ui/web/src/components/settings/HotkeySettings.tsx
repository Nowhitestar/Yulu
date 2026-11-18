import { useEffect, useRef, useState } from "react";
import { Pencil, RotateCcw } from "lucide-react";
import { DEFAULT_HOTKEYS, HOTKEY_KEYS, MODIFIER_KEYS, HotkeysSchema, formatHotkey, type HotkeyValue } from "../../../../src/hotkeys.js";
import { trpc } from "../../trpc.js";
import { useLang, useT } from "../../i18n/LanguageProvider.js";
import "./HotkeySettings.css";

type Action = keyof typeof DEFAULT_HOTKEYS;
const ACTIONS = Object.keys(DEFAULT_HOTKEYS) as Action[];
const GROUPS = ["fn", "cmd", "shift", "alt", "ctrl"];
const KEY_NAMES: Record<string, string> = { Meta: "Command", Alt: "Option", Control: "Control", Shift: "Shift", Fn: "Fn" };
const CODE_KEYS: Record<string, string> = { MetaLeft: "LeftCommand", MetaRight: "RightCommand", ShiftLeft: "LeftShift", ShiftRight: "RightShift", AltLeft: "LeftOption", AltRight: "RightOption", ControlLeft: "LeftControl", ControlRight: "RightControl", Fn: "Fn" };
const modifierKey = (event: KeyboardEvent) => CODE_KEYS[event.code] ?? KEY_NAMES[event.key];
function keyName(event: KeyboardEvent) {
  if (event.code === "Space" || event.key === " ") return "Space";
  if (event.key === "Enter") return "Return";
  if (/^Key[A-Z]$/.test(event.code)) return event.code.slice(3);
  if (/^Digit\d$/.test(event.code)) return event.code.slice(5);
  return event.key.length === 1 ? event.key.toUpperCase() : event.key;
}

export function HotkeySettings({ hotkeys, disabled, onCommit }: {
  hotkeys: Record<Action, HotkeyValue & Record<string, unknown>>;
  disabled: boolean;
  onCommit: (path: string, value: unknown) => unknown;
}) {
  const t = useT();
  const { lang } = useLang();
  const pause = trpc.recording.shortcutEditing.useMutation();
  const [editing, setEditing] = useState<Action | null>(null);
  const [draft, setDraft] = useState<HotkeyValue>(DEFAULT_HOTKEYS.dictate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);
  const button = useRef<HTMLButtonElement | null>(null);
  const { mutateAsync: pauseShortcuts } = pause;
  const close = () => { setEditing(null); button.current?.focus(); };

  const save = async (action: Action, shortcut: HotkeyValue) => {
    if (busy.current) return;
    const next = { ...hotkeys[action], ...shortcut };
    if (!HotkeysSchema.safeParse({ ...hotkeys, [action]: next }).success) {
      setError(t("settings.voice.hotkey.conflict"));
      return;
    }
    busy.current = true; setSaving(true); setError(""); close();
    try { await onCommit(`status_agent.hotkeys.${action}`, next); }
    catch { setError(t("settings.voice.hotkey.saveFailed")); }
    finally { busy.current = false; setSaving(false); }
  };

  useEffect(() => {
    if (!editing) return;
    const held = new Map<string, string>();
    let modifierOnly: HotkeyValue | null = null;
    const refresh = setInterval(() => { void pauseShortcuts({ active: true }).catch(() => close()); }, 10_000);
    const down = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setError(""); close(); return; }
      if (event.target instanceof HTMLElement && event.target.closest("select, input")) return;
      event.preventDefault(); event.stopPropagation();
      if (event.repeat || busy.current) return;
      const modifier = modifierKey(event);
      if (modifier) {
        held.set(event.code || modifier, modifier);
        const keys = [...held.values()];
        const primary = keys.includes("Fn") ? "Fn" : modifier;
        modifierOnly = { key: primary, modifiers: keys.filter((key) => key !== primary).map((key) => MODIFIER_KEYS[key]!) };
        setDraft(modifierOnly);
        return;
      }
      modifierOnly = null;
      const key = keyName(event);
      if (!HOTKEY_KEYS.includes(key)) { setError(t("settings.voice.hotkey.unsupported")); return; }
      const modifiers = [...held.values()].map((value) => MODIFIER_KEYS[value]!);
      for (const [token, pressed] of [["cmd", event.metaKey], ["shift", event.shiftKey], ["alt", event.altKey], ["ctrl", event.ctrlKey], ["fn", event.getModifierState("Fn")]] as const) {
        if (pressed && !modifiers.some((item) => item === token || item.endsWith(`_${token}`))) modifiers.push(token);
      }
      void save(editing, { key, modifiers });
    };
    const up = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("select, input")) return;
      if (!modifierKey(event)) return;
      event.preventDefault(); event.stopPropagation();
      if (modifierOnly) { const shortcut = modifierOnly; modifierOnly = null; void save(editing, shortcut); }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    const blur = () => { modifierOnly = null; held.clear(); close(); };
    window.addEventListener("blur", blur);
    return () => {
      clearInterval(refresh);
      window.removeEventListener("keydown", down, true); window.removeEventListener("keyup", up, true); window.removeEventListener("blur", blur);
      void pauseShortcuts({ active: false }).catch(() => {});
    };
  // The editor owns one bounded keyboard gesture; draft updates must not restart it.
  }, [editing, pauseShortcuts]);

  const restore = async () => {
    if (busy.current) return;
    close(); busy.current = true; setSaving(true); setError("");
    const restored = { ...hotkeys, ...Object.fromEntries(ACTIONS.map((action) => [action, { ...hotkeys[action], ...DEFAULT_HOTKEYS[action] }])) };
    try { await onCommit("status_agent.hotkeys", restored); }
    catch { setError(t("settings.voice.hotkey.saveFailed")); }
    finally { busy.current = false; setSaving(false); }
  };

  return <div className="hotkey-settings">
    <div className="hotkey-settings-heading"><h3 className="settings-subheading">{t("settings.voice.shortcuts")}</h3>
      <button type="button" className="path-btn" disabled={disabled || saving || pause.isPending} onClick={() => void restore()}><RotateCcw size={14} />{t("settings.voice.hotkey.restore")}</button></div>
    <p className="settings-section-sub">{t("settings.voice.hotkey.help")}</p>
    {error && <p className="calendar-source-error" role="alert">{error}</p>}
    {saving && <p role="status">{t("settings.voice.hotkey.saving")}</p>}
    {ACTIONS.map((action) => <div key={action}>
      <div className="row row--wide"><div className="row-label">{t(`settings.voice.hotkey.${action}`)}</div><div className="row-value"><div className="voice-hotkey-display">
        <kbd>{formatHotkey(hotkeys[action] ?? DEFAULT_HOTKEYS[action], lang === "en")}</kbd>
        <button type="button" className="voice-hotkey-capture" aria-pressed={editing === action} aria-label={`${t(`settings.voice.hotkey.${action}`)} ${t("settings.voice.hotkey.reconfigure")}`}
          disabled={disabled || saving || pause.isPending || (editing !== null && editing !== action)} onClick={async (event) => {
            button.current = event.currentTarget; setError("");
            if (editing === action) { close(); return; }
            try {
              await pauseShortcuts({ active: true });
              setDraft(hotkeys[action] ?? DEFAULT_HOTKEYS[action]); setEditing(action);
            } catch { setError(t("settings.voice.hotkey.editUnavailable")); }
          }}><Pencil size={14} />{t(editing === action ? "danger.cancel" : "settings.voice.hotkey.reconfigure")}</button>
      </div></div><div className="row-status" /></div>
      {editing === action && <div className="hotkey-editor" role="group" aria-label={t("settings.voice.hotkey.editor")}>
        <p role="status">{t("settings.voice.hotkey.capture")}</p>
        <label>{t("settings.voice.hotkey.key")}<select aria-label={t("settings.voice.hotkey.key")} value={draft.key} onChange={(event) => setDraft({ key: event.target.value, modifiers: [] })}>
          {HOTKEY_KEYS.map((key) => <option key={key} value={key}>{formatHotkey({ key, modifiers: [] }, lang === "en")}</option>)}
        </select></label>
        <div className="hotkey-modifiers">{GROUPS.map((group) => <label key={group}>{formatHotkey({ key: "", modifiers: [group] }, lang === "en").replace(/ \+ $/, "")}<select
          aria-label={`${t("settings.voice.hotkey.modifier")} ${group}`}
          value={draft.modifiers.find((modifier) => modifier === group || modifier.endsWith(`_${group}`)) ?? ""}
          onChange={(event) => setDraft({ ...draft, modifiers: [...draft.modifiers.filter((modifier) => modifier !== group && !modifier.endsWith(`_${group}`)), ...(event.target.value ? [event.target.value] : [])] })}>
          <option value="">{t("settings.voice.hotkey.none")}</option><option value={group}>{t(group === "fn" ? "settings.voice.hotkey.with" : "settings.voice.hotkey.either")}</option>
          {group !== "fn" && <><option value={`left_${group}`}>{t("settings.voice.hotkey.left")}</option><option value={`right_${group}`}>{t("settings.voice.hotkey.right")}</option></>}
        </select></label>)}</div>
        <div className="hotkey-editor-actions"><kbd>{formatHotkey(draft, lang === "en")}</kbd><button type="button" className="path-btn" onClick={() => void save(action, draft)}>{t("settings.voice.hotkey.save")}</button></div>
      </div>}
    </div>)}
  </div>;
}
