import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
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
    refetchInterval: (query) => (query.state.data?.operation ?? "idle") !== "idle" ? 1_000 : 5_000,
  });
  const providers = trpc.providers.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.connection.authorization.status === "running" ? 1_000 : 5_000,
  });
  const utils = trpc.useUtils();
  const refreshLocal = async () => { await utils.localCaption.status.invalidate(); };
  const install = trpc.localCaption.install.useMutation({ onSettled: refreshLocal });
  const uninstall = trpc.localCaption.uninstall.useMutation({ onSettled: refreshLocal });
  const testModel = trpc.localCaption.test.useMutation({ onSettled: refreshLocal });
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();
  const localBusy = (local.data?.operation ?? "idle") !== "idle"
    || install.isPending || uninstall.isPending || testModel.isPending;

  if (!config) return null;

  const selectedEngine = config.transcription.engine ?? "local";
  const engineHelp = selectedEngine === "local" && local.data && !local.data.ready
    ? t("settings.transcription.engine.localUnavailable")
    : selectedEngine === "xai" && providers.data && !providers.data.connection.connected
      ? t("settings.transcription.engine.xaiUnavailable")
      : t("settings.transcription.engine.help");
  const languageOptions = [
    { value: "zh", label: t("settings.transcription.language.zh") },
    { value: "en", label: t("settings.transcription.language.en") },
    ...(selectedEngine === "xai" ? [{ value: "ja", label: t("settings.transcription.language.ja") }] : []),
    { value: "auto", label: t("settings.transcription.language.auto") },
  ];

  const localModel = (
      <div className="local-caption-card" data-installed={local.data?.installed ? "true" : "false"}>
        <div className="local-caption-head">
          <div>
            <div className="local-caption-title">{t("settings.transcription.localModel.title")}</div>
            <div className="local-caption-sub">{t("settings.transcription.localModel.sub")}</div>
          </div>
          <span className={`provider-state ${local.data?.ready ? "provider-state--ok" : "provider-state--muted"}`}>
            {!local.data
              ? t("common.loading")
              : local.data.ready
              ? t("settings.transcription.localModel.installed")
              : local.data?.installed
                ? t("settings.transcription.localModel.needsAttention")
                : t("settings.transcription.localModel.notInstalled")}
          </span>
        </div>

        {localBusy && (
          <div className="local-caption-progress" role="status">
            <div className="local-caption-progress-track">
              <span style={{ width: `${local.data?.percent ?? 12}%` }} />
            </div>
            <span>{local.data?.message || t("common.loading")}</span>
          </div>
        )}

        {(local.error || local.data?.error || install.error || uninstall.error || testModel.error) && (
          <div className="provider-status-note provider-status-note--bad" role="alert">
            {local.error?.message || local.data?.error || install.error?.message || uninstall.error?.message || testModel.error?.message}
          </div>
        )}
        {testModel.isSuccess && local.data?.message && local.data.operation === "idle" && !local.data.error && (
          <div className="provider-status-note">{local.data.message}</div>
        )}

        <div className="local-caption-actions">
          {!local.data?.installed ? (
            <button type="button" className="path-btn local-caption-primary" disabled={localBusy || !local.data} onClick={() => install.mutate()}>
              {install.isPending ? t("settings.transcription.localModel.installing") : t("settings.transcription.localModel.install")}
            </button>
          ) : (
            <AdvancedDisclosure title={t("settings.transcription.localModel.manage")} note="">
              <p>{t("settings.transcription.localModel.disk")}: {formatBytes((local.data?.runtimeBytes ?? 0) + (local.data?.modelBytes ?? 0))}</p>
              <p>sherpa-onnx Paraformer · INT8</p>
              <div className="settings-inline-actions">
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
              </div>
            </AdvancedDisclosure>
          )}
        </div>
        {local.data && !local.data.installed && (
          <div className="provider-install-hint">{t("settings.transcription.localModel.installHint")}</div>
        )}
        {local.data?.sessionActive && (
          <div className="provider-install-hint">{t("settings.transcription.localModel.uninstallAfterRecording")}</div>
        )}
      </div>

  );

  return (
    <section id="transcription" className="settings-section">
      <h2 className="settings-section-h">{t("settings.transcription.heading")}</h2>
      <p className="settings-section-sub">{t("settings.transcription.sub")}</p>

      <InlineEditRow
        label={t("settings.transcription.engine.label")}
        help={engineHelp}
        type="select"
        value={selectedEngine}
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
        options={languageOptions}
        onCommit={commit("transcription.language") as (value: string) => void}
        disabled={isBlocked("transcription.language")}
        status={tracker.statusFor("transcription.language")}
      />

      {selectedEngine === "local" ? localModel : (
      <div className="local-caption-card" data-installed={providers.data?.connection.connected ? "true" : "false"}>
        <div className="local-caption-head">
          <div>
            <div className="local-caption-title">{t("settings.providers.connection.title")}</div>
            <div className="local-caption-sub">{t("settings.providers.connection.sub")}</div>
          </div>
          <span className={`provider-state ${providers.data?.connection.connected ? "provider-state--ok" : "provider-state--muted"}`}>
            {providers.data?.connection.connected
              ? t("settings.transcription.xai.connected")
              : t("settings.providers.connection.disconnected")}
          </span>
        </div>

        {providers.error && (
          <div className="provider-status-note provider-status-note--bad" role="alert">
            {providers.error.message}
          </div>
        )}
        <div className="provider-status-note" role="status">
          {t(`settings.providers.readiness.${providers.data?.readiness.transcription.status ?? "untested"}`)}
          {providers.data?.readiness.transcription.testedAt && <> · {providers.data.readiness.transcription.model}</>}
        </div>
        <div className="local-caption-actions">
          <Link className="path-btn local-caption-primary" to="/settings/connections?connection=direct-xai&capability=transcription#ai-connections">
            {t("settings.providers.open")}
          </Link>
        </div>
      </div>

      )}
      {selectedEngine !== "local" && (local.data?.installed || localBusy) && (
        <AdvancedDisclosure title={t("settings.transcription.localModel.manage")} note="">{localModel}</AdvancedDisclosure>
      )}

      <div style={{ marginTop: 16 }}>
        <Link to="/knowledge/glossary">{t("settings.transcription.manageGlossary")}</Link>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (value <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit < 2 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}
