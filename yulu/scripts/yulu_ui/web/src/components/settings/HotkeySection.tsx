import { ThemePresetPicker } from "../ThemePresetPicker.js";
import { LanguageToggle } from "../LanguageToggle.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { Link } from "react-router";

export function HotkeySection() {
  const t = useT();

  return (
    <section id="hotkey" className="settings-section">
      <h2 className="settings-section-h">{t("settings.hotkey.heading")}</h2>
      <p className="settings-section-sub">{t("settings.autosave")}</p>
      <div className="row">
        <div className="row-label">{t("settings.general.language.label")}</div>
        <div className="row-value"><LanguageToggle /></div>
        <div className="row-status" />
      </div>
      <div className="settings-appearance"><ThemePresetPicker compact /></div>
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
