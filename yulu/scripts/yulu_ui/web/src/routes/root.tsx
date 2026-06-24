import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { LiveTranscript } from "../components/LiveTranscript.js";
import { Onboarding } from "../components/Onboarding.js";

export function RootLayout() {
  return (
    <div className="root-shell">
      <div className="root-sidebar-pane">
        <Sidebar />
      </div>
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          <Outlet />
        </div>
      </main>
      {/* Live captions while recording — self-hides when no recording is
          active (server publishes {active:false}). */}
      <LiveTranscript />
      {/* Self-gating: renders null once dismissed (config flag / localStorage),
          so mounting unconditionally is correct — never forced (SET-03). */}
      <Onboarding />
    </div>
  );
}
