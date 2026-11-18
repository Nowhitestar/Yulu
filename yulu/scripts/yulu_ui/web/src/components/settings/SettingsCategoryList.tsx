import { NavLink } from "react-router";
import { AudioLines, Bell, ChevronRight, Mic, Plug, SlidersHorizontal } from "lucide-react";
import { CATEGORIES } from "./categories.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./SettingsCategoryList.css";

const ICONS = { general: SlidersHorizontal, recording: Mic, meetings: Bell, voice: AudioLines, connections: Plug };

export function SettingsCategoryList() {
  const t = useT();
  return (
    <nav className="settings-category-list" aria-label={t("settings.navigation")}>
      {CATEGORIES.map((cat) => {
        const Icon = ICONS[cat.id];
        return (
          <NavLink key={cat.id} to={`/settings/${cat.id}`} data-testid="settings-category"
            className={({ isActive }) => "settings-category-row" + (isActive ? " active" : "")}>
            <Icon size={18} strokeWidth={1.7} aria-hidden="true" />
            <span className="settings-category-text">
              <span className="settings-category-title">{t(cat.labelKey)}</span>
              <span className="settings-category-desc">{t(cat.descKey)}</span>
            </span>
            <ChevronRight className="settings-category-chevron" size={16} aria-hidden="true" />
          </NavLink>
        );
      })}
    </nav>
  );
}
