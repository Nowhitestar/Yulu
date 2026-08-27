import { useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { CheckCircle2 } from "lucide-react";
import { MarkdownView } from "../components/MarkdownView.js";
import { useLang, useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";
import { XAI_TEXT_MODEL_DEFAULT } from "../../../src/settingsRegistry.js";
import "./activate.css";

export const handle = { breadcrumb: "breadcrumb.activate", filters: null };

export function Activate() {
  const activation = trpc.activation.status.useQuery(undefined, {
    retry: false,
    refetchInterval: (query) => {
      const state = query.state.data?.state;
      return state === "recording" || state === "processing" ? 1_000 : false;
    },
  });
  const agentConnectionView = trpc.agentConnections.view.useQuery();
  const startAttempt = trpc.activation.startAttempt.useMutation();
  const stopAttempt = trpc.activation.stopAttempt.useMutation();
  const retryAttempt = trpc.activation.retryAttempt.useMutation();
  const rerecordAttempt = trpc.activation.rerecordAttempt.useMutation();
  const replaceSummaryProvider = trpc.activation.replaceSummaryProvider.useMutation();
  const defer = trpc.activation.defer.useMutation();
  const probeSummaryProvider = trpc.activation.probeSummaryProvider.useMutation();
  const updateConfig = trpc.config.update.useMutation();
  const testLocal = trpc.localCaption.test.useMutation();
  const probeXai = trpc.providers.probe.useMutation();
  const selectAgentConnection = trpc.agentConnections.select.useMutation();
  const acceptAgentConnectionDisclosure = trpc.agentConnections.acceptDisclosure.useMutation();
  const declineAgentConnectionDisclosure = trpc.agentConnections.declineDisclosure.useMutation();
  const [noteOpen, setNoteOpen] = useState(false);
  const [deferFailed, setDeferFailed] = useState(false);
  const [pendingXai, setPendingXai] = useState(false);
  const [disclosureDeclined, setDisclosureDeclined] = useState(false);
  const [summaryDisclosureDeclined, setSummaryDisclosureDeclined] = useState(false);
  const [reviewSummaryDisclosure, setReviewSummaryDisclosure] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const titleFocused = useRef(false);
  const openingGuidedTask = useRef<string | null>(null);
  const navigate = useNavigate();
  const { lang } = useLang();
  const t = useT();
  const directXaiAvailable = agentConnectionView.data?.connections
    .some((connection) => connection.id === "direct-xai") === true;
  useEffect(() => {
    if (
      activation.data?.state !== "activated" ||
      !activation.data.guidedCompletionPending ||
      !activation.data.guidedCompletion
    ) return;
    const { taskId, recordingStem } = activation.data.guidedCompletion;
    if (openingGuidedTask.current === taskId) return;
    openingGuidedTask.current = taskId;
    navigate(
      `/inbox/${encodeURIComponent(recordingStem)}?activation=complete&activationTaskId=${encodeURIComponent(taskId)}`,
      { replace: true },
    );
  }, [activation.data, navigate]);
  useEffect(() => {
    if (!activation.data || titleFocused.current) return;
    titleFocused.current = true;
    titleRef.current?.focus();
  }, [activation.data]);
  if (activation.isPending) {
    return <section className="activate-page" aria-live="polite">{t("activation.loading")}</section>;
  }
  if (activation.isError) {
    return (
      <section className="activate-page" aria-labelledby="activate-title">
        <div className="activate-card">
          <h1 id="activate-title" ref={titleRef} tabIndex={-1}>{t("activation.statusError.title")}</h1>
          <p role="alert">{t("activation.statusError.body")}</p>
          <div className="activate-actions">
            <button type="button" className="activate-action primary" onClick={() => void activation.refetch()}>
              {t("activation.statusError.retry")}
            </button>
            <Link className="activate-action" to="/agent-console">{t("activation.statusError.continue")}</Link>
          </div>
        </div>
      </section>
    );
  }
  if (activation.data?.state === "recording" || activation.data?.state === "processing") {
    const { task } = activation.data;
    const attemptError = activation.data.attempt.handoffError;
    const blocker = activation.data.blocker;
    const needsAttention = Boolean(blocker) || Boolean(attemptError) || (task !== null && (
        task.phase === "failed" ||
        ["awaiting_agent", "awaiting_provider", "awaiting_policy", "failed", "cancelled"].includes(task.state)
      ));
    const blockerMessage = blocker ? ({
      audio: "activation.attempt.blocker.audio",
      transcription: "activation.attempt.blocker.transcription",
      credential: "activation.attempt.blocker.credential",
      model: "activation.attempt.blocker.model",
      provider: "activation.attempt.blocker.provider",
      summary: "activation.attempt.blocker.summary",
      recording_pipeline: "activation.attempt.blocker.recordingPipeline",
    } as const)[blocker.capability] : null;
    const progress = activation.data.state === "recording"
      ? t("activation.attempt.recording")
      : blockerMessage
        ? t(blockerMessage)
        : needsAttention
        ? t("activation.attempt.failed")
        : task?.phase === "transcribing"
          ? t("activation.attempt.transcribing")
          : task?.phase === "summarizing" || task?.state === "transcript_committed"
            ? t("activation.attempt.summarizing")
            : task?.phase === "committing_artifacts" || task?.state === "artifacts_committed"
              ? t("activation.attempt.committing")
              : t("activation.attempt.queued");
    const runRecovery = (action: () => Promise<unknown>) => {
      setActionFailed(false);
      void action().then(
        () => activation.refetch(),
        () => setActionFailed(true),
      );
    };
    const remediationLabel = blocker?.remediation.href === "/settings/general"
      ? t("activation.audioInput.openSettings")
      : blocker?.remediation.href.includes("capability=transcription") || blocker?.remediation.href === "/settings/transcription"
        ? t("activation.transcription.openSettings")
        : blocker?.remediation.href === "/settings/automation"
          ? t("activation.pipeline.openSettings")
          : t("activation.summary.openSettings");
    return (
      <section className="activate-page" aria-labelledby="activate-title">
        <div className="activate-card">
          <h1 id="activate-title" ref={titleRef} tabIndex={-1}>{t("activation.attempt.title")}</h1>
          <p className="activate-intro">{t("activation.attempt.duration")}</p>
          <p className="activate-status" role={needsAttention ? "alert" : "status"} aria-live="polite">
            {progress}
          </p>
          {(blocker?.detail || task?.error || attemptError) && <p>{blocker?.detail || task?.error || attemptError}</p>}
          {activation.data.backgroundEvidence && (
            <div className="activation-notice" role="status" aria-live="polite">
              <span>{t("activation.notice.complete")}</span>
              <Link to={`/inbox/${encodeURIComponent(activation.data.backgroundEvidence.recordingStem)}`}>
                {t("activation.notice.open")}
              </Link>
            </div>
          )}
          <div className="activate-actions">
            {activation.data.state === "recording" && (
              <button
                type="button"
                className="activate-action primary"
                disabled={stopAttempt.isPending}
                onClick={() => {
                  setActionFailed(false);
                  void stopAttempt.mutateAsync().then(
                    () => activation.refetch(),
                    () => setActionFailed(true),
                  );
                }}
              >
                {t("activation.attempt.stop")}
              </button>
            )}
            {blocker && (
              <>
                <Link className="activate-action" to={blocker.remediation.href}>{remediationLabel}</Link>
                <button
                  type="button"
                  className="activate-action primary"
                  disabled={retryAttempt.isPending || rerecordAttempt.isPending}
                  onClick={() => runRecovery(() => blocker.retry === "rerecord"
                    ? rerecordAttempt.mutateAsync()
                    : retryAttempt.mutateAsync())}
                >
                  {blocker.retry === "rerecord"
                    ? t("activation.attempt.rerecord")
                    : blocker.retry === "start_recording"
                      ? t("activation.attempt.start")
                      : t("activation.attempt.retry")}
                </button>
              </>
            )}
            {activation.data.summaryRecovery?.canReplace && (
              <button
                type="button"
                className="activate-action"
                disabled={replaceSummaryProvider.isPending}
                onClick={() => runRecovery(() => replaceSummaryProvider.mutateAsync())}
              >
                {t("activation.attempt.replaceSummary", {
                  provider: activation.data.summaryRecovery.selected.provider,
                  model: activation.data.summaryRecovery.selected.model,
                })}
              </button>
            )}
            <Link className="activate-action" to="/agent-console">{t("activation.attempt.leave")}</Link>
          </div>
          {actionFailed && <p role="alert">{t("activation.action.error")}</p>}
        </div>
      </section>
    );
  }
  if (!activation.data || activation.data.state === "unresolved") {
    const data = activation.data;
    const readiness = data?.readiness;
    const selected = readiness?.transcription.selected ?? "local";
    const summary = readiness?.summary;
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
      else void run(() => selectAgentConnection.mutateAsync({
        connectionId: "direct-xai",
        capability: "transcription",
      }));
    };
    const retryTranscription = () => run(() => selected === "local"
      ? testLocal.mutateAsync()
      : probeXai.mutateAsync({ capability: "transcription" }));
    const chooseXaiSummary = () => run(async () => {
      setSummaryDisclosureDeclined(false);
      setReviewSummaryDisclosure(false);
      await selectAgentConnection.mutateAsync({
        connectionId: "direct-xai",
        capability: "summary",
        model: XAI_TEXT_MODEL_DEFAULT,
      });
    });
    const retrySummary = () => run(() => summary?.selected.provider === "xai"
      ? probeXai.mutateAsync({ capability: "summary" })
      : probeSummaryProvider.mutateAsync());
    const summaryProviderLabel = summary?.selected.provider === "xai"
      ? "xAI"
      : summary?.selected.provider === "agent"
        ? t("activation.summary.agent")
        : summary?.selected.provider ?? "";
    const summaryDisclosureConnectionId = summary?.disclosure?.connectionId ??
      (summary?.selected.provider === "xai" ? "direct-xai" : null);
    const summaryBlocker = data?.blocker && "reason" in data.blocker ? data.blocker : null;
    const summaryDisclosureIsDeclined = summaryDisclosureDeclined ||
      summaryBlocker?.reason === "disclosure_declined";
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
              <li data-state={readiness.summary.state}>
                {readiness.summary.state === "ready"
                  ? t("activation.summary.ready")
                  : t("activation.summary.pending")}
              </li>
              <li data-state={readiness.recordingPipeline.state}>
                {readiness.recordingPipeline.state === "ready"
                  ? t("activation.pipeline.ready")
                  : t("activation.pipeline.blocked")}
              </li>
            </ol>
          )}

          {summary && (
            <div className="activate-summary">
              <dl aria-label={t("activation.summary.identity.aria")}>
                <div><dt>{t("activation.summary.provider")}</dt><dd>{summaryProviderLabel}</dd></div>
                <div><dt>{t("activation.summary.model")}</dt><dd>{summary.selected.model}</dd></div>
              </dl>
              {summary.state !== "ready" && directXaiAvailable && (
                <fieldset className="activate-engine">
                  <legend>{t("activation.summary.choose")}</legend>
                  <label>
                    <input
                      type="radio"
                      name="activation-summary"
                      checked={summary.selected.provider === "xai"}
                      onChange={() => void chooseXaiSummary()}
                    />
                    xAI
                  </label>
                </fieldset>
              )}
            </div>
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
              {directXaiAvailable && (
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
              )}
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

          {data?.blocker?.capability === "recording_pipeline" && (
            <div className="activate-blocker" role="alert">
              <p>{t("activation.pipeline.guidance")}</p>
              <div className="activate-actions">
                <Link className="activate-action primary" to={data.blocker.remediation.href}>
                  {t("activation.pipeline.openSettings")}
                </Link>
                <button type="button" className="activate-action" onClick={() => void activation.refetch()}>
                  {t("activation.pipeline.retry")}
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
                    await acceptAgentConnectionDisclosure.mutateAsync({
                      connectionId: "direct-xai",
                      capability: "transcription",
                    });
                    if (pendingXai) {
                      await selectAgentConnection.mutateAsync({
                        connectionId: "direct-xai",
                        capability: "transcription",
                      });
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

          {summary?.state === "disclosure_required" && summary.disclosure &&
            (!summaryDisclosureIsDeclined || reviewSummaryDisclosure) && (
            <div
              className="activate-disclosure"
              role="dialog"
              aria-labelledby="activate-summary-disclosure-title"
            >
              <h2 id="activate-summary-disclosure-title">
                {t("activation.summaryDisclosure.title", { provider: summaryProviderLabel })}
              </h2>
              <p>{t("activation.summaryDisclosure.privacy", { destination: summary.disclosure.destination })}</p>
              <div className="activate-actions">
                <button
                  type="button"
                  className="activate-action primary"
                  disabled={!summaryDisclosureConnectionId}
                  onClick={() => void run(async () => {
                    if (!summaryDisclosureConnectionId) throw new Error("Summary disclosure connection is unavailable");
                    await acceptAgentConnectionDisclosure.mutateAsync({
                      connectionId: summaryDisclosureConnectionId,
                      capability: "summary",
                    });
                    setSummaryDisclosureDeclined(false);
                    setReviewSummaryDisclosure(false);
                  })}
                >
                  {t("activation.summaryDisclosure.accept")}
                </button>
                <button
                  type="button"
                  className="activate-action"
                  disabled={!summaryDisclosureConnectionId}
                  onClick={() => void run(async () => {
                    if (!summaryDisclosureConnectionId) throw new Error("Summary disclosure connection is unavailable");
                    await declineAgentConnectionDisclosure.mutateAsync({
                      connectionId: summaryDisclosureConnectionId,
                      capability: "summary",
                    });
                    setSummaryDisclosureDeclined(true);
                    setReviewSummaryDisclosure(false);
                  })}
                >
                  {t("activation.disclosure.decline")}
                </button>
              </div>
            </div>
          )}

          {summaryDisclosureIsDeclined && !reviewSummaryDisclosure && summary && (
            <div className="activate-declined" role="alert">
              <p>{t("activation.summaryDisclosure.declined", { provider: summaryProviderLabel })}</p>
              <div className="activate-actions">
                <Link className="activate-action" to="/agent-connections?capability=summary">
                  {t("activation.summary.openSettings")}
                </Link>
                <button
                  type="button"
                  className="activate-action"
                  onClick={() => setReviewSummaryDisclosure(true)}
                >
                  {t("activation.summaryDisclosure.review")}
                </button>
              </div>
            </div>
          )}

          {summaryBlocker && summaryBlocker.reason !== "disclosure_required" &&
            summaryBlocker.reason !== "disclosure_declined" && (
            <div className="activate-blocker" role="alert">
              <p>{t(`activation.summary.blocker.${summaryBlocker.reason}`)}</p>
              <div className="activate-actions">
                <Link className="activate-action primary" to={summaryBlocker.remediation.href}>
                  {t("activation.summary.openSettings")}
                </Link>
                <button type="button" className="activate-action" onClick={() => void retrySummary()}>
                  {t("activation.summary.retry")}
                </button>
              </div>
            </div>
          )}

          <div className="activate-actions">
            {data?.nextStep === null && (
              <>
                <p className="activate-recording-guidance">{t("activation.attempt.duration")}</p>
                <button
                  type="button"
                  className="activate-action primary"
                  disabled={startAttempt.isPending}
                  onClick={() => void run(() => startAttempt.mutateAsync())}
                >
                  {t("activation.attempt.start")}
                </button>
              </>
            )}
            <Link className="activate-action" to="/agent-connections">
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

  if (activation.data.state !== "activated") return null;
  const activated = activation.data;
  const { evidence } = activated;
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

        {!activated.sourceArtifacts.audio && (
          <p className="activate-source-missing">{t("activation.sourceMissing.audio")}</p>
        )}
        {!activated.sourceArtifacts.transcript && (
          <p className="activate-source-missing">{t("activation.sourceMissing.transcript")}</p>
        )}
        {!activated.sourceArtifacts.summary && (
          <p className="activate-source-missing">{t("activation.sourceMissing.summary")}</p>
        )}

        <div className="activate-actions">
          {activated.completedNoteAvailable && (
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
          <Link className="activate-action" to="/agent-connections">{t("activation.action.providers")}</Link>
        </div>

        {noteOpen && activated.completedNote && (
          <div id="activate-completed-note" className="activate-completed-note">
            <MarkdownView text={activated.completedNote} />
          </div>
        )}
      </div>
    </section>
  );
}
