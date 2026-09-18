import { useEffect, useState } from "react";
import { AdvancedDisclosure } from "../components/settings/AdvancedDisclosure.js";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./sharing.css";

export function SharingSettings() {
  const t = useT();
  const utils = trpc.useUtils();
  const view = trpc.sharing.view.useQuery();
  const [destination, setDestination] = useState("");
  const [receiptId, setReceiptId] = useState("");
  const [receiptUrl, setReceiptUrl] = useState("");
  const [error, setError] = useState("");
  const [connectionDraft, setConnectionDraft] = useState<string | null>(null);
  const [connectorDraft, setConnectorDraft] = useState<"notion" | "zulip" | null>(null);
  const [checking, setChecking] = useState(false);
  const refresh = () => { void utils.sharing.view.invalidate(); };
  const failed = (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause));
  const select = trpc.sharing.select.useMutation({ onSuccess: refresh, onError: failed });
  const discover = trpc.sharing.discover.useMutation({ onSuccess: refresh, onError: failed });
  const probe = trpc.sharing.probe.useMutation({ onSuccess: refresh, onError: failed });
  const save = trpc.sharing.saveDestination.useMutation({
    onSuccess: (saved) => { setDestination(saved.destination.value); refresh(); },
    onError: failed,
  });
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
  const connectionId = connectionDraft ?? data.selection?.connectionId ?? "";
  const connector = connectorDraft ?? data.selection?.connector ?? "notion";
  const selectionChanged = connectionId !== data.selection?.connectionId || connector !== data.selection?.connector;
  const busy = checking || select.isPending || probe.isPending || discover.isPending || save.isPending ||
    testShare.isPending || reconcileUnknown.isPending || abandonUnknown.isPending;
  const canSave = !selectionChanged && !busy && data.connectorReadiness.status === "ready" && destination.trim().length > 0;
  const canTest = canSave && data.destination.configured &&
    destination.trim() === data.destination.value && data.sharingReadiness.status !== "unknown";
  const checkConnection = async () => {
    setError("");
    setChecking(true);
    try {
      if (selectionChanged) await select.mutateAsync({ connectionId, connector });
      await probe.mutateAsync();
      await utils.sharing.view.invalidate();
    } catch (cause) {
      failed(cause);
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className="sharing-settings" aria-labelledby="sharing-settings-title">
      <header>
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
              disabled={busy}
              onChange={(event) => setConnectionDraft(event.target.value)}
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
              disabled={busy}
              onChange={(event) => setConnectorDraft(event.target.value as "notion" | "zulip")}
            >
              <option value="notion">Notion</option>
              <option value="zulip">Zulip</option>
            </select>
          </label>
        </div>
      )}

      <div className="sharing-check-row">
        <span className={`sharing-badge ${selectionChanged ? "untested" : data.connectorReadiness.status}`}>
          {t(`sharing.status.${selectionChanged ? "untested" : data.connectorReadiness.status}`)}
        </span>
        <button type="button" disabled={!connectionId || busy} onClick={() => void checkConnection()}>
          {checking ? t("sharing.checking") : t("sharing.check")}
        </button>
        <small>{t("sharing.checkHelp")}</small>
      </div>
      {!selectionChanged && data.connectorReadiness.status === "failed" && (
        <p className="sharing-error" role="alert">{data.connectorReadiness.detail} {data.connectorReadiness.remediation}</p>
      )}

      <div className="sharing-destination">
        <div className="sharing-section-heading">
          <h3>{t("sharing.destination.title")}</h3>
          <span className={`sharing-badge ${data.destination.configured ? "ready" : "untested"}`}>
            {data.destination.configured
              ? t("sharing.destination.configured")
              : t("sharing.destination.notConfigured")}
          </span>
        </div>
        <label>
          {t("sharing.destination.input")}
          <input
            aria-label={t("sharing.destination.input")}
            aria-describedby={connector === "notion" ? "sharing-notion-target-help" : undefined}
            placeholder={connector === "notion" ? t("sharing.destination.notionPlaceholder") : undefined}
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="none"
            disabled={busy}
            value={destination}
            maxLength={500}
            onChange={(event) => setDestination(event.target.value)}
          />
        </label>
        {connector === "notion" && <p id="sharing-notion-target-help">{t("sharing.destination.notionHelp")}</p>}
        <button
          type="button"
          disabled={!canSave || save.isPending}
          onClick={() => { setError(""); save.mutate({ destination: destination.trim() }); }}
        >
          {t("sharing.destination.save")}
        </button>
        <AdvancedDisclosure title={t("sharing.browseDestinations")} note="">
          <button type="button" disabled={!data.selection || selectionChanged || busy}
            onClick={() => { setError(""); discover.mutate(); }}>
            {discover.isPending ? t("sharing.checking") : t("sharing.discovery.action")}
          </button>
          {data.connectorDiscovery.status === "failed" && <p role="alert">{data.connectorDiscovery.detail} {data.connectorDiscovery.remediation}</p>}
          {data.connectorDiscovery.options.length > 0 && <label>
            {t("sharing.destination.suggestions")}
            <select value="" disabled={busy} onChange={(event) => setDestination(event.target.value)}>
              <option value="">{t("sharing.chooseDestination")}</option>
              {data.connectorDiscovery.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </label>}
        </AdvancedDisclosure>
      </div>

      <div className="sharing-test-share">
        <div className="sharing-section-heading">
          <h3>{t("sharing.testShare.title")}</h3>
          <span className={`sharing-badge ${data.sharingReadiness.status}`}>
            {t(`sharing.status.${data.sharingReadiness.status}`)}
          </span>
        </div>
        <p>{t("sharing.testShare.payload")}</p>
        {(testShare.isPending || reconcileUnknown.isPending) && (
          <p role="status">{t("sharing.testShare.pending")}</p>
        )}
        {["failed", "unknown"].includes(data.sharingReadiness.status) && <p role="alert">{data.sharingReadiness.detail}</p>}
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
