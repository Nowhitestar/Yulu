// web/src/routes/settings.tsx
import { useEffect } from "react";
import { useLocation } from "react-router";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../src/routers/_app.js";
import { trpc } from "../trpc.js";
import { useSettingsRestartTracker } from "../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../components/SettingsPage.js";
import { RestartBanner } from "../components/RestartBanner.js";
import { AudioSection } from "../components/settings/AudioSection.js";
import { CapabilitiesSection } from "../components/settings/CapabilitiesSection.js";
import { TranscriptionSection } from "../components/settings/TranscriptionSection.js";
import { LlmSection } from "../components/settings/LlmSection.js";
import { HotkeySection } from "../components/settings/HotkeySection.js";
import { IntegrationsSection } from "../components/settings/IntegrationsSection.js";
import { StorageSection } from "../components/settings/StorageSection.js";
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

export function Settings() {
  const location = useLocation();
  const tracker = useSettingsRestartTracker();
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });

  useEffect(() => {
    if (!location.hash) return;
    const id = location.hash.slice(1);
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [location.hash]);

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel });
      }}
    />
  ) : undefined;

  return (
    <SettingsPage banner={banner}>
      <div className="settings-inner">
        <h1 className="settings-page-title">Settings</h1>
        <p className="settings-page-sub">所有 Yulu 运行参数集中在这里。修改需要重启的项会触发顶部 Restart banner。</p>
        <div className="settings-stack">
          <CapabilitiesSection />
          <AudioSection tracker={tracker} />
          <TranscriptionSection tracker={tracker} />
          <LlmSection tracker={tracker} />
          <HotkeySection tracker={tracker} />
          <IntegrationsSection tracker={tracker} />
          <StorageSection tracker={tracker} />
        </div>
      </div>
    </SettingsPage>
  );
}
