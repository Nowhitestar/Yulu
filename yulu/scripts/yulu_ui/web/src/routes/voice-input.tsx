import { Link } from "react-router";
import { useEffect, useState } from "react";
import { Bot, Circle, Copy, FileText, Keyboard, Languages, Mic, SlidersHorizontal, Sparkles, Square } from "lucide-react";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./voice-input.css";

export const handle = { breadcrumb: "breadcrumb.voiceInput", filters: null };

type VoiceAction = "dictate" | "translate" | "voice_chat";

interface HistoryItem {
  id: string;
  createdAt: string;
  action: "dictate" | "translate";
  text: string;
  engine: string;
  promptSlug: string;
  targetLanguage: string;
}

const ACTIONS: Array<{ id: VoiceAction; icon: typeof Mic }> = [
  { id: "dictate", icon: Mic },
  { id: "translate", icon: Languages },
  { id: "voice_chat", icon: Bot },
];

const MODS: Record<string, string> = { cmd: "⌘", shift: "⇧", ctrl: "⌃", alt: "⌥" };

function hotkeyLabel(spec?: { key?: string; modifiers?: string[] }) {
  if (!spec) return "—";
  const mods = ["cmd", "shift", "ctrl", "alt"]
    .filter((m) => spec.modifiers?.includes(m))
    .map((m) => MODS[m])
    .join("");
  return `${mods}${spec.key || ""}` || "—";
}

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
  const [lastAction, setLastAction] = useState<VoiceAction | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const config = trpc.config.get.useQuery();
  const health = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const recording = trpc.recording.state.useQuery(undefined, { refetchInterval: 1_000 });
  const history = trpc.recording.history.useQuery(undefined, { refetchInterval: 5_000 });
  const invalidateRecording = () => { void utils.recording.state.invalidate(); };
  const dictate = trpc.recording.dictate.useMutation({ onSuccess: invalidateRecording });
  const translate = trpc.recording.translate.useMutation({ onSuccess: invalidateRecording });
  const voiceChat = trpc.recording.voiceChat.useMutation({ onSuccess: invalidateRecording });
  const hotkeys = config.data?.status_agent.hotkeys;
  const dictation = config.data?.transcription.dictation;
  const translateLanguage = config.data?.transcription.dictation.target_language || "English";
  const agent = health.data?.find((d) => d.name === "com.yulu.statusagent");
  const stt = health.data?.find((d) => d.name === "com.yulu.sttdaemon");
  const enabled = config.data?.status_agent.enabled ?? true;
  const ready = enabled && agent?.status === "running" && stt?.status === "running";
  const state = recording.data?.state ?? "idle";
  const activeIntent = recording.data?.dictationIntent;
  const activeAction: VoiceAction | null =
    state === "recording" && recording.data?.dictationActive
      ? activeIntent === "voice_chat" ? "voice_chat" : lastAction
      : null;
  const isRecording = state === "recording" && recording.data?.dictationActive;
  const isProcessing = state === "processing";
  const meetingRecording = state === "recording" && !recording.data?.dictationActive;
  const pending = dictate.isPending || translate.isPending || voiceChat.isPending;

  useEffect(() => {
    if (state === "idle") setLastAction(null);
  }, [state]);

  useEffect(() => {
    if (state === "idle") void utils.recording.history.invalidate();
  }, [state, utils]);

  function runAction(id: VoiceAction) {
    setLastAction(id);
    if (id === "dictate") dictate.mutate();
    if (id === "translate") translate.mutate({ targetLanguage: translateLanguage });
    if (id === "voice_chat") voiceChat.mutate();
  }

  async function copyHistory(item: HistoryItem) {
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      return;
    }
    setCopiedId(item.id);
    window.setTimeout(() => setCopiedId((current) => current === item.id ? null : current), 1200);
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
              : "Agent Console";
          const actionIsActive = activeAction === id || (isRecording && !activeAction && id === "dictate");
          const disabled = !ready || pending || isProcessing || meetingRecording || (Boolean(activeAction) && !actionIsActive);
          const ButtonIcon = actionIsActive ? Square : Icon;
          return (
            <section key={id} className="voice-action">
              <div className="voice-action-icon"><Icon size={18} strokeWidth={1.9} /></div>
              <div className="voice-action-main">
                <div className="voice-action-title">{t(`voiceInput.action.${id}`)}</div>
                <div className="voice-action-meta">
                  <Keyboard size={13} strokeWidth={1.8} />
                  <kbd>{hotkeyLabel(spec)}</kbd>
                  {language && <span>{language}</span>}
                </div>
              </div>
              <button
                type="button"
                className="voice-action-button"
                disabled={disabled}
                onClick={() => runAction(id)}
              >
                <ButtonIcon size={14} strokeWidth={2} />
                <span>{actionIsActive ? t("voiceInput.button.stop") : t(`voiceInput.button.${id}`)}</span>
              </button>
              <div className="voice-action-prompt">{prompt}</div>
            </section>
          );
        })}
      </div>

      <div className="voice-input-links">
        <Link to="/knowledge/prompts" className="voice-link">
          <FileText size={15} strokeWidth={1.8} />
          {t("voiceInput.link.prompts")}
        </Link>
        <Link to="/knowledge/glossary" className="voice-link">
          <Sparkles size={15} strokeWidth={1.8} />
          {t("voiceInput.link.glossary")}
        </Link>
        <Link to="/voice-chat" className="voice-link primary">
          <Bot size={15} strokeWidth={1.8} />
          {t("voiceInput.link.voiceChat")}
        </Link>
        <Link to="/settings/voice" className="voice-link primary">
          <SlidersHorizontal size={15} strokeWidth={1.8} />
          {t("voiceInput.link.settings")}
        </Link>
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
