import { Link } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { trpc } from "../../trpc.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
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
  const [savingHotkey, setSavingHotkey] = useState(false);
  const savingRef = useRef(false);
  const captureButton = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
        setCapturing(null);
        setCaptureError("");
        captureButton.current?.focus();
        return;
      }
      if (event.repeat || savingRef.current) return;
      if (["Meta", "Shift", "Control", "Alt"].includes(event.key)) return;
      const next = shortcutFromEvent(event);
      if (!next) {
        setCaptureError(t("settings.voice.hotkey.unsupported"));
        return;
      }
      setCaptureError("");
      savingRef.current = true;
      setSavingHotkey(true);
      setCapturing(null);
      // Save the whole shortcut once, preserving optional fields and one-step undo.
      const previous = cfg?.status_agent.hotkeys?.[capturing] ?? DEFAULT_HOTKEYS[capturing];
      void Promise.resolve(commit(`status_agent.hotkeys.${capturing}`)({ ...previous, ...next }))
        .catch((error: unknown) => setCaptureError(error instanceof Error ? error.message : String(error)))
        .finally(() => {
          savingRef.current = false;
          setSavingHotkey(false);
          captureButton.current?.focus();
        });
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [capturing, commit, cfg, t]);

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
        label={t("settings.voice.enabled")}
        help={agentHelp}
        type="toggle"
        value={agentEnabled}
        onCommit={commit("status_agent.enabled")}
        disabled={isBlocked("status_agent.enabled")}
        status={tracker.statusFor("status_agent.enabled")}
      />

      {statusAgent && agentEnabled !== agentRunning && <Link className="settings-text-link" to="/settings/general#capabilities">{t("settings.voice.checkService")}</Link>}
      <InlineEditRow label={t("settings.voice.inputMode")} help={t("settings.voice.inputModeHelp")}
        type="select" value={cfg.status_agent.voice_input_mode ?? "toggle"}
        options={[{ value: "toggle", label: t("settings.voice.modeToggle") }, { value: "hold", label: t("settings.voice.modeHold") }]}
        onCommit={commit("status_agent.voice_input_mode") as (value: string) => void}
        disabled={isBlocked("status_agent.voice_input_mode")} status={tracker.statusFor("status_agent.voice_input_mode")} />
      <InlineEditRow label={t("settings.voice.askScope")} help={t("settings.voice.askScopeHelp")}
        type="select" value={dictation.voice_chat_scope ?? "general"}
        options={[{ value: "general", label: t("assistant.scopeGeneral") }, { value: "meetings", label: t("assistant.scopeMeetings") }]}
        onCommit={commit("transcription.dictation.voice_chat_scope") as (value: string) => void} />
      <div className="voice-feedback">
      <InlineEditRow
        label={t("settings.voice.feedbackSounds")}
        help={t("settings.voice.feedbackSoundsHelp")}
        type="toggle"
        value={cfg.status_agent.feedback_sounds ?? true}
        onCommit={commit("status_agent.feedback_sounds")}
        status={tracker.statusFor("status_agent.feedback_sounds")}
      />
          <button
            type="button"
            className="path-btn"
            disabled={!(cfg.status_agent.feedback_sounds ?? true) || !agentRunning || previewSound.isPending}
            onClick={() => previewSound.mutate()}
          >
            {t("settings.voice.preview")}
          </button>
      </div>

      <h3 className="settings-subheading">{t("settings.voice.shortcuts")}</h3>
      <p className="settings-section-sub">{t("settings.voice.hotkey.help")}</p>
      {captureError && !capturing && <p className="calendar-source-error" role="alert">{captureError}</p>}
      {savingHotkey && <p role="status">{t("settings.voice.hotkey.saving")}</p>}
      {ACTIONS.map((action) => {
        const spec = hotkeys[action];
        const fallback = DEFAULT_HOTKEYS[action];
        return (
          <div key={action} className="row row--wide">
            <div className="row-label">
              <div>{t(`settings.voice.hotkey.${action}`)}</div>
              {capturing === action && <div className="row-help" role={captureError ? "alert" : "status"}>
                {captureError || t("settings.voice.hotkey.capture")}
              </div>}
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
                  aria-pressed={capturing === action}
                  aria-label={`${t(`settings.voice.hotkey.${action}`)} ${t("settings.voice.hotkey.reconfigure")}`}
                  title={t("settings.voice.hotkey.reconfigure")}
                  disabled={isBlocked("status_agent.hotkeys") || savingHotkey}
                  onClick={(event) => {
                    captureButton.current = event.currentTarget;
                    setCaptureError("");
                    setCapturing(capturing === action ? null : action);
                  }}
                >
                  <Pencil size={14} strokeWidth={2.1} />
                  <span>{capturing === action ? t("danger.cancel") : t("settings.voice.hotkey.reconfigure")}</span>
                </button>
              </div>
            </div>
            <div className="row-status" />
          </div>
        );
      })}

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
      <InlineEditRow
        label={t("settings.voice.cleanup")}
        help={t("settings.voice.cleanupHelp")}
        type="toggle"
        value={dictation.cleanup_enabled ?? true}
        onCommit={commit("transcription.dictation.cleanup_enabled")}
      />
      <AdvancedDisclosure title={t("settings.voice.templates")} note="">
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
        <Link className="settings-text-link" to="/knowledge/prompts">{t("settings.voice.manageTemplates")}</Link>
      </AdvancedDisclosure>
    </section>
  );
}
