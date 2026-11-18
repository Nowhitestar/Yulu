import { useEffect, useState } from "react";
import { Copy, Languages, MessageCircle, Mic } from "lucide-react";
import { trpc } from "../trpc.js";
import { useLang, useT } from "../i18n/LanguageProvider.js";
import { DEFAULT_HOTKEYS, formatHotkey } from "../../../src/hotkeys.js";
import { usePermissions } from "../hooks/usePermissions.js";
import "./voice-input.css";


type VoiceAction = "dictate" | "translate" | "voice_chat";

interface HistoryItem {
  id: string;
  createdAt: string;
  action: "dictate" | "translate";
  text: string;
  targetLanguage: string;
  rawText?: string;
  cleanupStatus?: string;
  cleanupWarning?: string;
}

const ACTIONS: Array<{ id: VoiceAction; icon: typeof Mic }> = [
  { id: "dictate", icon: Mic },
  { id: "translate", icon: Languages },
  { id: "voice_chat", icon: MessageCircle },
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

  const status = isProcessing ? "processing" : isRecording ? "recording" : ready ? "ready" : "check";
  const tone = { processing: "accent", recording: "bad", ready: "ok", check: "warn" }[status];

  return (
    <div className="voice-input-page page">
      <header className="page-head">
        <div>
          <h1 className="page-title">{t("voiceInput.title")}</h1>
          <p className="page-sub">{t("voiceInput.sub")}</p>
        </div>
        <span className="voice-input-status badge" data-ready={ready} data-tone={tone}>
          <i aria-hidden="true" />
          {t(`voiceInput.status.${status}`)}
        </span>
      </header>

      <div className="voice-input-grid group">
        {ACTIONS.map(({ id, icon: Icon }) => (
          <section key={id} className="voice-action">
            <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
            <span className="voice-action-title">{t(`voiceInput.action.${id}`)}</span>
            {id === "translate" && <span className="voice-action-note">{String(translateLanguage)}</span>}
            <kbd className="kbd">{formatHotkey(hotkeys?.[id] ?? DEFAULT_HOTKEYS[id], lang === "en")}</kbd>
          </section>
        ))}
      </div>

      <section className="voice-history">
        <h2>{t("voiceInput.history.title")}</h2>
        {historyItems.length === 0 ? (
          <div className="voice-history-empty">{t("voiceInput.history.empty")}</div>
        ) : (
          <div className="voice-history-list">
            {historyItems.map((item) => (
              <article key={item.id} className="voice-history-row">
                <div className="voice-history-main">
                  <p>{item.text}</p>
                  <div className="voice-history-meta">
                    <span>{t(`voiceInput.history.${item.action}`)}</span>
                    {formatHistoryTime(item.createdAt) && <span>{formatHistoryTime(item.createdAt)}</span>}
                    {item.targetLanguage && <span>{item.targetLanguage}</span>}
                  </div>
                  {item.cleanupWarning && <p className="voice-history-warning">{t("voiceInput.history.cleanupFailed")}</p>}
                  {item.rawText && item.rawText !== item.text && <details className="voice-history-original">
                    <summary>{t("voiceInput.history.original")}</summary>
                    <p>{item.rawText}</p>
                    <button type="button" className="btn" onClick={() => { void copyHistory(item, true); }}>
                      <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
                      {t(copiedId === `${item.id}:original` ? "voiceInput.history.copied" : "voiceInput.history.copyOriginal")}
                    </button>
                  </details>}
                </div>
                <button
                  type="button"
                  className="voice-history-copy btn btn-quiet"
                  aria-label={t("voiceInput.history.copy")}
                  title={t("voiceInput.history.copy")}
                  onClick={() => { void copyHistory(item); }}
                >
                  <Copy size={13} strokeWidth={1.8} aria-hidden="true" />
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
