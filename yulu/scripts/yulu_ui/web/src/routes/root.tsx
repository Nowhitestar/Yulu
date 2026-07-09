import { Outlet, useLocation } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";

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
    </div>
  );
}
