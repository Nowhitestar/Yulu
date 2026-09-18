import { useRef, useState } from "react";
import { CalendarDays, Check, ChevronDown } from "lucide-react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";

type SourceSelection = { source: "macos" | "gog"; account: string | null };

export function CalendarSourceSection() {
  const t = useT();
  const utils = trpc.useUtils();
  const sources = trpc.integrations.calendarSources.useQuery(undefined, { retry: false });
  const schedule = trpc.scheduler.overview.useQuery(undefined, { retry: false, refetchInterval: 30_000 });
  const selectSource = trpc.integrations.selectCalendarSource.useMutation();
  const probeSource = trpc.integrations.probeCalendarSource.useMutation();
  const adoptSource = trpc.onboarding.adoptCalendarSource.useMutation();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [googleOpen, setGoogleOpen] = useState(false);
  const accounts = trpc.integrations.accountList.useQuery(undefined, { enabled: googleOpen, retry: false });
  const [account, setAccount] = useState("");
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const selection = sources.data?.selectedSource;
  const readiness = sources.data?.readiness;

  const connect = async (next: SourceSelection, changeSource: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    setSuccess(false);
    try {
      if (changeSource) {
        const result = await selectSource.mutateAsync(next);
        utils.integrations.calendarSources.setData(undefined, (current) => current && ({
          ...current, selectedSource: result.selection, readiness: result.readiness,
        }));
        if (result.restartErrors.length) throw new Error(result.restartErrors.join("; "));
      }
      const result = await probeSource.mutateAsync();
      if (result.source !== next.source) {
        setError(t("settings.calendarSource.selectionChanged"));
        return;
      }
      utils.integrations.calendarSources.setData(undefined, (current) => current && ({ ...current, readiness: result }));
      if (result.status !== "ready") return;
      // Preserve the verified-adoption contract; never adopt a failed or stale probe.
      await adoptSource.mutateAsync();
      setSuccess(true);
      setPickerOpen(false);
      setGoogleOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      await Promise.allSettled([
        utils.integrations.calendarSources.invalidate(),
        utils.onboarding.status.invalidate(),
        utils.scheduler.overview.invalidate(),
      ]);
      setBusy(false);
      inFlight.current = false;
    }
  };

  if (sources.isPending) return <section className="settings-section"><p role="status">{t("settings.calendarSource.loading")}</p></section>;
  if (sources.isError || !sources.data) {
    return <section className="settings-section"><p role="alert">{t("settings.calendarSource.unavailable")}</p><button className="settings-action" onClick={() => void sources.refetch()}>{t("settings.retry")}</button></section>;
  }

  const status = busy ? "checking" : readiness?.status ?? "untested";
  const sourceLabel = selection ? t(`settings.calendarSource.${selection.source}.title`) : t("settings.calendarSource.notConnected");
  const updatedAt = schedule.data?.updatedAt;
  const updateDate = updatedAt ? new Date(updatedAt) : null;
  const validUpdate = updateDate && Number.isFinite(updateDate.getTime());
  const stopped = schedule.data && (!schedule.data.schedulerStatus?.pid || !schedule.data.calendarStatus?.pid);
  const stale = validUpdate && Date.now() - updateDate.getTime() > 10 * 60_000;
  const reasonKey = selection?.source === "gog" && readiness?.reason?.startsWith("authorization_")
    ? "settings.calendarSource.failure.google_authorization"
    : `settings.calendarSource.failure.${readiness?.reason ?? "enumeration_failed"}`;

  return (
    <section className="settings-section calendar-source-section" id="calendar-source" aria-labelledby="calendar-source-heading" aria-busy={busy}>
      <h2 className="settings-section-h" id="calendar-source-heading">{t("settings.calendarSource.heading")}</h2>
      <p className="settings-section-sub">{t("settings.calendarSource.sub")}</p>

      <div className="calendar-connection" data-status={status}>
        <CalendarDays size={24} strokeWidth={1.5} aria-hidden="true" />
        <div className="calendar-connection-copy">
          <strong>{sourceLabel}</strong>
          {selection?.account && <span className="calendar-account">{selection.account}</span>}
          <span className="calendar-status" role="status"><i aria-hidden="true" />{selection ? t(`settings.calendarSource.status.${status}`) : t("settings.calendarSource.chooseHint")}</span>
        </div>
        {selection && <button className="settings-action" disabled={busy} onClick={() => void connect(selection, readiness?.reason === "service_activation_failed")}>{t("settings.calendarSource.test")}</button>}
      </div>

      {selection && <div className="calendar-sync" aria-live="polite">
        <span>{schedule.isError ? t("settings.calendarSource.sync.unavailable") : validUpdate
          ? t("settings.calendarSource.sync.updated", { time: updateDate.toLocaleString() })
          : t("settings.calendarSource.sync.pending")}</span>
        {(stopped || stale) && <span className="calendar-sync-warning">{t(stopped ? "settings.calendarSource.sync.stopped" : "settings.calendarSource.sync.stale")} <Link to="/health#scheduler">{t("settings.diagnostics.open")}</Link></span>}
      </div>}

      {success && <p className="calendar-success" role="status"><Check size={16} />{t("settings.calendarSource.success")}</p>}
      {(error || readiness?.status === "failed") && <div className="calendar-source-error" role="alert">
        {t(error ? "settings.calendarSource.actionFailed" : reasonKey)}
      </div>}

      {selection && <button className="settings-text-link calendar-source-advanced-toggle" aria-expanded={pickerOpen} disabled={busy} onClick={() => setPickerOpen((open) => !open)}>
        {t("settings.calendarSource.change")}<ChevronDown size={14} aria-hidden="true" />
      </button>}

      {(!selection || pickerOpen) && <div className="calendar-source-picker">
        <div className="calendar-source-option">
          <div><strong>{t("settings.calendarSource.macos.title")}</strong><p>{t("settings.calendarSource.macos.detail")}</p></div>
          <button className="settings-action primary" disabled={busy} onClick={() => void connect({ source: "macos", account: null }, true)}>{t("settings.calendarSource.macos.use")}</button>
        </div>
        <button className="settings-text-link" aria-expanded={googleOpen} disabled={busy} onClick={() => setGoogleOpen((open) => !open)}>
          {t("settings.calendarSource.advanced.show")}<ChevronDown size={14} aria-hidden="true" />
        </button>
        {googleOpen && <div className="calendar-source-option calendar-google-option">
          <p>{t("settings.calendarSource.gog.detail")}</p>
          {accounts.isPending ? <p role="status">{t("settings.calendarSource.accounts.loading")}</p> : accounts.data?.ok ? <>
            {accounts.data.accounts.length ? <label className="calendar-account-picker">
              {t("settings.calendarSource.gog.account")}
              <select disabled={busy} value={account} onChange={(event) => setAccount(event.currentTarget.value)}>
                <option value="">{t("settings.calendarSource.gog.choose")}</option>
                {accounts.data.accounts.map((item) => <option key={item.email} value={item.email}>{item.email}</option>)}
              </select>
            </label> : <div className="calendar-source-oauth-guidance"><p>{t("settings.calendarSource.gog.authorize")}</p><code>{t("settings.calendarSource.gog.authorize.command")}</code></div>}
            <button className="settings-action primary" disabled={busy || !account} onClick={() => void connect({ source: "gog", account }, true)}>{t("settings.calendarSource.gog.use")}</button>
          </> : <p>{t("settings.calendarSource.gog.install")}</p>}
          <button className="settings-text-link" disabled={busy || accounts.isFetching} onClick={() => void accounts.refetch()}>{t("settings.calendarSource.accounts.refresh")}</button>
        </div>}
      </div>}

      <AdvancedDisclosure title={t("settings.calendarSource.details")} note="">
        <p>{readiness?.detail}</p>
        {readiness?.remediation && <p>{readiness.remediation}</p>}
        {error && <p className="calendar-source-error">{error}</p>}
        <p>{t("settings.calendarSource.connector.detail")} <Link to="/settings/connections#agent-calendar-connector">{t("settings.calendarSource.connector.open")}</Link></p>
      </AdvancedDisclosure>
    </section>
  );
}
