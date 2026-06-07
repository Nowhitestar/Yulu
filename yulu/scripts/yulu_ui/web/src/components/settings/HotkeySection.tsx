import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { LanguageToggle } from "../LanguageToggle.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface HotkeySectionProps {
  tracker: SettingsRestartTracker;
}

export function HotkeySection({ tracker }: HotkeySectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();

  if (!cfg) return null;

  const statusAgent = cfg.status_agent;

  return (
    <section id="hotkey" className="settings-section">
      <h2 className="settings-section-h">{t("settings.hotkey.heading")}</h2>
      <p className="settings-section-sub">{t("settings.hotkey.sub")}</p>
      <InlineEditRow
        label={t("settings.hotkey.statusAgent.label")}
        type="toggle"
        value={statusAgent.enabled ?? false}
        onCommit={commit("status_agent.enabled")}
        disabled={isBlocked("status_agent.enabled")}
        status={tracker.statusFor("status_agent.enabled")}
      />
      <div className="row">
        <div className="row-label">{t("settings.general.language.label")}</div>
        <div className="row-value"><LanguageToggle /></div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">{t("settings.hotkey.theme.label")}</div>
        <div className="row-value"><ThemeToggle /></div>
        <div className="row-status" />
      </div>
      <InlineEditRow
        label={t("settings.hotkey.uiPort.label")}
        type="readonly"
        value="7777"
        help={t("settings.hotkey.uiPort.help")}
      />
    </section>
  );
}
