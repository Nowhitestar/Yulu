import { trpc } from "../../trpc.js";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../../src/routers/_app.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { HotkeyCapture, type HotkeyValue } from "../../components/HotkeyCapture.js";
import { ThemeToggle } from "../../components/ThemeToggle.js";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

export const handle = { breadcrumb: "Settings / Hotkey & UI", filters: null };

const DAEMON_LABEL: Record<string, DaemonLabel> = {
  statusagent: "com.yulu.statusagent",
};

export function SettingsHotkey() {
  const { data: cfg } = trpc.config.get.useQuery();
  const tracker = useSettingsRestartTracker();
  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel });
      }}
    />
  ) : null;

  const statusAgent = cfg.status_agent;
  const hotkey: HotkeyValue = statusAgent?.hotkey ?? { key: "V", modifiers: ["cmd", "shift"] };

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow
        label="Status agent enabled"
        type="toggle"
        value={statusAgent.enabled ?? false}
        onCommit={(v) => updateMut.mutateAsync({ key: "status_agent.enabled", value: v })}
        status={tracker.statusFor("status_agent.enabled")}
      />
      <div className="row">
        <div className="row-label">Hotkey</div>
        <div className="row-value">
          <HotkeyCapture
            value={hotkey}
            onCommit={(v) => updateMut.mutateAsync({ key: "status_agent.hotkey", value: v })}
          />
        </div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">UI theme</div>
        <div className="row-value"><ThemeToggle /></div>
        <div className="row-status" />
      </div>
      <InlineEditRow
        label="UI port"
        type="readonly"
        value="7777"
        help="Edit com.yulu.ui.plist and `yulu restart yulu_ui` to change"
      />
    </SettingsPage>
  );
}
