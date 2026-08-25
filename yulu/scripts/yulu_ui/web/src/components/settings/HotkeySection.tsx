import { ThemePresetPicker } from "../ThemePresetPicker.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { LanguageToggle } from "../LanguageToggle.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { Link } from "react-router";

export function HotkeySection() {
  const t = useT();

  return (
    <section id="hotkey" className="settings-section">
      <h2 className="settings-section-h">{t("settings.hotkey.heading")}</h2>
      <p className="settings-section-sub">{t("settings.hotkey.sub")}</p>
      <div className="row">
        <div className="row-label">{t("settings.general.language.label")}</div>
        <div className="row-value"><LanguageToggle /></div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">{t("settings.hotkey.themeMode.label")}</div>
        <div className="row-value"><ThemeToggle /></div>
        <div className="row-status" />
      </div>
      <div className="row row--wide">
        <div className="row-label">{t("settings.hotkey.theme.label")}</div>
        <div className="row-value"><ThemePresetPicker /></div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">{t("settings.activation.label")}</div>
        <div className="row-value">
          <Link to="/activate">{t("settings.activation.open")}</Link>
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
