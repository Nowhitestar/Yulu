import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { Pill } from "../components/Pill.js";
import { ResizableSplit } from "../components/ResizableSplit.js";

export function RootLayout() {
  return (
    <div className="root-shell">
      <ResizableSplit
        storageKey="yulu_ui.sidebar.width"
        side="right"
        min={150}
        max={360}
        defaultWidth={220}
      >
        <Sidebar />
      </ResizableSplit>
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
