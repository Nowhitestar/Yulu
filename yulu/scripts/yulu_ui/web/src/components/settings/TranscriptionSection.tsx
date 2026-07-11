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
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();

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

      <div style={{ marginTop: 16 }}>
        <Link to="/knowledge/glossary">{t("settings.transcription.manageGlossary")}</Link>
      </div>
    </section>
  );
}
