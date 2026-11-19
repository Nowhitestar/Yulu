import { useState } from "react";
import { trpc } from "../../trpc.js";
import { useLocale, useT } from "../../i18n/LanguageProvider.js";

interface HistoryItem {
  id: string;
  createdAt: string;
  action: "dictate" | "translate";
  text: string;
  targetLanguage: string;
  rawText?: string;
  cleanupWarning?: string;
}

/** What you dictated recently, so text that missed its target is never lost. */
export function VoiceHistory() {
  const t = useT();
  const locale = useLocale();
  const history = trpc.recording.history.useQuery(undefined, { refetchInterval: 5_000 });
  const [copied, setCopied] = useState<string | null>(null);
  const items = (history.data ?? []) as HistoryItem[];

  const copy = async (id: string, text: string) => {
    try { await navigator.clipboard.writeText(text); } catch { return; }
    setCopied(id);
    window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1200);
  };
  const when = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "" : date.toLocaleString(locale, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false,
    });
  };

  return (
    <section id="voice-history" className="settings-section">
      <h2 className="settings-section-h">{t("voiceInput.history.title")}</h2>
      {items.length === 0 ? <p className="settings-section-sub">{t("voiceInput.history.empty")}</p> : (
        <div className="voice-history">
          {items.map((item) => (
            <article key={item.id} className="voice-history-row">
              <div className="voice-history-main">
                <p>{item.text}</p>
                <p className="voice-history-meta">
                  {[t(`voiceInput.history.${item.action}`), item.action === "translate" ? item.targetLanguage : "", when(item.createdAt)].filter(Boolean).join(" · ")}
                </p>
                {item.cleanupWarning && <p className="voice-history-warning">{t("voiceInput.history.cleanupFailed")}</p>}
                {item.rawText && item.rawText !== item.text && (
                  <details className="voice-history-original">
                    <summary>{t("voiceInput.history.original")}</summary>
                    <p>{item.rawText}</p>
                    <button type="button" className="settings-text-link" onClick={() => void copy(`${item.id}:original`, item.rawText ?? item.text)}>
                      {t(copied === `${item.id}:original` ? "voiceInput.history.copied" : "voiceInput.history.copyOriginal")}
                    </button>
                  </details>
                )}
              </div>
              <button type="button" className="settings-text-link" onClick={() => void copy(item.id, item.text)}>
                {t(copied === item.id ? "voiceInput.history.copied" : "voiceInput.history.copy")}
              </button>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
