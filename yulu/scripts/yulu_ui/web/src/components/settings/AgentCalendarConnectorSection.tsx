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
    try {
      const result = await action();
      onSuccess?.(result);
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (state.isPending) {
    return <section className="settings-section"><p>{t("settings.agentCalendarConnector.loading")}</p></section>;
  }
  if (state.isError || !state.data) {
    return <section className="settings-section"><p role="alert">{t("settings.agentCalendarConnector.unavailable")}</p></section>;
  }

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
          <select value={connectionId} onChange={(event) => setConnectionIdOverride(event.currentTarget.value)}>
            <option value="">{t("settings.agentCalendarConnector.connection.choose")}</option>
            {state.data.connections.map((connection) => (
              <option key={connection.id} value={connection.id}>{connection.label}</option>
            ))}
          </select>
        </label>
        <label>
          <span>{t("settings.agentCalendarConnector.connector")}</span>
          <input
            value={connectorName}
            onChange={(event) => setConnectorNameOverride(event.currentTarget.value)}
            placeholder="google_calendar"
          />
        </label>
        <button
          type="button"
          disabled={!connectionId || !connectorName.trim() || select.isPending}
          onClick={() => void run(
            () => select.mutateAsync({ connectionId, connector: connectorName.trim() }),
            (result) => {
              setSelectionOverride(result.selection);
              setReadinessOverride(result.readiness);
            },
          )}
        >
          {t("settings.agentCalendarConnector.select")}
        </button>
      </div>

      <div className="agent-calendar-connector-readiness" data-status={readiness?.status ?? "untested"}>
        <strong>{t("settings.agentCalendarConnector.readiness")}</strong>
        {readiness?.failure && <span>{t(FAILURE_LABELS[readiness.failure])}</span>}
        <span>{readiness?.detail ?? t("settings.agentCalendarConnector.readiness.untested")}</span>
        {readiness?.remediation && <small>{readiness.remediation}</small>}
        <button
          type="button"
          disabled={!selection || probe.isPending}
          onClick={() => void run(() => probe.mutateAsync(), (result) => setReadinessOverride(result.readiness))}
        >
          {t("settings.agentCalendarConnector.probe")}
        </button>
      </div>

      {!outcome && (
        <div className="agent-calendar-connector-actions">
          <button
            type="button"
            disabled={readiness?.status !== "ready" || adopt.isPending}
            onClick={() => void run(() => adopt.mutateAsync())}
          >
            {t("onboarding.action.adoptAgentCalendarConnector")}
          </button>
          <button
            type="button"
            disabled={defer.isPending}
            onClick={() => void run(() => defer.mutateAsync({ capability: "agent-calendar-connector" }))}
          >
            {t("settings.agentCalendarConnector.defer")}
          </button>
        </div>
      )}

      {error && <p role="alert" className="calendar-source-error">{error}</p>}
    </section>
  );
}
