import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { Onboarding } from "../components/Onboarding.js";

export function RootLayout() {
  const location = useLocation();
  const isAgentConsole = location.pathname.startsWith("/agent-console");
  return (
    <div className={`root-shell${isAgentConsole ? " agent-console-shell" : ""}`}>
      <div className="root-sidebar-pane">
        <Sidebar />
      </div>
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          <Outlet />
        </div>
      </main>
      {/* Self-gating: renders null once dismissed (config flag / localStorage),
          so mounting unconditionally is correct — never forced (SET-03). */}
      <Onboarding />
    </div>
  );
}
