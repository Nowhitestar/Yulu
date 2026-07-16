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
  const health = trpc.agentTasks.transcriptionHealth.useQuery(undefined, { refetchInterval: 5_000 });
  const local = trpc.localCaption.status.useQuery(undefined, {
    refetchInterval: (query) => query.state.data?.operation !== "idle" ? 1_000 : 5_000,
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

  return (
    <section id="transcription" className="settings-section">
      <h2 className="settings-section-h">{t("settings.transcription.heading")}</h2>
      <p className="settings-section-sub">{t("settings.transcription.sub")}</p>

      <div className="row">
        <div className="row-label">
          <div>{t("settings.transcription.agent.label")}</div>
          <div className="row-help">
            {health.data?.available
              ? t("settings.transcription.agent.ready")
              : health.data?.reason || t("settings.transcription.agent.unavailable")}
          </div>
        </div>
        <div className="row-value">
          {health.data?.provider?.toLowerCase() === "hermes" ? "Hermes" : health.data?.provider || "Hermes"}
        </div>
        <div className="row-status" />
      </div>

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

      <InlineEditRow
        label={t("settings.transcription.realtime.strategy.label")}
        help={t("settings.transcription.realtime.strategy.help")}
        type="select"
        value={config.realtime_captions?.strategy ?? "local-hybrid"}
        options={[
          { value: "local-hybrid", label: t("settings.transcription.realtime.strategy.hybrid") },
          { value: "agent-only", label: t("settings.transcription.realtime.strategy.agent") },
        ]}
        onCommit={commit("realtime_captions.strategy") as (value: string) => void}
        disabled={isBlocked("realtime_captions.strategy")}
        status={tracker.statusFor("realtime_captions.strategy")}
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
