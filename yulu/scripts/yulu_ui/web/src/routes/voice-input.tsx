import { useEffect, useState } from "react";
import { Bot, Circle, Copy, Keyboard, Languages, Mic } from "lucide-react";
import { trpc } from "../trpc.js";
import { useLang, useT } from "../i18n/LanguageProvider.js";
import { DEFAULT_HOTKEYS, formatHotkey } from "../../../src/hotkeys.js";
import { usePermissions } from "../hooks/usePermissions.js";
import "./voice-input.css";

export const handle = { breadcrumb: "breadcrumb.voiceInput", filters: null };

type VoiceAction = "dictate" | "translate" | "voice_chat";

interface HistoryItem {
  id: string;
  createdAt: string;
  action: "dictate" | "translate";
  text: string;
  promptSlug: string;
  targetLanguage: string;
  rawText?: string;
  cleanupStatus?: string;
  cleanupWarning?: string;
}

const ACTIONS: Array<{ id: VoiceAction; icon: typeof Mic }> = [
  { id: "dictate", icon: Mic },
  { id: "translate", icon: Languages },
  { id: "voice_chat", icon: Bot },
];

function formatHistoryTime(value: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(undefined, {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

export function VoiceInput() {
  const t = useT();
  const { lang } = useLang();
  const permissions = usePermissions();
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const config = trpc.config.get.useQuery();
  const health = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const transcriptionHealth = trpc.agentTasks.transcriptionHealth.useQuery(undefined, { refetchInterval: 5_000 });
  const recording = trpc.recording.state.useQuery(undefined, { refetchInterval: 1_000 });
  const history = trpc.recording.history.useQuery(undefined, { refetchInterval: 5_000 });
  const hotkeys = config.data?.status_agent.hotkeys;
  const dictation = config.data?.transcription.dictation;
  const translateLanguage = config.data?.transcription.dictation.target_language || "English";
  const agent = health.data?.find((d) => d.name === "com.yulu.statusagent");
  const enabled = config.data?.status_agent.enabled ?? true;
  const ready = enabled && agent?.status === "running" && transcriptionHealth.data?.available === true &&
    permissions.data?.input === "ready" && permissions.data.microphone === "ready";
  const state = recording.data?.state ?? "idle";
  const isRecording = state === "recording" && recording.data?.dictationActive;
  const isProcessing = state === "processing";

  useEffect(() => {
    if (state === "idle") void utils.recording.history.invalidate();
  }, [state, utils]);

  async function copyHistory(item: HistoryItem, original = false) {
    try {
      await navigator.clipboard.writeText(original ? item.rawText ?? item.text : item.text);
    } catch {
      return;
    }
    const id = original ? `${item.id}:original` : item.id;
    setCopiedId(id);
    window.setTimeout(() => setCopiedId((current) => current === id ? null : current), 1200);
  }

  const historyItems = (history.data ?? []) as HistoryItem[];

  return (
    <div className="voice-input-page">
      <div className="voice-input-head">
        <div>
          <h1>{t("voiceInput.title")}</h1>
          <p>{t("voiceInput.sub")}</p>
        </div>
        <span className="voice-input-status" data-ready={ready}>
          <Circle size={9} fill="currentColor" strokeWidth={0} />
          {isProcessing
            ? t("voiceInput.status.processing")
            : isRecording
              ? t("voiceInput.status.recording")
              : ready ? t("voiceInput.status.ready") : t("voiceInput.status.check")}
        </span>
      </div>

      <div className="voice-input-grid">
        {ACTIONS.map(({ id, icon: Icon }) => {
          const spec = hotkeys?.[id];
          const language = id === "translate" ? String(translateLanguage) : "";
          const prompt = id === "dictate"
            ? dictation?.prompt_slug || "dictation-cleanup"
            : id === "translate"
              ? dictation?.translate_prompt_slug || "dictation-translate"
              : t("nav.agentConsole");
          return (
            <section key={id} className="voice-action">
              <div className="voice-action-icon"><Icon size={18} strokeWidth={1.9} /></div>
              <div className="voice-action-main">
                <div className="voice-action-title">{t(`voiceInput.action.${id}`)}</div>
                <div className="voice-action-meta">
                  <Keyboard size={13} strokeWidth={1.8} />
                  <kbd>{formatHotkey(spec ?? DEFAULT_HOTKEYS[id], lang === "en")}</kbd>
                  {language && <span>{language}</span>}
                </div>
              </div>
              <div className="voice-action-prompt">{prompt}</div>
            </section>
          );
        })}
      </div>

      <section className="voice-history">
        <div className="voice-history-head">
          <h2>{t("voiceInput.history.title")}</h2>
        </div>
        {historyItems.length === 0 ? (
          <div className="voice-history-empty">{t("voiceInput.history.empty")}</div>
        ) : (
          <div className="voice-history-list">
            {historyItems.map((item) => (
              <article key={item.id} className="voice-history-row">
                <div className="voice-history-main">
                  <div className="voice-history-meta">
                    <span>{t(`voiceInput.history.${item.action}`)}</span>
                    {formatHistoryTime(item.createdAt) && <span>{formatHistoryTime(item.createdAt)}</span>}
                    {item.targetLanguage && <span>{item.targetLanguage}</span>}
                    {item.promptSlug && <span>{item.promptSlug}</span>}
                  </div>
                  <p>{item.text}</p>
                  {item.cleanupWarning && <p className="voice-history-warning">{t("voiceInput.history.cleanupFailed")}</p>}
                  {item.rawText && item.rawText !== item.text && <details className="voice-history-original">
                    <summary>{t("voiceInput.history.original")}</summary>
                    <p>{item.rawText}</p>
                    <button type="button" className="voice-history-copy" onClick={() => { void copyHistory(item, true); }}>
                      <Copy size={14} strokeWidth={2} />
                      {t(copiedId === `${item.id}:original` ? "voiceInput.history.copied" : "voiceInput.history.copyOriginal")}
                    </button>
                  </details>}
                </div>
                <button
                  type="button"
                  className="voice-history-copy"
                  aria-label={t("voiceInput.history.copy")}
                  title={t("voiceInput.history.copy")}
                  onClick={() => { void copyHistory(item); }}
                >
                  <Copy size={14} strokeWidth={2} />
                  <span>{copiedId === item.id ? t("voiceInput.history.copied") : t("voiceInput.history.copy")}</span>
                </button>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
