import { useState } from "react";
import { CheckCircle2, Circle, Sparkles } from "lucide-react";
import { Link } from "react-router";
import { useT } from "../i18n/LanguageProvider.js";
import { trpc } from "../trpc.js";
import "./onboarding.css";

export const handle = { breadcrumb: "nav.onboarding", filters: null };

const CAPABILITY_LABELS = {
  conversation: "onboarding.capability.conversation",
  "calendar-source": "onboarding.capability.calendarSource",
  "agent-calendar-connector": "onboarding.capability.agentCalendarConnector",
  sharing: "onboarding.capability.sharing",
} as const;

const READINESS_LABELS = {
  ready: "onboarding.readiness.ready",
  needs_attention: "onboarding.readiness.needsAttention",
  not_tested: "onboarding.readiness.notTested",
  unavailable: "onboarding.readiness.unavailable",
} as const;

export function OnboardingHome() {
  const t = useT();
  const home = trpc.onboarding.status.useQuery(undefined, { retry: false });
  const adoptConversation = trpc.onboarding.adoptConversation.useMutation();
  const deferOptional = trpc.onboarding.deferOptionalCapability.useMutation();
  const deferActivation = trpc.onboarding.deferActivationJourney.useMutation();
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      await utils.onboarding.status.invalidate();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (home.isPending) return <div className="onboarding-state" role="status">{t("onboarding.loading")}</div>;
  if (home.isError || !home.data) {
    return <div className="onboarding-state" role="alert">{t("onboarding.unavailable")}</div>;
  }

  const data = home.data;
  const completionText = data.completion.currentVersionCompleted
    ? t("onboarding.completion.current")
    : data.completion.completed
      ? t("onboarding.completion.previous")
      : t("onboarding.completion.incomplete");

  return (
    <section className="onboarding-page" aria-labelledby="onboarding-title">
      <header className="onboarding-header">
        <span className="onboarding-eyebrow">{t("onboarding.eyebrow")}</span>
        <h1 id="onboarding-title">{t("onboarding.title")}</h1>
        <p>{t("onboarding.subtitle")}</p>
        <div className="onboarding-completion" data-current={data.completion.currentVersionCompleted}>
          {data.completion.completed ? <CheckCircle2 size={18} aria-hidden="true" /> : <Circle size={18} aria-hidden="true" />}
          <span>{completionText}</span>
          <small>{data.version}</small>
        </div>
      </header>

      <article className="onboarding-card onboarding-core" data-testid="onboarding-core-activation">
        <div className="onboarding-card-heading">
          <div>
            <span className="onboarding-step-kind">{t("onboarding.required")}</span>
            <h2>{t("onboarding.core.title")}</h2>
          </div>
          <span className="onboarding-outcome" data-outcome={data.coreActivation.completed ? "adopted" : "pending"}>
            {data.coreActivation.completed ? t("onboarding.core.complete") : t("onboarding.core.incomplete")}
          </span>
        </div>
        <p>{data.coreActivation.completed
          ? t("onboarding.core.completeBody")
          : data.coreActivation.attempt
            ? t("onboarding.core.resumeBody")
            : t("onboarding.core.incompleteBody")}</p>
        <div className="onboarding-actions">
          <Link className="onboarding-action primary" to={data.coreActivation.href}>
            {data.coreActivation.completed
              ? t("onboarding.action.review")
              : data.coreActivation.attempt
                ? t("onboarding.action.resume")
                : t("onboarding.action.start")}
          </Link>
          {!data.coreActivation.completed && (
            <button
              type="button"
              className="onboarding-action"
              disabled={deferActivation.isPending}
              onClick={() => void run(() => deferActivation.mutateAsync())}
            >
              {t("onboarding.action.deferActivation")}
            </button>
          )}
        </div>
      </article>

      <div className="onboarding-grid">
        {data.optionalCapabilities.map((capability) => {
          const durableState = capability.outcome?.outcome ?? (capability.isNew ? "new" : "pending");
          return (
            <article
              className="onboarding-card"
              key={capability.id}
              data-testid={`onboarding-capability-${capability.id}`}
            >
              <div className="onboarding-card-heading">
                <div>
                  <span className="onboarding-step-kind">{t("onboarding.optional")}</span>
                  <h2>{t(CAPABILITY_LABELS[capability.id])}</h2>
                </div>
                <span className="onboarding-outcome" data-outcome={durableState}>
                  {capability.isNew && !capability.outcome && <Sparkles size={14} aria-hidden="true" />}
                  {t(`onboarding.outcome.${durableState}`)}
                </span>
              </div>

              <div className="onboarding-readiness" data-state={capability.readiness.state}>
                <strong>{t("onboarding.readiness.label", {
                  state: t(READINESS_LABELS[capability.readiness.state]),
                })}</strong>
                <span>{capability.readiness.detail}</span>
              </div>

              <div className="onboarding-actions">
                {capability.href && (
                  <Link className="onboarding-action primary" to={capability.href}>
                    {t("onboarding.action.open")}
                  </Link>
                )}
                {capability.id === "conversation" && !capability.outcome && (
                  <button
                    type="button"
                    className="onboarding-action"
                    disabled={adoptConversation.isPending}
                    onClick={() => void run(() => adoptConversation.mutateAsync())}
                  >
                    {t("onboarding.action.adoptConversation")}
                  </button>
                )}
                {!capability.outcome && (
                  <button
                    type="button"
                    className="onboarding-action"
                    disabled={deferOptional.isPending}
                    onClick={() => void run(() => deferOptional.mutateAsync({ capability: capability.id }))}
                  >
                    {t("onboarding.action.defer")}
                  </button>
                )}
              </div>
            </article>
          );
        })}
      </div>

      {error && <p className="onboarding-error" role="alert">{t("onboarding.actionFailed", { error })}</p>}
    </section>
  );
}
