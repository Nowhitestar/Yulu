import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { ActivationEntry } from "./entry.js";

export function RootLayout() {
  const location = useLocation();
  const isAgentConsole = location.pathname.startsWith("/agent-console");
  const isActivation = location.pathname === "/activate";
  return (
    <div className={`root-shell${isAgentConsole ? " agent-console-shell" : ""}`}>
      <div className="root-sidebar-pane">
        <Sidebar />
      </div>
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          {isActivation ? <Outlet /> : <ActivationEntry><Outlet /></ActivationEntry>}
        </div>
      </main>
    </div>
  );
}
