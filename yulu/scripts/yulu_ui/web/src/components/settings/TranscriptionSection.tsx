import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface TranscriptionSectionProps {
  tracker: SettingsRestartTracker;
}

export function TranscriptionSection({ tracker }: TranscriptionSectionProps) {
  const { data: config } = trpc.config.get.useQuery();
  const local = trpc.localCaption.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.operation !== "idle" ? 1_000 : 5_000,
  });
  const xai = trpc.xaiAudio.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.authorization.status === "running" ? 1_000 : 5_000,
  });
  const utils = trpc.useUtils();
  const refreshLocal = async () => { await utils.localCaption.status.invalidate(); };
  const refreshXai = async () => { await utils.xaiAudio.status.invalidate(); };
  const install = trpc.localCaption.install.useMutation({ onSettled: refreshLocal });
  const uninstall = trpc.localCaption.uninstall.useMutation({ onSettled: refreshLocal });
  const testModel = trpc.localCaption.test.useMutation({ onSettled: refreshLocal });
  const authorizeXai = trpc.xaiAudio.authorize.useMutation({ onSettled: refreshXai });
  const cancelXaiAuthorization = trpc.xaiAudio.cancelAuthorization.useMutation({ onSettled: refreshXai });
  const logoutXai = trpc.xaiAudio.logout.useMutation({ onSettled: refreshXai });
  const testXai = trpc.xaiAudio.test.useMutation({ onSettled: refreshXai });
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();
  const localBusy = (local.data?.operation ?? "idle") !== "idle"
    || install.isPending || uninstall.isPending || testModel.isPending;
  const xaiAuthorizing = xai.data?.authorization.status === "starting"
    || xai.data?.authorization.status === "running";

  const startXaiAuthorization = () => {
    const authorizationWindow = window.open("about:blank", "_blank");
    if (authorizationWindow) authorizationWindow.opener = null;
    authorizeXai.mutate(undefined, {
      onSuccess: (authorization) => {
        if (!authorization.verificationUrl) {
          authorizationWindow?.close();
          return;
        }
        if (authorizationWindow) authorizationWindow.location.href = authorization.verificationUrl;
        else window.open(authorization.verificationUrl, "_blank", "noopener,noreferrer");
      },
      onError: () => authorizationWindow?.close(),
    });
  };

  if (!config) return null;

  return (
    <section id="transcription" className="settings-section">
      <h2 className="settings-section-h">{t("settings.transcription.heading")}</h2>
      <p className="settings-section-sub">{t("settings.transcription.sub")}</p>

      <InlineEditRow
        label={t("settings.transcription.engine.label")}
        help={t("settings.transcription.engine.help")}
        type="select"
        value={config.transcription.engine ?? "local"}
        options={[
          { value: "local", label: t("settings.transcription.engine.local") },
          { value: "xai", label: t("settings.transcription.engine.xai") },
        ]}
        onCommit={commit("transcription.engine") as (value: string) => void}
        disabled={isBlocked("transcription.engine")}
        status={tracker.statusFor("transcription.engine")}
      />

      <InlineEditRow
        label={t("settings.transcription.language.label")}
        help={t("settings.transcription.language.help")}
        type="select"
        value={config.transcription.language ?? "auto"}
        options={[
          { value: "zh", label: "zh" },
          { value: "en", label: "en" },
          { value: "ja", label: "ja" },
          { value: "auto", label: "auto" },
        ]}
        onCommit={commit("transcription.language") as (value: string) => void}
        disabled={isBlocked("transcription.language")}
        status={tracker.statusFor("transcription.language")}
      />

      <div className="local-caption-card" data-installed={local.data?.installed ? "true" : "false"}>
        <div className="local-caption-head">
          <div>
            <div className="local-caption-title">{t("settings.transcription.localModel.title")}</div>
            <div className="local-caption-sub">{t("settings.transcription.localModel.sub")}</div>
          </div>
          <span className={`provider-state ${local.data?.ready ? "provider-state--ok" : "provider-state--muted"}`}>
            {local.data?.ready
              ? t("settings.transcription.localModel.installed")
              : local.data?.installed
                ? t("settings.transcription.localModel.needsAttention")
                : t("settings.transcription.localModel.notInstalled")}
          </span>
        </div>

        <div className="local-caption-stats">
          <div><span>{t("settings.transcription.localModel.latency")}</span><strong>&lt; 1s</strong></div>
          <div><span>{t("settings.transcription.localModel.runtime")}</span><strong>CPU · INT8</strong></div>
          <div><span>{t("settings.transcription.localModel.disk")}</span><strong>{formatBytes((local.data?.runtimeBytes ?? 0) + (local.data?.modelBytes ?? 0))}</strong></div>
        </div>

        {local.data?.operation !== "idle" && (
          <div className="local-caption-progress" role="status">
            <div className="local-caption-progress-track">
              <span style={{ width: `${local.data?.percent ?? 12}%` }} />
            </div>
            <span>{local.data?.message || t("common.loading")}</span>
          </div>
        )}

        {(local.data?.error || install.error || uninstall.error || testModel.error) && (
          <div className="provider-status-note provider-status-note--bad" role="alert">
            {local.data?.error || install.error?.message || uninstall.error?.message || testModel.error?.message}
          </div>
        )}
        {local.data?.message && local.data.operation === "idle" && !local.data.error && (
          <div className="provider-status-note">{local.data.message}</div>
        )}

        <div className="local-caption-actions">
          {!local.data?.installed ? (
            <button type="button" className="path-btn local-caption-primary" disabled={localBusy} onClick={() => install.mutate()}>
              {install.isPending ? t("settings.transcription.localModel.installing") : t("settings.transcription.localModel.install")}
            </button>
          ) : (
            <>
              <button type="button" className="path-btn" disabled={localBusy} onClick={() => testModel.mutate()}>
                {testModel.isPending ? t("settings.transcription.localModel.testing") : t("settings.transcription.localModel.test")}
              </button>
              <button
                type="button"
                className="path-btn"
                disabled={localBusy || local.data.sessionActive}
                onClick={() => {
                  if (window.confirm(t("settings.transcription.localModel.uninstallConfirm"))) uninstall.mutate();
                }}
              >
                {t("settings.transcription.localModel.uninstall")}
              </button>
            </>
          )}
        </div>
        {!local.data?.installed && (
          <div className="provider-install-hint">{t("settings.transcription.localModel.installHint")}</div>
        )}
        {local.data?.sessionActive && (
          <div className="provider-install-hint">{t("settings.transcription.localModel.uninstallAfterRecording")}</div>
        )}
      </div>

      <div className="local-caption-card" data-installed={xai.data?.connected ? "true" : "false"}>
        <div className="local-caption-head">
          <div>
            <div className="local-caption-title">{t("settings.transcription.xai.title")}</div>
            <div className="local-caption-sub">{t("settings.transcription.xai.sub")}</div>
          </div>
          <span className={`provider-state ${xai.data?.connected ? "provider-state--ok" : "provider-state--muted"}`}>
            {xai.data?.connected
              ? t("settings.transcription.xai.connected")
              : t("settings.transcription.xai.unavailable")}
          </span>
        </div>

        {xai.data?.detail && !xaiAuthorizing && (
          <div className="provider-status-note">{xai.data.detail}</div>
        )}
        {xaiAuthorizing && (
          <div className="provider-status-note" role="status">
            {xai.data?.authorization.message}
            {xai.data?.authorization.verificationUrl && (
              <> · <a href={xai.data.authorization.verificationUrl} target="_blank" rel="noreferrer">{t("settings.transcription.xai.openAuthorization")}</a></>
            )}
            {xai.data?.authorization.userCode && <> · {t("settings.transcription.xai.code")} {xai.data.authorization.userCode}</>}
          </div>
        )}
        {(xai.error || authorizeXai.error || cancelXaiAuthorization.error || logoutXai.error || testXai.error || xai.data?.authorization.status === "failed") && (
          <div className="provider-status-note provider-status-note--bad" role="alert">
            {xai.error?.message || authorizeXai.error?.message || cancelXaiAuthorization.error?.message || logoutXai.error?.message || testXai.error?.message || xai.data?.authorization.message}
          </div>
        )}
        {testXai.data?.ok && (
          <div className="provider-status-note">{t("settings.transcription.xai.testPassed")} · {testXai.data.provider}</div>
        )}
        <div className="local-caption-actions">
          {xaiAuthorizing ? (
            <button type="button" className="path-btn" disabled={cancelXaiAuthorization.isPending} onClick={() => cancelXaiAuthorization.mutate()}>
              {t("settings.transcription.xai.cancel")}
            </button>
          ) : (
            <button type="button" className="path-btn local-caption-primary" disabled={authorizeXai.isPending} onClick={startXaiAuthorization}>
              {xai.data?.connected ? t("settings.transcription.xai.reauthorize") : t("settings.transcription.xai.authorize")}
            </button>
          )}
          {xai.data?.connected && !xaiAuthorizing && (
            <>
              <button type="button" className="path-btn" disabled={testXai.isPending} onClick={() => testXai.mutate()}>
                {testXai.isPending ? t("settings.transcription.xai.testing") : t("settings.transcription.xai.test")}
              </button>
              <button
                type="button"
                className="path-btn"
                disabled={logoutXai.isPending}
                onClick={() => {
                  if (window.confirm(t("settings.transcription.xai.logoutConfirm"))) logoutXai.mutate();
                }}
              >
                {t("settings.transcription.xai.logout")}
              </button>
            </>
          )}
        </div>
        <div className="provider-install-hint">{t("settings.transcription.xai.noDependency")}</div>
      </div>

      <div style={{ marginTop: 16 }}>
        <Link to="/knowledge/glossary">{t("settings.transcription.manageGlossary")}</Link>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value <= 0) return "≈ 320 MB";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit < 2 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
