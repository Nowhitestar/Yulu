import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./sharing.css";

type Status = "untested" | "ready" | "failed" | "unknown";

export function SharingSettings() {
  const t = useT();
  const utils = trpc.useUtils();
  const view = trpc.sharing.view.useQuery();
  const [destination, setDestination] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [error, setError] = useState("");
  const refresh = () => { void utils.sharing.view.invalidate(); };
  const failed = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const select = trpc.sharing.select.useMutation({ onSuccess: refresh, onError: failed });
  const discover = trpc.sharing.discover.useMutation({ onSuccess: refresh, onError: failed });
  const probe = trpc.sharing.probe.useMutation({ onSuccess: refresh, onError: failed });
  const save = trpc.sharing.saveDestination.useMutation({ onSuccess: refresh, onError: failed });
  const testShare = trpc.sharing.testShare.useMutation({ onSuccess: refresh, onError: failed });
  const reconcileUnknown = trpc.sharing.reconcileUnknown.useMutation({ onSuccess: refresh, onError: failed });
  const abandonUnknown = trpc.sharing.abandonUnknown.useMutation({ onSuccess: refresh, onError: failed });

  useEffect(() => {
    if (view.data?.destination.value !== undefined) setDestination(view.data.destination.value);
  }, [view.data?.destination.value]);

  useEffect(() => {
    setReceiptId(view.data?.sharingReadiness.action?.receiptId ?? "");
    setReceiptUrl(view.data?.sharingReadiness.action?.receiptUrl ?? "");
  }, [view.data?.sharingReadiness.action]);

  if (view.isPending) return <div className="sharing-settings">{t("sharing.loading")}</div>;
  if (view.isError || !view.data) return <div className="sharing-settings sharing-error">{t("sharing.loadFailed")}</div>;

  const data = view.data;
  const connectionId = data.selection?.connectionId ?? "";
  const connector = data.selection?.connector ?? "notion";
  const canSave = data.connectorReadiness.status === "ready" && destination.trim().length > 0;
  const canTest = canSave && data.destination.configured &&
    destination.trim() === data.destination.value && data.sharingReadiness.status !== "unknown";
  const selectConfiguration = (nextConnectionId: string, nextConnector: "notion" | "zulip") => {
    setError("");
    if (nextConnectionId) select.mutate({ connectionId: nextConnectionId, connector: nextConnector });
  };

  return (
    <section className="sharing-settings" aria-labelledby="sharing-settings-title">
      <header>
        <p className="sharing-eyebrow">{t("sharing.eyebrow")}</p>
        <h2 id="sharing-settings-title">{t("sharing.title")}</h2>
        <p>{t("sharing.subtitle")}</p>
      </header>

      {error && <div className="sharing-error" role="alert">{t("sharing.actionFailed", { error })}</div>}
      {data.connections.length === 0 ? (
        <p className="sharing-error">{t("sharing.noConnections")}</p>
      ) : (
        <div className="sharing-selection">
          <label>
            {t("sharing.agentConnection")}
            <select
              aria-label={t("sharing.agentConnection")}
              value={connectionId}
              onChange={(event) => selectConfiguration(event.target.value, connector)}
            >
              <option value="">{t("sharing.agentConnection.choose")}</option>
              {data.connections.map((connection) => (
                <option key={connection.id} value={connection.id}>{connection.label}</option>
              ))}
            </select>
          </label>
          <label>
            {t("sharing.connector")}
            <select
              aria-label={t("sharing.connector")}
              value={connector}
              onChange={(event) => selectConfiguration(connectionId, event.target.value as "notion" | "zulip")}
            >
              <option value="notion">Notion</option>
              <option value="zulip">Zulip</option>
            </select>
          </label>
        </div>
      )}

      <div className="sharing-state-grid">
        <SharingState
          title={t("sharing.discovery.title")}
          status={data.connectorDiscovery.status}
          detail={data.connectorDiscovery.detail}
          remediation={data.connectorDiscovery.remediation}
          action={t("sharing.discovery.action")}
          disabled={!data.selection || discover.isPending}
          onAction={() => { setError(""); discover.mutate(); }}
          t={t}
        />
        <SharingState
          title={t("sharing.connectorReadiness.title")}
          status={data.connectorReadiness.status}
          detail={data.connectorReadiness.detail}
          remediation={data.connectorReadiness.remediation}
          action={t("sharing.connectorReadiness.action")}
          disabled={!data.selection || probe.isPending}
          onAction={() => { setError(""); probe.mutate(); }}
          t={t}
        />
      </div>

      <div className="sharing-destination">
        <div className="sharing-section-heading">
          <h3>{t("sharing.destination.title")}</h3>
          <span className={`sharing-badge ${data.destination.configured ? "ready" : "untested"}`}>
            {data.destination.configured
              ? t("sharing.destination.configured")
              : t("sharing.destination.notConfigured")}
          </span>
        </div>
        {data.connectorDiscovery.options.length > 0 && (
          <div className="sharing-suggestions" aria-label={t("sharing.destination.suggestions")}>
            {data.connectorDiscovery.options.map((option) => (
              <button key={option.value} type="button" onClick={() => setDestination(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
        )}
        <label>
          {t("sharing.destination.input")}
          <input
            aria-label={t("sharing.destination.input")}
            value={destination}
            maxLength={500}
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        <button
          type="button"
          disabled={!canSave || save.isPending}
          onClick={() => { setError(""); save.mutate({ destination: destination.trim() }); }}
        >
          {t("sharing.destination.save")}
        </button>
      </div>

      <div className="sharing-test-share">
        <div className="sharing-section-heading">
          <h3>{t("sharing.testShare.title")}</h3>
          <span className={`sharing-badge ${data.sharingReadiness.status}`}>
            {t(`sharing.status.${data.sharingReadiness.status}`)}
          </span>
        </div>
        <p>{t("sharing.testShare.payload")}</p>
        <p>{data.sharingReadiness.detail}</p>
        {data.sharingReadiness.remediation && <p className="sharing-remediation">{data.sharingReadiness.remediation}</p>}
        {data.sharingReadiness.receipt && (
          <p>{t("sharing.testShare.receipt", { id: data.sharingReadiness.receipt.id || data.sharingReadiness.receipt.url })}</p>
        )}
        {data.sharingReadiness.status === "unknown" && data.sharingReadiness.action && (
          <div className="sharing-unknown-reconciliation">
            <p>{t("sharing.unknown.action", { id: data.sharingReadiness.action.id })}</p>
            <label>
              {t("sharing.unknown.receiptId")}
              <input
                aria-label={t("sharing.unknown.receiptId")}
                value={receiptId}
                maxLength={500}
                onChange={(event) => setReceiptId(event.target.value)}
              />
            </label>
            <label>
              {t("sharing.unknown.receiptUrl")}
              <input
                aria-label={t("sharing.unknown.receiptUrl")}
                value={receiptUrl}
                maxLength={2_000}
                onChange={(event) => setReceiptUrl(event.target.value)}
              />
            </label>
            <div className="sharing-unknown-actions">
              <button
                type="button"
                disabled={(!receiptId.trim() && !receiptUrl.trim()) || reconcileUnknown.isPending}
                onClick={() => {
                  setError("");
                  reconcileUnknown.mutate({
                    actionId: data.sharingReadiness.action!.id,
                    receiptId: receiptId.trim(),
                    receiptUrl: receiptUrl.trim(),
                  });
                }}
              >
                {t("sharing.unknown.reconcile")}
              </button>
              <button
                type="button"
                disabled={abandonUnknown.isPending}
                onClick={() => {
                  setError("");
                  if (window.confirm(t("sharing.unknown.abandonConfirm"))) {
                    abandonUnknown.mutate({
                      actionId: data.sharingReadiness.action!.id,
                      confirmed: true,
                    });
                  }
                }}
              >
                {t("sharing.unknown.abandon")}
              </button>
            </div>
          </div>
        )}
        <button
          type="button"
          disabled={!canTest || testShare.isPending}
          onClick={() => {
            setError("");
            const duplicateConfirmed = data.sharingReadiness.duplicateWarningRequired;
            const prompt = duplicateConfirmed
              ? t("sharing.testShare.confirmDuplicate")
              : t("sharing.testShare.confirm");
            if (window.confirm(prompt)) {
              testShare.mutate({
                confirmed: true,
                actionId: crypto.randomUUID(),
                duplicateConfirmed,
              });
            }
          }}
        >
          {t("sharing.testShare.action")}
        </button>
      </div>
    </section>
  );
}

function SharingState({
  title,
  status,
  detail,
  remediation,
  action,
  disabled,
  onAction,
  t,
}: {
  title: string;
  status: Status;
  detail: string;
  remediation: string;
  action: string;
  disabled: boolean;
  onAction: () => void;
  t: (key: string) => string;
}) {
  return (
    <section className="sharing-state-card">
      <div className="sharing-section-heading">
        <h3>{title}</h3>
        <span className={`sharing-badge ${status}`}>{t(`sharing.status.${status}`)}</span>
      </div>
      <p>{detail}</p>
      {remediation && <p className="sharing-remediation">{remediation}</p>}
      <button type="button" disabled={disabled} onClick={onAction}>{action}</button>
    </section>
  );
}
