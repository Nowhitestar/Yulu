import { ThemePresetPicker } from "../ThemePresetPicker.js";
import { LanguageToggle } from "../LanguageToggle.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { LaunchAtLoginRow } from "./LaunchAtLoginRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

const UPCOMING_MEETING_MINUTES = [0, 10, 15, 30, 60];

/** The offered lead times, plus a value set in config.json by hand. */
function upcomingOptions(current: number): number[] {
  return UPCOMING_MEETING_MINUTES.includes(current)
    ? UPCOMING_MEETING_MINUTES
    : [...UPCOMING_MEETING_MINUTES, current].sort((a, b) => a - b);
}

export function HotkeySection({ tracker }: { tracker: SettingsRestartTracker }) {
  const t = useT();
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit } = useConfigField(tracker);
  const upcomingMinutes = cfg?.status_agent?.upcoming_meeting_minutes ?? 30;

  return (
    <section id="hotkey" className="settings-section">
      <h2 className="settings-section-h">{t("settings.hotkey.heading")}</h2>
      <p className="settings-section-sub">{t("settings.autosave")}</p>
      <div className="row">
        <div className="row-label">{t("settings.general.language.label")}</div>
        <div className="row-value"><LanguageToggle /></div>
        <div className="row-status" />
      </div>
      <div className="settings-appearance"><ThemePresetPicker /></div>
      {cfg && <>
        <InlineEditRow
          label={t("settings.general.dockIcon")}
          help={t("settings.general.dockIcon.help")}
          type="toggle"
          value={cfg.ui?.show_dock_icon ?? true}
          onCommit={commit("ui.show_dock_icon")}
          status={tracker.statusFor("ui.show_dock_icon")}
        />
        <InlineEditRow
          label={t("settings.general.menuBarIcon")}
          help={t("settings.general.menuBarIcon.help")}
          type="toggle"
          value={cfg.ui?.show_menu_bar_icon ?? true}
          onCommit={commit("ui.show_menu_bar_icon")}
          status={tracker.statusFor("ui.show_menu_bar_icon")}
        />
        <p className="settings-section-sub">{t("settings.general.icons.reopen")}</p>
        <InlineEditRow
          label={t("settings.general.upcomingMeeting")}
          help={t("settings.general.upcomingMeeting.help")}
          type="select"
          value={String(upcomingMinutes)}
          options={upcomingOptions(upcomingMinutes).map((minutes) => ({
            value: String(minutes),
            label: minutes === 0
              ? t("settings.general.upcomingMeeting.off")
              : t("settings.general.upcomingMeeting.minutes", { minutes }),
          }))}
          onCommit={(value) => commit("status_agent.upcoming_meeting_minutes")(Number(value))}
          status={tracker.statusFor("status_agent.upcoming_meeting_minutes")}
        />
      </>}
      <LaunchAtLoginRow />
      <div className="row">
        <div className="row-label">{t("settings.onboarding.label")}</div>
        <div className="row-value">
          <Link to="/onboarding">{t("settings.onboarding.open")}</Link>
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
