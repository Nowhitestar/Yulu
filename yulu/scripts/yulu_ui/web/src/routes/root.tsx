import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { Pill } from "../components/Pill.js";

export function RootLayout() {
  return (
    <div className="root-shell">
      <Sidebar />
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          <Outlet />
        </div>
      </main>
      <Pill />
    </div>
  );
}
