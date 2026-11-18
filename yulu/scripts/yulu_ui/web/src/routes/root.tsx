import { Outlet, useLocation } from "react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { TopBar } from "../components/TopBar.js";
import { CommandPalette } from "../components/CommandPalette.js";
import { SettingsNav } from "../components/SettingsNav.js";
import { RecordingsList } from "./inbox/recordings.js";
import { isSettingsArea, showsDetail } from "../navigation.js";
import { useT } from "../i18n/LanguageProvider.js";
import { OnboardingEntry } from "./entry.js";

const PANE_KEY = "yulu_ui.pane";
function storedPaneOpen() {
  try { return window.localStorage.getItem(PANE_KEY) !== "closed"; } catch { return true; }
}

/**
 * The whole window: a left pane and a reading sheet. The left pane holds your
 * recordings, or the settings list once you step into Settings. The recordings
 * pane can be tucked away to leave only the page you are reading.
 */
export function RootLayout() {
  const location = useLocation();
  const t = useT();
  const settings = isSettingsArea(location.pathname);
  // "Back" in Settings returns to the recording you were reading.
  const returnTo = useRef("/inbox");
  useEffect(() => {
    if (!settings) returnTo.current = location.pathname + location.search;
  }, [settings, location.pathname, location.search]);
  const isGuidedFlow = location.pathname === "/activate" || location.pathname === "/onboarding";

  const [paneOpen, setPaneOpen] = useState(storedPaneOpen);
  const togglePane = useCallback(() => setPaneOpen((open) => {
    try { window.localStorage.setItem(PANE_KEY, open ? "closed" : "open"); } catch { /* remembered for this window only */ }
    return !open;
  }), []);
  // Settings is navigated from the pane, so it is always there.
  const paneShown = settings || paneOpen;

  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => { setPaletteOpen(false); }, [location.key]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if ((event.metaKey || event.ctrlKey) && (key === "k" || event.code === "KeyK")) {
        event.preventDefault();
        setPaletteOpen(true);
      } else if (event.metaKey && event.ctrlKey && (key === "s" || event.code === "KeyS") && !settings) {
        // The macOS convention for showing and hiding a sidebar.
        event.preventDefault();
        togglePane();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [settings, togglePane]);

  return (
    <div data-yulu-ready className="root-shell" data-detail={showsDetail(location.pathname)} data-pane={paneShown ? "open" : "closed"}>
      <TopBar settings={settings} paneOpen={paneShown} onTogglePane={togglePane} />
      <aside className="root-pane" id="app-pane">
        <button type="button" className="pane-search" aria-label={t("search.placeholder")} aria-haspopup="dialog" aria-expanded={paletteOpen} onClick={() => setPaletteOpen(true)}>
          <Search size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("search.placeholder")}</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
        {settings ? <SettingsNav returnTo={returnTo.current} /> : <RecordingsList />}
      </aside>
      <main className="root-main">
        <div className="root-body">
          {isGuidedFlow ? <Outlet /> : <OnboardingEntry><Outlet /></OnboardingEntry>}
        </div>
      </main>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </div>
  );
}
