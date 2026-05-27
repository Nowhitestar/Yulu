import { trpc } from "../../trpc.js";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../../src/routers/_app.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

export const handle = { breadcrumb: "Audio", filters: null };

// Daemon short name → LaunchAgent label
const DAEMON_LABEL: Record<string, DaemonLabel> = {
  audiodaemon: "com.yulu.audiodaemon",
  sttdaemon: "com.yulu.sttdaemon",
  agentqueue: "com.yulu.agentqueue",
  statusagent: "com.yulu.statusagent",
  scheduler: "com.yulu.scheduler",
  detector: "com.yulu.detector",
  calendar: "com.yulu.calendar",
};

export function SettingsAudio() {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: devices } = trpc.system.audioDevices.useQuery();
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

  const commit = (key: string) => (value: unknown) => updateMut.mutateAsync({ key, value });

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel });
      }}
    />
  ) : null;

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const micOpts = (devices?.input ?? []).map((d) => ({ value: d.uid, label: d.name }));
  const sysOpts = [{ value: "", label: "(none)" }, ...(devices?.output ?? []).map((d) => ({ value: d.uid, label: d.name }))];

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow label="Mic device" type="select" value={cfg.audio.mic_device ?? ""} options={micOpts.length ? micOpts : [{value: cfg.audio.mic_device ?? "", label: "(no devices found)"}]} onCommit={commit("audio.mic_device") as (v: string) => void} status={tracker.statusFor("audio.mic_device")} />
      <InlineEditRow label="System audio device" type="select" value={cfg.audio.system_audio_device ?? ""} options={sysOpts} onCommit={(v) => updateMut.mutateAsync({ key: "audio.system_audio_device", value: v || null })} status={tracker.statusFor("audio.system_audio_device")} />
      <InlineEditRow label="Output dir" type="path" mode="folder" value={cfg.audio.output_dir} onCommit={commit("audio.output_dir") as (v: string) => void} status={tracker.statusFor("audio.output_dir")} />
      <InlineEditRow label="Silence threshold" type="number" min={0} max={1} step={0.01} value={cfg.audio.silence_threshold} help="RMS below this counts as silence" onCommit={commit("audio.silence_threshold") as (v: number) => void} status={tracker.statusFor("audio.silence_threshold")} />
      <InlineEditRow label="Silence duration sec" type="number" min={1} step={1} value={cfg.audio.silence_duration_sec} onCommit={commit("audio.silence_duration_sec") as (v: number) => void} status={tracker.statusFor("audio.silence_duration_sec")} />
      <InlineEditRow label="Backend" type="select" value={cfg.audio.backend ?? "daemon"} options={[{ value: "daemon", label: "daemon" }]} onCommit={commit("audio.backend") as (v: string) => void} status={tracker.statusFor("audio.backend")} />
    </SettingsPage>
  );
}
