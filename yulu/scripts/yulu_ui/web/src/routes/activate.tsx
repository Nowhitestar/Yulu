import { useState } from "react";
import { Link } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { MarkdownView } from "../components/MarkdownView.js";
import { useLang, useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";
import "./activate.css";

export const handle = { breadcrumb: "breadcrumb.activate", filters: null };

export function Activate() {
  const activation = trpc.activation.status.useQuery();
  const [noteOpen, setNoteOpen] = useState(false);
  const { lang } = useLang();
  const t = useT();
  if (activation.isPending) {
    return <section className="activate-page" aria-live="polite">{t("activation.loading")}</section>;
  }
  if (!activation.data || activation.data.state === "unresolved") {
    return (
      <section className="activate-page" aria-labelledby="activate-title">
        <div className="activate-card">
          <h1 id="activate-title">{t("activation.unresolved.title")}</h1>
          <p>{t("activation.unresolved.body")}</p>
        </div>
      </section>
    );
  }

  const { evidence } = activation.data;
  const completedAt = new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(evidence.completedAt));

  return (
    <section className="activate-page" aria-labelledby="activate-title">
      <div className="activate-card">
        <div className="activate-status" role="status">
          <CheckCircle2 size={18} aria-hidden="true" />
          {t("activation.activated.status")}
        </div>
        <h1 id="activate-title">{t("activation.activated.title")}</h1>
        <p className="activate-intro">{t("activation.activated.body")}</p>

        <dl className="activate-evidence" aria-label={t("activation.evidence.aria")}>
          <div><dt>{t("activation.evidence.recording")}</dt><dd>{evidence.recordingStem}</dd></div>
          <div><dt>{t("activation.evidence.transcription")}</dt><dd>{evidence.transcriptionProvider}</dd></div>
          <div><dt>{t("activation.evidence.summary")}</dt><dd>{evidence.summaryProvider} · {evidence.summaryModel}</dd></div>
          <div><dt>{t("activation.evidence.completed")}</dt><dd>{completedAt}</dd></div>
        </dl>

        {!activation.data.sourceArtifactAvailable && (
          <p className="activate-source-missing">{t("activation.sourceMissing")}</p>
        )}

        <div className="activate-actions">
          {activation.data.completedNoteAvailable && (
            <button
              type="button"
              className="activate-action primary"
              aria-expanded={noteOpen}
              aria-controls="activate-completed-note"
              onClick={() => setNoteOpen((open) => !open)}
            >
              {t("activation.action.note")}
            </button>
          )}
          <Link className="activate-action" to="/settings/transcription">{t("activation.action.transcription")}</Link>
          <Link className="activate-action" to="/settings/llm">{t("activation.action.providers")}</Link>
        </div>

        {noteOpen && activation.data.completedNote && (
          <div id="activate-completed-note" className="activate-completed-note">
            <MarkdownView text={activation.data.completedNote} />
          </div>
        )}
      </div>
    </section>
  );
}
