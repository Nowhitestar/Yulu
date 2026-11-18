import { Link, NavLink } from "react-router";
import { ArrowLeft } from "lucide-react";
import { Logo } from "./Logo.js";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import { MAIN_NAV, SETTINGS_ENTRY, SETTINGS_NAV, SETUP_ENTRY, type Destination } from "../navigation.js";
import "./Sidebar.css";

function Item({ item, testId }: { item: Destination; testId?: string }) {
  const t = useT();
  const Icon = item.icon;
  return (
    <NavLink to={item.to} data-testid={testId} className={({ isActive }) => "sidebar-item" + (isActive ? " active" : "")}>
      <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
      <span className="sidebar-item-label">{t(item.labelKey)}</span>
    </NavLink>
  );
}

/**
 * One sidebar, two modes. "main" holds the three places you work; "settings"
 * replaces it with everything you configure, and a way back.
 */
export function Sidebar({ mode = "main", returnTo = "/agent-console" }: { mode?: "main" | "settings"; returnTo?: string }) {
  const t = useT();
  const onboarding = trpc.onboarding.status.useQuery(undefined, { retry: false, enabled: mode === "main" });
  // Setup only asks for attention while it is unfinished.
  const setupPending = onboarding.data?.completion?.completed === false;

  if (mode === "settings") {
    return (
      <aside className="sidebar">
        <Link className="sidebar-back" to={returnTo}><ArrowLeft size={15} strokeWidth={1.8} aria-hidden="true" />{t("settings.returnToApp")}</Link>
        <nav className="sidebar-nav" aria-label={t("settings.navigation")}>
          {SETTINGS_NAV.map((group, index) => (
            <div className="sidebar-group" key={index}>
              {group.map((item) => <Item key={item.to} item={item} testId={index === 0 ? "settings-category" : undefined} />)}
            </div>
          ))}
        </nav>
      </aside>
    );
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo size={22} />
        <span className="sidebar-brand-text" aria-label={t("app.name")}>
          <span className="sidebar-brand-wordmark">Yulu</span>
          <span className="sidebar-brand-hanzi">语录</span>
        </span>
      </div>
      <nav className="sidebar-nav">
        <div className="sidebar-group">
          {MAIN_NAV.map((item) => <Item key={item.to} item={item} />)}
        </div>
      </nav>
      <div className="sidebar-spacer" />
      <div className="sidebar-group">
        {setupPending && <Item item={SETUP_ENTRY} />}
        <Item item={SETTINGS_ENTRY} />
      </div>
    </aside>
  );
}
