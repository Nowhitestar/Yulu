import { Outlet, useLocation } from "react-router";
import { useEffect, useRef, useState } from "react";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { useT } from "../i18n/LanguageProvider.js";
import { OnboardingEntry } from "./entry.js";

export function RootLayout() {
  const location = useLocation();
  const t = useT();
  const isSettings = location.pathname === "/settings" || location.pathname.startsWith("/settings/");
  const returnTo = useRef("/agent-console");
  useEffect(() => {
    if (!isSettings) returnTo.current = location.pathname + location.search + location.hash;
  }, [isSettings, location.pathname, location.search, location.hash]);
  const isAgentConsole = location.pathname.startsWith("/agent-console");
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
    <div data-yulu-ready className={`root-shell${isAgentConsole ? " agent-console-shell" : ""}${sidebarOpen && !isSettings ? " sidebar-open" : " sidebar-collapsed"}${isSettings ? " settings-shell" : ""}`}>
      <TopBar settingsReturnTo={isSettings ? returnTo.current : undefined} sidebarOpen={sidebarOpen && !isSettings} onToggleSidebar={() => setSidebarOpen((open) => !open)} />
      {sidebarOpen && !isSettings && <button className="sidebar-scrim" aria-label={t("nav.closeSidebar")} onClick={() => setSidebarOpen(false)} />}
      <div className="root-sidebar-pane" id="app-sidebar" hidden={!sidebarOpen || isSettings}>
        <Sidebar />
      </div>
      <main className="root-main">
        <div className="root-body">
          {isGuidedFlow ? <Outlet /> : <OnboardingEntry><Outlet /></OnboardingEntry>}
        </div>
      </main>
    </div>
  );
}
