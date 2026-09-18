// web/src/routes/settings.tsx
import { Outlet, Navigate, useParams } from "react-router";
import { useEffect, useState } from "react";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../src/routers/_app.js";
import { trpc } from "../trpc.js";
import { useSettingsRestartTracker, type SettingsRestartTracker } from "../hooks/useSettingsRestartTracker.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { SettingsCategoryList } from "../components/settings/SettingsCategoryList.js";
import { useUndoToast } from "../components/UndoToast.js";
import { DangerConfirmProvider } from "../components/DangerConfirm.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./settings.css";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

// Daemon short name → LaunchAgent label (consolidated map, was duplicated across 6 sub-pages)
const DAEMON_LABEL: Record<string, DaemonLabel> = {
  audiodaemon: "com.yulu.audiodaemon",
  statusagent: "com.yulu.statusagent",
  scheduler: "com.yulu.scheduler",
  detector: "com.yulu.detector",
  calendar: "com.yulu.calendar",
};

export const handle = { breadcrumb: "breadcrumb.settings", filters: null };

/** Context handed to the category detail (`<Outlet/>`): the shared restart tracker. */
export interface SettingsOutletContext {
  tracker: SettingsRestartTracker;
}

export function SettingsIndex() {
  const [wide, setWide] = useState(() => window.matchMedia("(min-width: 760px)").matches);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 760px)");
    const change = () => setWide(query.matches);
    query.addEventListener("change", change);
    return () => query.removeEventListener("change", change);
  }, []);
  return wide ? <Navigate to="/settings/general" replace /> : null;
}

export function SettingsLayout() {
  const { category } = useParams();
  const tracker = useSettingsRestartTracker();
  const { showError } = useUndoToast();
  const t = useT();
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestartAll={() => {
        const restarts = Array.from(tracker.daemons.keys(), (name) =>
          restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }),
        );
        void Promise.all(restarts).catch((error: unknown) => {
          showError(t("settings.restart.failed", {
            error: error instanceof Error ? error.message : String(error),
          }));
        });
      }}
      onDismiss={() => tracker.clearAll()}
    />
  ) : null;

  const outletContext: SettingsOutletContext = { tracker };

  return (
    <DangerConfirmProvider>
      <div className="settings-page" data-detail={Boolean(category)}>
        {banner && <div className="settings-banner">{banner}</div>}
        <div className="settings-workspace">
          <aside className="settings-navigation">
            <h1>{t("nav.settings")}</h1>
            <SettingsCategoryList />
          </aside>
          <div className="settings-content"><Outlet context={outletContext} /></div>
        </div>
      </div>
    </DangerConfirmProvider>
  );
}
