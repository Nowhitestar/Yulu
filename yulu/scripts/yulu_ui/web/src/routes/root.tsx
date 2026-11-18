import { Outlet, useLocation } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { useT } from "../i18n/LanguageProvider.js";
import { OnboardingEntry } from "./entry.js";

/** Everything you configure rather than use lives behind Settings. */
const SETTINGS_AREAS = ["/settings", "/knowledge", "/health"];

export function isSettingsArea(pathname: string): boolean {
  return SETTINGS_AREAS.some((area) => pathname === area || pathname.startsWith(`${area}/`));
}

export function RootLayout() {
  const location = useLocation();
  const t = useT();
  const settings = isSettingsArea(location.pathname);
  // Where "Back" in the settings sidebar returns to: the last place you were working.
  const returnTo = useRef("/agent-console");
  useEffect(() => {
    if (!settings) returnTo.current = location.pathname + location.search + location.hash;
  }, [settings, location.pathname, location.search, location.hash]);
  const isGuidedFlow = location.pathname === "/activate" || location.pathname === "/onboarding";
  const [sidebarOpen, setSidebarOpen] = useState(() => window.innerWidth >= 1100);
  useEffect(() => {
    const compact = window.matchMedia("(max-width: 1099px)");
    const resize = () => setSidebarOpen(!compact.matches);
    compact.addEventListener("change", resize);
    return () => compact.removeEventListener("change", resize);
  }, []);
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && window.innerWidth < 760) setSidebarOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, []);
  useEffect(() => {
    if (window.innerWidth < 760) setSidebarOpen(false);
  }, [location.pathname]);
  return (
    <div data-yulu-ready className={`root-shell${sidebarOpen ? " sidebar-open" : " sidebar-collapsed"}`}>
      <TopBar sidebarOpen={sidebarOpen} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      {sidebarOpen && <button className="sidebar-scrim" aria-label={t("nav.closeSidebar")} onClick={() => setSidebarOpen(false)} />}
      <div className="root-sidebar-pane" id="app-sidebar" hidden={!sidebarOpen}>
        <Sidebar mode={settings ? "settings" : "main"} returnTo={returnTo.current} />
      </div>
      <main className="root-main">
        <div className="root-body">
          {isGuidedFlow ? <Outlet /> : <OnboardingEntry><Outlet /></OnboardingEntry>}
        </div>
      </main>
    </div>
  );
}
