import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { OnboardingEntry } from "./entry.js";

export function RootLayout() {
  const location = useLocation();
  const isAgentConsole = location.pathname.startsWith("/agent-console");
  const isGuidedFlow = location.pathname === "/activate" || location.pathname === "/onboarding";
  return (
    <div className={`root-shell${isAgentConsole ? " agent-console-shell" : ""}`}>
      <div className="root-sidebar-pane">
        <Sidebar />
      </div>
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          {isGuidedFlow ? <Outlet /> : <OnboardingEntry><Outlet /></OnboardingEntry>}
        </div>
      </main>
    </div>
  );
}
