// web/src/routes/settings.tsx
import { Outlet } from "react-router";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../src/routers/_app.js";
import { trpc } from "../trpc.js";
import { useSettingsRestartTracker, type SettingsRestartTracker } from "../hooks/useSettingsRestartTracker.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { MasterDetail } from "../components/MasterDetail.js";
import { SettingsCategoryList } from "../components/settings/SettingsCategoryList.js";
import { UndoToastProvider } from "../components/UndoToast.js";
import { DangerConfirmProvider } from "../components/DangerConfirm.js";
import "./settings.css";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

// Daemon short name → LaunchAgent label (consolidated map, was duplicated across 6 sub-pages)
const DAEMON_LABEL: Record<string, DaemonLabel> = {
  audiodaemon: "com.yulu.audiodaemon",
  sttdaemon: "com.yulu.sttdaemon",
  agentqueue: "com.yulu.agentqueue",
  statusagent: "com.yulu.statusagent",
  scheduler: "com.yulu.scheduler",
  detector: "com.yulu.detector",
  calendar: "com.yulu.calendar",
};

export const handle = { breadcrumb: "Settings", filters: null };

/** Context handed to the category detail (`<Outlet/>`): the shared restart tracker. */
export interface SettingsOutletContext {
  tracker: SettingsRestartTracker;
}

/**
 * SettingsLayout — the settings page shell. Renders the app's 3-column
 * MasterDetail: a category NavList (master) + the category detail (`<Outlet/>`).
 * Owns the restart tracker and the RestartBanner so restart-class edits made in
 * any category surface one consolidated banner here.
 */
export function SettingsLayout() {
  const tracker = useSettingsRestartTracker();
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel });
      }}
    />
  ) : null;

  const outletContext: SettingsOutletContext = { tracker };

  return (
    <UndoToastProvider>
      <DangerConfirmProvider>
        <div className="settings-page">
          {banner && <div className="settings-banner">{banner}</div>}
          <div className="settings-masterdetail">
            <MasterDetail
              storageKey="yulu_ui.settings.width"
              listSlot={<SettingsCategoryList />}
              detailSlot={<Outlet context={outletContext} />}
            />
          </div>
        </div>
      </DangerConfirmProvider>
    </UndoToastProvider>
  );
}
