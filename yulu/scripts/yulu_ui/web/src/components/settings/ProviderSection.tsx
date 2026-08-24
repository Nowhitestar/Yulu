import { useState } from "react";
import { Link } from "react-router";
import { XAI_TEXT_MODEL_DEFAULT } from "../../../../src/settingsRegistry.js";
import { trpc } from "../../trpc.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

type TextCapability = "summary" | "conversation";
type Capability = "transcription" | TextCapability;

export function ProviderSection({ tracker }: { tracker: SettingsRestartTracker }) {
  const { data: config } = trpc.config.get.useQuery();
  const providers = trpc.providers.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.connection.authorization.status === "running" ? 1_000 : 5_000,
  });
  const utils = trpc.useUtils();
  const refresh = async () => { await utils.providers.status.invalidate(); };
  const authorize = trpc.providers.authorize.useMutation({ onSettled: refresh });
  const cancelAuthorization = trpc.providers.cancelAuthorization.useMutation({ onSettled: refresh });
  const logoutOAuth = trpc.providers.logoutOAuth.useMutation({ onSettled: refresh });
  const setApiKey = trpc.providers.setApiKey.useMutation({ onSettled: refresh });
  const clearApiKey = trpc.providers.clearApiKey.useMutation({ onSettled: refresh });
  const probe = trpc.providers.probe.useMutation({ onSettled: refresh });
  const { commit } = useConfigField(tracker);
  const [apiKey, setApiKeyValue] = useState("");
  const t = useT();

  if (!config) return null;
  const connection = providers.data?.connection;
  const authorization = connection?.authorization;
  const authorizing = authorization?.status === "starting" || authorization?.status === "running";

  const startAuthorization = () => {
    const authorizationWindow = window.open("about:blank", "_blank");
    if (authorizationWindow) authorizationWindow.opener = null;
    authorize.mutate(undefined, {
      onSuccess: (state) => {
        if (!state.verificationUrl) {
          authorizationWindow?.close();
          return;
        }
        if (authorizationWindow) authorizationWindow.location.href = state.verificationUrl;
        else window.open(state.verificationUrl, "_blank", "noopener,noreferrer");
      },
      onError: () => authorizationWindow?.close(),
    });
  };

  const selectTextProvider = (capability: TextCapability, provider: "agent" | "xai") => {
    void commit(`intelligence.${capability}`)(provider === "xai"
      ? { provider: "xai", model: XAI_TEXT_MODEL_DEFAULT }
      : { provider: "agent", model: "runtime-managed" });
  };

  const selectTextModel = (capability: TextCapability, model: string) => {
    const trimmed = model.trim();
    if (trimmed) void commit(`intelligence.${capability}`)({ provider: "xai", model: trimmed });
  };

  return (
    <section id="providers" className="settings-section">
      <h2 className="settings-section-h">{t("settings.providers.heading")}</h2>
      <p className="settings-section-sub">{t("settings.providers.sub")}</p>

      <div className="provider-choice-list">
        <div className="provider-choice-row">
          <div>
            <label htmlFor="provider-transcription">{t("settings.providers.capability.transcription")}</label>
            <div className="row-help">{t("settings.providers.capability.transcriptionHelp")}</div>
          </div>
          <div className="provider-choice-controls">
            <select
              id="provider-transcription"
              className="value-input"
              value={config.transcription.engine}
              onChange={(event) => void commit("transcription.engine")(event.target.value)}
            >
              <option value="local">{t("settings.providers.provider.local")}</option>
              <option value="xai">xAI</option>
            </select>
            <Link to="/settings/transcription">{t("settings.providers.openTranscription")}</Link>
          </div>
        </div>
        {(["summary", "conversation"] as const).map((capability) => {
          const selection = config.intelligence[capability];
          const label = t(`settings.providers.capability.${capability}`);
          return (
            <div className="provider-choice-row" key={capability}>
              <div>
                <label htmlFor={`provider-${capability}`}>{label}</label>
                <div className="row-help">
                  {selection.provider === "agent"
                    ? t("settings.providers.runtimeManaged")
                    : t("settings.providers.exactModel")}
                </div>
              </div>
              <div className="provider-choice-controls">
                <select
                  id={`provider-${capability}`}
                  className="value-input"
                  value={selection.provider}
                  onChange={(event) => selectTextProvider(capability, event.target.value as "agent" | "xai")}
                >
                  <option value="agent">{t("settings.providers.provider.agent")}</option>
                  <option value="xai">xAI</option>
                </select>
                {selection.provider === "xai" && (
                  <input
                    className="value-input provider-model-input"
                    aria-label={t("settings.providers.model", { capability: label })}
                    defaultValue={selection.model}
                    maxLength={128}
                    onBlur={(event) => selectTextModel(capability, event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") selectTextModel(capability, event.currentTarget.value);
                    }}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="local-caption-card provider-connection-card" data-installed={connection?.connected ? "true" : "false"}>
        <div className="local-caption-head">
          <div>
            <div className="local-caption-title">{t("settings.providers.connection.title")}</div>
            <div className="local-caption-sub">{t("settings.providers.connection.sub")}</div>
          </div>
          <span className={`provider-state ${connection?.connected ? "provider-state--ok" : "provider-state--muted"}`}>
            {connection?.connected
              ? t("settings.providers.connection.source", {
                  source: connection.source === "oauth" ? "Grok OAuth" : "API Key",
                })
              : t("settings.providers.connection.disconnected")}
          </span>
        </div>

        <div className="provider-status-note">{t("settings.providers.connection.oauthHelp")}</div>
        {authorizing && (
          <div className="provider-status-note" role="status">
            {t("settings.providers.connection.authorizing")}
            {authorization?.verificationUrl && (
              <> · <a href={authorization.verificationUrl} target="_blank" rel="noreferrer">{t("settings.providers.connection.openAuthorization")}</a></>
            )}
            {authorization?.userCode && <> · {t("settings.providers.connection.code")} <code>{authorization.userCode}</code></>}
          </div>
        )}
        {(providers.error || authorize.error || cancelAuthorization.error || logoutOAuth.error || setApiKey.error || clearApiKey.error || authorization?.status === "failed") && (
          <div className="provider-status-note provider-status-note--bad" role="alert">
            {providers.error?.message || authorize.error?.message || cancelAuthorization.error?.message || logoutOAuth.error?.message || setApiKey.error?.message || clearApiKey.error?.message || authorization?.message}
          </div>
        )}

        <div className="local-caption-actions">
          {authorizing ? (
            <button type="button" className="path-btn" disabled={cancelAuthorization.isPending} onClick={() => cancelAuthorization.mutate()}>
              {t("settings.providers.connection.cancel")}
            </button>
          ) : (
            <button type="button" className="path-btn local-caption-primary" disabled={authorize.isPending} onClick={startAuthorization}>
              {connection?.oauthConnected
                ? t("settings.providers.connection.reconnect")
                : t("settings.providers.connection.connect")}
            </button>
          )}
          {connection?.oauthConnected && !authorizing && (
            <button
              type="button"
              className="path-btn"
              disabled={logoutOAuth.isPending}
              onClick={() => {
                if (window.confirm(t("settings.providers.connection.logoutConfirm"))) logoutOAuth.mutate();
              }}
            >
              {t("settings.providers.connection.logout")}
            </button>
          )}
        </div>

        <form
          className="provider-api-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            setApiKey.mutate({ apiKey }, { onSuccess: () => setApiKeyValue("") });
          }}
        >
          <strong>{t("settings.providers.apiKey.alternative")}</strong>
          <label htmlFor="provider-xai-api-key">{t("settings.providers.apiKey.label")}</label>
          <div className="provider-api-key-controls">
            <input
              id="provider-xai-api-key"
              type="password"
              autoComplete="new-password"
              value={apiKey}
              maxLength={4_096}
              onChange={(event) => setApiKeyValue(event.target.value)}
            />
            <button type="submit" className="path-btn" disabled={!apiKey.trim() || setApiKey.isPending}>
              {t("settings.providers.apiKey.save")}
            </button>
            {connection?.apiKeyConfigured && (
              <button
                type="button"
                className="path-btn"
                disabled={clearApiKey.isPending}
                onClick={() => {
                  if (window.confirm(t("settings.providers.apiKey.removeConfirm"))) clearApiKey.mutate();
                }}
              >
                {t("settings.providers.apiKey.remove")}
              </button>
            )}
          </div>
          <div className="provider-install-hint">{t("settings.providers.apiKey.help")}</div>
          {connection?.oauthConnected && (
            <div className="provider-install-hint">{t("settings.providers.apiKey.oauthPriority")}</div>
          )}
        </form>
      </div>

      <div className="provider-readiness-list">
        <h3>{t("settings.providers.readiness.title")}</h3>
        {(["transcription", "summary", "conversation"] as const).map((capability) => {
          const readiness = providers.data?.readiness[capability];
          const isTesting = probe.isPending && probe.variables?.capability === capability;
          const status = isTesting ? "testing" : readiness?.status ?? "untested";
          const label = t(`settings.providers.capability.${capability}`);
          return (
            <div className="provider-readiness-row" data-testid={`provider-readiness-${capability}`} key={capability}>
              <div>
                <div className="local-caption-title">{label}</div>
                <div
                  className={`provider-readiness-status ${status === "failed" ? "provider-readiness-status--bad" : ""}`}
                  role={status === "failed" ? "alert" : "status"}
                >
                  {status === "failed"
                    ? t("settings.providers.readiness.failedDetail", {
                        capability: label,
                        model: readiness?.model ?? "",
                      })
                    : t(`settings.providers.readiness.${status}`)}
                  {readiness?.testedAt && (
                    <> · <span className="provider-readiness-meta">{readiness.testedAt.slice(0, 16).replace("T", " ")} · {readiness.model}</span></>
                  )}
                </div>
              </div>
              <button
                type="button"
                className="path-btn"
                disabled={!connection?.connected || authorizing || probe.isPending}
                onClick={() => probe.mutate({ capability })}
              >
                {isTesting
                  ? t("settings.providers.readiness.testing")
                  : status === "ready" || status === "failed"
                    ? t("settings.providers.readiness.testAgain")
                    : t(`settings.providers.readiness.test.${capability}`)}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
