import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

type SourceSelection = { source: "macos" | "gog"; account: string | null };

export function CalendarSourceSection() {
  const t = useT();
  const utils = trpc.useUtils();
  const sources = trpc.integrations.calendarSources.useQuery(undefined, { retry: false });
  const onboarding = trpc.onboarding.status.useQuery(undefined, { retry: false });
  const selectSource = trpc.integrations.selectCalendarSource.useMutation();
  const probeSource = trpc.integrations.probeCalendarSource.useMutation();
  const adoptSource = trpc.onboarding.adoptCalendarSource.useMutation();
  const deferSource = trpc.onboarding.deferOptionalCapability.useMutation();
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const accounts = trpc.integrations.accountList.useQuery(undefined, {
    enabled: advancedOpen,
    retry: false,
  });
  const [account, setAccount] = useState("");
  const [selectionOverride, setSelectionOverride] = useState<SourceSelection | null>(null);
  const [readinessOverride, setReadinessOverride] = useState<Awaited<ReturnType<typeof probeSource.mutateAsync>> | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selection = selectionOverride ?? sources.data?.selectedSource ?? null;
  const readiness = readinessOverride ?? sources.data?.readiness;
  const outcome = onboarding.data?.optionalCapabilities.find((item) => item.id === "calendar-source")?.outcome ?? null;

  const refresh = async () => {
    await Promise.all([
      utils.integrations.calendarSources.invalidate(),
      utils.onboarding.status.invalidate(),
    ]);
  };
  const run = async <T,>(action: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setError(null);
    try {
      const result = await action();
      onSuccess?.(result);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  const choose = (next: SourceSelection) => void run(
    () => selectSource.mutateAsync(next),
    (result) => {
      setSelectionOverride(next);
      setReadinessOverride(result.readiness);
      if (result.restartErrors.length > 0) {
        setError(t("settings.calendarSource.restartFailed", { error: result.restartErrors.join("; ") }));
      }
    },
  );

  if (sources.isPending) return <section className="settings-section"><p>{t("settings.calendarSource.loading")}</p></section>;
  if (sources.isError || !sources.data) {
    return <section className="settings-section"><p role="alert">{t("settings.calendarSource.unavailable")}</p></section>;
  }

  return (
    <section className="settings-section calendar-source-section" id="calendar-source" aria-labelledby="calendar-source-heading">
      <div className="settings-section-head">
        <h2 className="settings-section-h" id="calendar-source-heading">{t("settings.calendarSource.heading")}</h2>
        <p className="settings-section-sub">{t("settings.calendarSource.sub")}</p>
      </div>

      <div className="calendar-source-outcome" data-outcome={outcome?.outcome ?? "pending"}>
        <strong>{t("settings.calendarSource.outcome")}</strong>
        <span>{outcome?.outcome === "adopted"
          ? t("settings.calendarSource.outcome.adopted")
          : outcome?.outcome === "deferred"
            ? t("settings.calendarSource.outcome.deferred")
            : t("settings.calendarSource.outcome.pending")}</span>
      </div>

      <article className="calendar-source-card" data-selected={selection?.source === "macos"}>
        <div>
          <span className="calendar-source-badge">{t("settings.calendarSource.recommended")}</span>
          <h3>{t("settings.calendarSource.macos.title")}</h3>
          <p>{t("settings.calendarSource.macos.detail")}</p>
          <small>{t("settings.calendarSource.macos.runtime")}</small>
        </div>
        <button type="button" onClick={() => choose({ source: "macos", account: null })} disabled={selectSource.isPending}>
          {t("settings.calendarSource.macos.use")}
        </button>
      </article>

      <button
        type="button"
        className="calendar-source-advanced-toggle"
        aria-expanded={advancedOpen}
        onClick={() => setAdvancedOpen((current) => !current)}
      >
        {advancedOpen ? t("settings.calendarSource.advanced.hide") : t("settings.calendarSource.advanced.show")}
      </button>

      {advancedOpen && (
        <article className="calendar-source-card" data-selected={selection?.source === "gog"}>
          <div>
            <span className="calendar-source-badge advanced">{t("settings.calendarSource.advanced.badge")}</span>
            <h3>{t("settings.calendarSource.gog.title")}</h3>
            <p>{t("settings.calendarSource.gog.detail")}</p>
            {!accounts.isPending && accounts.data?.ok && accounts.data.accounts.length > 0 && (
              <select aria-label={t("settings.calendarSource.gog.account")} value={account} onChange={(event) => setAccount(event.currentTarget.value)}>
                <option value="">{t("settings.calendarSource.gog.choose")}</option>
                {accounts.data.accounts.map((item) => <option key={item.email} value={item.email}>{item.email}</option>)}
              </select>
            )}
            {!accounts.isPending && accounts.data?.ok && accounts.data.accounts.length === 0 && (
              <div className="calendar-source-oauth-guidance">
                <small>{t("settings.calendarSource.gog.authorize")}</small>
                <code>{t("settings.calendarSource.gog.authorize.command")}</code>
              </div>
            )}
            {!accounts.isPending && !accounts.data?.ok && <small>{t("settings.calendarSource.gog.install")}</small>}
          </div>
          <button
            type="button"
            onClick={() => choose({ source: "gog", account })}
            disabled={selectSource.isPending || !account}
          >
            {t("settings.calendarSource.gog.use")}
          </button>
        </article>
      )}

      <div className="calendar-source-readiness" data-status={readiness?.status ?? "untested"}>
        <strong>{t("settings.calendarSource.readiness")}</strong>
        <span>{readiness?.detail ?? t("settings.calendarSource.readiness.untested")}</span>
        {readiness?.remediation && <small>{readiness.remediation}</small>}
        <button
          type="button"
          disabled={!selection || probeSource.isPending}
          onClick={() => void run(() => probeSource.mutateAsync(), setReadinessOverride)}
        >
          {t("settings.calendarSource.test")}
        </button>
      </div>

      {!outcome && (
        <div className="calendar-source-onboarding-actions">
          <button
            type="button"
            disabled={readiness?.status !== "ready" || adoptSource.isPending}
            onClick={() => void run(() => adoptSource.mutateAsync())}
          >
            {t("onboarding.action.adoptCalendarSource")}
          </button>
          <button
            type="button"
            disabled={deferSource.isPending}
            onClick={() => void run(() => deferSource.mutateAsync({ capability: "calendar-source" }))}
          >
            {t("settings.calendarSource.defer")}
          </button>
        </div>
      )}

      <aside className="calendar-source-connector-boundary">
        <strong>{t("settings.calendarSource.connector.title")}</strong>
        <p>{t("settings.calendarSource.connector.detail")}</p>
        <Link to="/agent-console">{t("settings.calendarSource.connector.open")}</Link>
      </aside>

      {error && <p role="alert" className="calendar-source-error">{error}</p>}
    </section>
  );
}
