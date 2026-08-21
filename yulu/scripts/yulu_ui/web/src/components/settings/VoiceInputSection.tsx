import { Link } from "react-router";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useUndoToast } from "../UndoToast.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface VoiceInputSectionProps {
  tracker: SettingsRestartTracker;
}

type HotkeyAction = "dictate" | "translate" | "voice_chat";
type HotkeySpec = { key: string; modifiers: string[] };

const ACTIONS: HotkeyAction[] = ["dictate", "translate", "voice_chat"];
const DEFAULT_HOTKEYS = {
  dictate: { key: "Space", modifiers: ["ctrl", "alt"] },
  translate: { key: "T", modifiers: ["ctrl", "alt"] },
  voice_chat: { key: "A", modifiers: ["ctrl", "alt"] },
} satisfies Record<HotkeyAction, { key: string; modifiers: string[] }>;
const SUPPORTED_KEYS = [
  "Space", "Tab", "Return", "Escape",
  "A", "S", "D", "F", "H", "G", "Z", "X", "C", "V", "B", "Q", "W", "E", "R",
  "Y", "T", "O", "U", "I", "P", "L", "J", "K", "N", "M",
  "1", "2", "3", "4", "5", "6", "7", "8", "9", "0",
  "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12",
  "F13", "F14", "F15", "F16", "F17", "F18", "F19", "F20",
];
const MODIFIER_ORDER = ["cmd", "shift", "ctrl", "alt"] as const;
const MOD_SYMBOLS: Record<(typeof MODIFIER_ORDER)[number], string> = {
  cmd: "⌘",
  shift: "⇧",
  ctrl: "⌃",
  alt: "⌥",
};
function formatHotkey(spec: HotkeySpec) {
  const mods = MODIFIER_ORDER
    .filter((m) => spec.modifiers.includes(m))
    .map((m) => MOD_SYMBOLS[m])
    .join("");
  return `${mods}${spec.key}` || "—";
}

function keyFromEvent(event: KeyboardEvent) {
  if (event.key === " ") return "Space";
  if (event.key === "Enter") return "Return";
  if (event.key === "Esc") return "Escape";
  if (event.key === "Escape") return "Escape";
  if (event.key === "Tab") return "Tab";
  if (/^F(?:[1-9]|1[0-9]|20)$/.test(event.key)) return event.key;
  if (/^[a-z0-9]$/i.test(event.key)) return event.key.toUpperCase();
  return "";
}

function shortcutFromEvent(event: KeyboardEvent): HotkeySpec | null {
  if (["Meta", "Shift", "Control", "Alt"].includes(event.key)) return null;
  const key = keyFromEvent(event);
  if (!SUPPORTED_KEYS.includes(key)) return null;
  const modifiers = MODIFIER_ORDER.filter((m) => {
    if (m === "cmd") return event.metaKey;
    if (m === "shift") return event.shiftKey;
    if (m === "ctrl") return event.ctrlKey;
    return event.altKey;
  });
  return { key, modifiers };
}

export function VoiceInputSection({ tracker }: VoiceInputSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: prompts } = trpc.prompts.list.useQuery({ category: "voice" });
  const { data: daemons } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();
  const { showError } = useUndoToast();
  const previewSound = trpc.recording.previewSound.useMutation({
    onError: (error: unknown) => showError(t("settings.voice.previewFailed", {
      error: error instanceof Error ? error.message : String(error),
    })),
  });
  const [capturing, setCapturing] = useState<HotkeyAction | null>(null);
  const [captureError, setCaptureError] = useState("");

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const next = shortcutFromEvent(event);
      if (!next) {
        setCaptureError(t("settings.voice.hotkey.unsupported"));
        return;
      }
      setCaptureError("");
      void (async () => {
        const keyCommit = commit(`status_agent.hotkeys.${capturing}.key`)(next.key);
        if (keyCommit) await keyCommit;
        const modsCommit = commit(`status_agent.hotkeys.${capturing}.modifiers`)(next.modifiers);
        if (modsCommit) await modsCommit;
        setCapturing(null);
      })();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, commit, t]);

  if (!cfg) return null;

  const dictation = cfg.transcription.dictation ?? {};
  const hotkeys = cfg.status_agent.hotkeys ?? DEFAULT_HOTKEYS;
  const statusAgent = daemons?.find((daemon) => daemon.name === "com.yulu.statusagent");
  const agentRunning = statusAgent?.status === "running" || statusAgent?.status === "idle";
  const agentEnabled = cfg.status_agent.enabled ?? false;
  const agentHelp = !statusAgent
    ? t("settings.voice.statusAgent.checking")
    : agentEnabled && agentRunning
      ? t("settings.voice.statusAgent.running")
      : agentEnabled
        ? t("settings.voice.statusAgent.enabledStopped")
        : agentRunning
          ? t("settings.voice.statusAgent.disabledRunning")
          : t("settings.voice.statusAgent.stopped");
  const promptOptions = (prompts ?? []).map((p) => ({
    value: String((p as { slug: string }).slug),
    label: String((p as { name?: string; slug: string }).name || (p as { slug: string }).slug),
  }));
  const ensurePrompt = (slug: string) =>
    promptOptions.some((p) => p.value === slug) ? promptOptions : [{ value: slug, label: slug }, ...promptOptions];

  return (
    <section id="voice-input" className="settings-section">
      <h2 className="settings-section-h">{t("settings.voice.heading")}</h2>
      <p className="settings-section-sub">{t("settings.voice.sub")}</p>

      <InlineEditRow
        label={t("settings.hotkey.statusAgent.label")}
        help={agentHelp}
        type="toggle"
        value={agentEnabled}
        onCommit={commit("status_agent.enabled")}
        disabled={isBlocked("status_agent.enabled")}
        status={tracker.statusFor("status_agent.enabled")}
      />

      <InlineEditRow
        label={t("settings.voice.feedbackSounds")}
        type="toggle"
        value={cfg.status_agent.feedback_sounds ?? true}
        onCommit={commit("status_agent.feedback_sounds")}
        status={tracker.statusFor("status_agent.feedback_sounds")}
      />
      <div className="row">
        <div className="row-label">
          <div>{t("settings.voice.previewSound")}</div>
          <div className="row-help">{t("settings.voice.feedbackSoundsHelp")}</div>
        </div>
        <div className="row-value">
          <button
            type="button"
            className="path-btn"
            disabled={!(cfg.status_agent.feedback_sounds ?? true) || !agentRunning || previewSound.isPending}
            onClick={() => previewSound.mutate()}
          >
            {t("settings.voice.preview")}
          </button>
        </div>
        <div className="row-status" />
      </div>

      {ACTIONS.map((action) => {
        const spec = hotkeys[action];
        const fallback = DEFAULT_HOTKEYS[action];
        return (
          <div key={action} className="row row--wide">
            <div className="row-label">
              <div>{t(`settings.voice.hotkey.${action}`)}</div>
              <div className="row-help">
                {capturing === action ? captureError || t("settings.voice.hotkey.capture") : t("settings.voice.hotkey.help")}
              </div>
            </div>
            <div className="row-value">
              <div className="voice-hotkey-display">
                <kbd>{formatHotkey({
                  key: String(spec?.key ?? fallback.key),
                  modifiers: spec?.modifiers ?? fallback.modifiers,
                })}</kbd>
                <button
                  type="button"
                  className="voice-hotkey-capture"
                  aria-label={`${t(`settings.voice.hotkey.${action}`)} ${t("settings.voice.hotkey.reconfigure")}`}
                  title={t("settings.voice.hotkey.reconfigure")}
                  disabled={isBlocked("status_agent.hotkeys")}
                  onClick={() => {
                    setCaptureError("");
                    setCapturing(action);
                  }}
                >
                  <X size={14} strokeWidth={2.1} />
                </button>
              </div>
            </div>
            <div className="row-status" />
          </div>
        );
      })}

      <InlineEditRow
        label={t("settings.voice.prompt.dictate")}
        type="select"
        value={dictation.prompt_slug ?? "dictation-cleanup"}
        options={ensurePrompt(dictation.prompt_slug ?? "dictation-cleanup")}
        onCommit={commit("transcription.dictation.prompt_slug") as (v: string) => void}
      />
      <InlineEditRow
        label={t("settings.voice.prompt.translate")}
        type="select"
        value={dictation.translate_prompt_slug ?? "dictation-translate"}
        options={ensurePrompt(dictation.translate_prompt_slug ?? "dictation-translate")}
        onCommit={commit("transcription.dictation.translate_prompt_slug") as (v: string) => void}
      />
      <InlineEditRow
        label={t("settings.voice.targetLanguage")}
        type="text"
        value={dictation.target_language ?? "English"}
        onCommit={commit("transcription.dictation.target_language") as (v: string) => void}
      />

      <div className="row">
        <div className="row-label">{t("settings.voice.glossary")}</div>
        <div className="row-value"><Link to="/knowledge/glossary">{t("settings.voice.openGlossary")}</Link></div>
        <div className="row-status" />
      </div>
    </section>
  );
}
