import { useState } from "react";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

const FAILURE_LABELS = {
  runtime: "settings.agentCalendarConnector.failure.runtime",
  connector: "settings.agentCalendarConnector.failure.connector",
  authorization: "settings.agentCalendarConnector.failure.authorization",
  external_service: "settings.agentCalendarConnector.failure.externalService",
} as const;

export function AgentCalendarConnectorSection() {
  const t = useT();
  const utils = trpc.useUtils();
  const state = trpc.agentCalendarConnector.view.useQuery(undefined, { retry: false });
  const onboarding = trpc.onboarding.status.useQuery(undefined, { retry: false });
  const select = trpc.agentCalendarConnector.select.useMutation();
  const probe = trpc.agentCalendarConnector.probe.useMutation();
  const adopt = trpc.onboarding.adoptAgentCalendarConnector.useMutation();
  const defer = trpc.onboarding.deferOptionalCapability.useMutation();
  const [connectionIdOverride, setConnectionIdOverride] = useState<string | null>(null);
  const [connectorNameOverride, setConnectorNameOverride] = useState<string | null>(null);
  const [selectionOverride, setSelectionOverride] = useState(state.data?.selection ?? null);
  const [readinessOverride, setReadinessOverride] = useState(state.data?.readiness ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const selection = selectionOverride ?? state.data?.selection ?? null;
  const readiness = readinessOverride ?? state.data?.readiness;
  const connectionId = connectionIdOverride ?? state.data?.selection?.connectionId ?? "";
  const connectorName = connectorNameOverride ?? state.data?.selection?.connector ?? "calendar";
  const outcome = onboarding.data?.optionalCapabilities.find(
    (capability) => capability.id === "agent-calendar-connector",
  )?.outcome ?? null;
  const refresh = async () => {
    await Promise.all([
      utils.agentCalendarConnector.view.invalidate(),
      utils.onboarding.status.invalidate(),
    ]);
  };
  const run = async <T,>(action: () => Promise<T>, onSuccess?: (result: T) => void) => {
    setError(null);
    setBusy(true);
    try {
      const result = await action();
      onSuccess?.(result);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  if (state.isPending) {
    return <section className="settings-section"><p>{t("settings.agentCalendarConnector.loading")}</p></section>;
  }
  if (state.isError || !state.data) {
    return <section className="settings-section"><p role="alert">{t("settings.agentCalendarConnector.unavailable")}</p></section>;
  }

  const changed = selection?.connectionId !== connectionId || selection?.connector !== connectorName.trim();
  const status = changed ? "untested" : readiness?.status ?? "untested";
  const connect = () => run(async () => {
    if (changed) {
      const selected = await select.mutateAsync({ connectionId, connector: connectorName.trim() });
      setSelectionOverride(selected.selection);
      setReadinessOverride(selected.readiness);
    }
    const checked = await probe.mutateAsync();
    setSelectionOverride(checked.selection);
    setReadinessOverride(checked.readiness);
    // A different selection (for example from another window) must not be adopted.
    if (checked.selection?.connectionId !== connectionId || checked.selection?.connector !== connectorName.trim()) {
      throw new Error(t("settings.calendarSource.selectionChanged"));
    }
    if (checked.readiness.status === "ready") await adopt.mutateAsync();
  });

  return (
    <section
      className="settings-section agent-calendar-connector-section"
      id="agent-calendar-connector"
      aria-labelledby="agent-calendar-connector-heading"
    >
      <div className="settings-section-head">
        <h2 className="settings-section-h" id="agent-calendar-connector-heading">
          {t("settings.agentCalendarConnector.heading")}
        </h2>
        <p className="settings-section-sub">{t("settings.agentCalendarConnector.sub")}</p>
      </div>

      <p>{t("settings.agentCalendarConnector.safety")}</p>

      <div className="agent-calendar-connector-fields">
        <label>
          <span>{t("settings.agentCalendarConnector.connection")}</span>
          <select disabled={busy} value={connectionId} onChange={(event) => setConnectionIdOverride(event.currentTarget.value)}>
            <option value="">{t("settings.agentCalendarConnector.connection.choose")}</option>
            {state.data.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("settings.agentCalendarConnector.connector")}</span>
          <input
            disabled={busy}
            maxLength={100}
            value={connectorName}
            onChange={(event) => setConnectorNameOverride(event.currentTarget.value)}
            placeholder="google_calendar"
          />
        </label>
      </div>

      <div className="agent-calendar-connector-readiness" data-status={status}>
        <div className="settings-inline-actions">
          <span className={`sharing-badge ${status}`}>{t(`sharing.status.${status}`)}</span>
          <button className="settings-action" type="button"
            disabled={!connectionId || !connectorName.trim() || busy}
            onClick={() => void connect()}>
            {busy ? t("sharing.checking") : t("settings.agentCalendarConnector.connect")}
          </button>
        </div>
        {!changed && readiness?.status === "failed" && <div role="alert" className="calendar-source-error">
          {readiness.failure && <strong>{t(FAILURE_LABELS[readiness.failure])}</strong>}
          <p>{readiness.detail}</p>
          {readiness.remediation && <p>{readiness.remediation}</p>}
        </div>}
      </div>
      {!outcome && !selection && <button type="button" className="settings-text-link" disabled={busy}
        onClick={() => void run(() => defer.mutateAsync({ capability: "agent-calendar-connector" }))}>
        {t("settings.agentCalendarConnector.defer")}
      </button>}

      {error && <p role="alert" className="calendar-source-error">{error}</p>}
    </section>
  );
}
