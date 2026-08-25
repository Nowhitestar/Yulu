import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { MarkdownView } from "../components/MarkdownView.js";
import { useLang, useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";
import "./activate.css";

export const handle = { breadcrumb: "breadcrumb.activate", filters: null };

export function Activate() {
  const activation = trpc.activation.status.useQuery();
  const defer = trpc.activation.defer.useMutation();
  const acceptXaiDisclosure = trpc.activation.acceptXaiTranscriptionDisclosure.useMutation();
  const updateConfig = trpc.config.update.useMutation();
  const testLocal = trpc.localCaption.test.useMutation();
  const probeXai = trpc.providers.probe.useMutation();
  const [noteOpen, setNoteOpen] = useState(false);
  const [deferFailed, setDeferFailed] = useState(false);
  const [pendingXai, setPendingXai] = useState(false);
  const [disclosureDeclined, setDisclosureDeclined] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const { lang } = useLang();
  const t = useT();
  useEffect(() => {
    if (activation.data) titleRef.current?.focus();
  }, [activation.data]);
  if (activation.isPending) {
    return <section className="activate-page" aria-live="polite">{t("activation.loading")}</section>;
  }
  if (!activation.data || activation.data.state === "unresolved") {
    const data = activation.data;
    const readiness = data?.readiness;
    const selected = readiness?.transcription.selected ?? "local";
    const disclosureOpen = Boolean(readiness && !disclosureDeclined && (
      pendingXai || (selected === "xai" && readiness.transcription.xai.disclosureRequired)
    ));
    const run = async (action: () => Promise<unknown>) => {
      setActionFailed(false);
      try {
        await action();
        await activation.refetch();
      } catch {
        setActionFailed(true);
      }
    };
    const chooseLocal = () => run(async () => {
      setPendingXai(false);
      setDisclosureDeclined(false);
      await updateConfig.mutateAsync({ key: "transcription.engine", value: "local" });
    });
    const chooseXai = () => {
      setDisclosureDeclined(false);
      if (readiness?.transcription.xai.disclosureRequired) setPendingXai(true);
      else void run(() => updateConfig.mutateAsync({ key: "transcription.engine", value: "xai" }));
    };
    const retryTranscription = () => run(() => selected === "local"
      ? testLocal.mutateAsync()
      : probeXai.mutateAsync({ capability: "transcription" }));
    return (
      <section className="activate-page" aria-labelledby="activate-title">
        <div className="activate-card">
          <h1 id="activate-title" ref={titleRef} tabIndex={-1}>{t("activation.unresolved.title")}</h1>
          <p>{t("activation.unresolved.body")}</p>

          {readiness && (
            <ol className="activate-readiness" aria-label={t("activation.readiness.aria")}>
              <li data-state={readiness.microphonePermission.state}>
                {readiness.microphonePermission.state === "ready"
                  ? t("activation.microphone.ready")
                  : t("activation.microphone.blocked")}
              </li>
              <li data-state={readiness.audioInput.state}>
                {readiness.audioInput.state === "ready"
                  ? t("activation.audioInput.ready")
                  : t("activation.audioInput.blocked")}
              </li>
              <li data-state={readiness.transcription.state}>
                {readiness.transcription.state === "ready"
                  ? t("activation.transcription.ready")
                  : t("activation.transcription.pending")}
              </li>
            </ol>
          )}

          {readiness && readiness.transcription.state !== "ready" && (
            <fieldset className="activate-engine">
              <legend>{t("activation.transcription.choose")}</legend>
              <label>
                <input
                  type="radio"
                  name="activation-transcription"
                  checked={selected === "local" && !pendingXai}
                  onChange={() => void chooseLocal()}
                />
                {t("activation.transcription.local")}
              </label>
              <label>
                <input
                  type="radio"
                  name="activation-transcription"
                  checked={selected === "xai" || pendingXai}
                  onClick={() => {
                    if (selected === "xai" && readiness.transcription.xai.disclosureRequired) {
                      setDisclosureDeclined(false);
                    }
                  }}
                  onChange={chooseXai}
                />
                {t("activation.transcription.xai")}
              </label>
            </fieldset>
          )}

          {data?.blocker?.capability === "microphone_permission" && (
            <div className="activate-blocker" role="alert">
              <p>{t("activation.microphone.guidance")}</p>
              <div className="activate-actions">
                <a className="activate-action primary" href={data.blocker.remediation.href}>
                  {t("activation.microphone.openSettings")}
                </a>
                <button type="button" className="activate-action" onClick={() => void activation.refetch()}>
                  {t("activation.microphone.retry")}
                </button>
              </div>
            </div>
          )}

          {data?.blocker?.capability === "audio_input" && (
            <div className="activate-blocker" role="alert">
              <p>{t("activation.audioInput.guidance")}</p>
              <div className="activate-actions">
                <Link className="activate-action primary" to={data.blocker.remediation.href}>
                  {t("activation.audioInput.openSettings")}
                </Link>
                <button type="button" className="activate-action" onClick={() => void activation.refetch()}>
                  {t("activation.audioInput.retry")}
                </button>
              </div>
            </div>
          )}

          {(data?.blocker?.capability === "local_transcription" ||
            data?.blocker?.capability === "xai_transcription") && (
            <div className="activate-blocker" role="alert">
              <p>{data.blocker.capability === "local_transcription"
                ? t("activation.transcription.localBlocked")
                : t("activation.transcription.xaiBlocked")}</p>
              <div className="activate-actions">
                <Link className="activate-action primary" to={data.blocker.remediation.href}>
                  {t("activation.transcription.openSettings")}
                </Link>
                <button type="button" className="activate-action" onClick={() => void retryTranscription()}>
                  {t("activation.transcription.retry")}
                </button>
              </div>
            </div>
          )}

          {readiness && disclosureOpen && (
            <div
              className="activate-disclosure"
              role="dialog"
              aria-labelledby="activate-xai-disclosure-title"
            >
              <h2 id="activate-xai-disclosure-title">{t("activation.disclosure.title")}</h2>
              <p>{t("activation.disclosure.privacy")}</p>
              <p>{t("activation.disclosure.cost")}</p>
              <div className="activate-actions">
                <button
                  type="button"
                  className="activate-action primary"
                  onClick={() => void run(async () => {
                    await acceptXaiDisclosure.mutateAsync();
                    if (pendingXai) {
                      await updateConfig.mutateAsync({ key: "transcription.engine", value: "xai" });
                    }
                    setPendingXai(false);
                  })}
                >
                  {t("activation.disclosure.accept")}
                </button>
                <button
                  type="button"
                  className="activate-action"
                  onClick={() => {
                    setPendingXai(false);
                    setDisclosureDeclined(true);
                  }}
                >
                  {t("activation.disclosure.decline")}
                </button>
              </div>
            </div>
          )}

          {readiness && disclosureDeclined && (
            <div className="activate-declined" role="status">
              <p>{t("activation.disclosure.declined")}</p>
              {readiness.transcription.local.available && (
                <button type="button" className="activate-action" onClick={() => void chooseLocal()}>
                  {t("activation.disclosure.chooseLocal")}
                </button>
              )}
            </div>
          )}

          <div className="activate-actions">
            <Link className="activate-action" to="/settings/llm">
              {t("activation.action.providers")}
            </Link>
            <button
              type="button"
              className="activate-action"
              disabled={defer.isPending}
              onClick={() => {
                setDeferFailed(false);
                void defer.mutateAsync().then(
                  () => navigate("/agent-console", { replace: true }),
                  () => setDeferFailed(true),
                );
              }}
            >
              {t("activation.action.defer")}
            </button>
          </div>
          {deferFailed && <p role="alert">{t("activation.defer.error")}</p>}
          {actionFailed && <p role="alert">{t("activation.action.error")}</p>}
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
        <h1 id="activate-title" ref={titleRef} tabIndex={-1}>{t("activation.activated.title")}</h1>
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
