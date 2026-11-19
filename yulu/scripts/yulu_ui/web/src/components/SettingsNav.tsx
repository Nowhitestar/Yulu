import { Link, NavLink } from "react-router";
import { ArrowLeft } from "lucide-react";
import { SETTINGS_NAV } from "../navigation.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./SettingsNav.css";

/** The left pane while you are in Settings: a way back, then every settings page. */
export function SettingsNav({ returnTo = "/inbox" }: { returnTo?: string }) {
  const t = useT();
  return (
    <nav className="settings-nav" aria-label={t("settings.navigation")}>
      <Link className="settings-nav-back" to={returnTo}>
        <ArrowLeft size={15} strokeWidth={1.8} aria-hidden="true" />
        {t("settings.returnToApp")}
      </Link>
      {SETTINGS_NAV.map((group, index) => (
        <div className="settings-nav-group" key={index}>
          {group.map((item) => (
            <NavLink key={item.to} to={item.to} data-testid={index === 0 ? "settings-category" : undefined}
              className={({ isActive }) => "settings-nav-item" + (isActive ? " active" : "")}>
              {t(item.labelKey)}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
