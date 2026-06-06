import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AudioSectionProps {
  tracker: SettingsRestartTracker;
}

export function AudioSection({ tracker }: AudioSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: devices } = trpc.system.audioDevices.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);

  if (!cfg) return null;

  const micOpts = (devices?.input ?? []).map((d) => ({ value: d.uid, label: d.name }));
  const sysOpts = [{ value: "", label: "(none)" }, ...(devices?.output ?? []).map((d) => ({ value: d.uid, label: d.name }))];

  return (
    <section id="audio" className="settings-section">
      <h2 className="settings-section-h">Audio</h2>
      <p className="settings-section-sub">Recording source, output directory, silence detection</p>
      <InlineEditRow label="Microphone device" type="select" value={cfg.audio.mic_device ?? ""} options={micOpts.length ? micOpts : [{value: cfg.audio.mic_device ?? "", label: "(no devices found)"}]} help="system default input" onCommit={commit("audio.mic_device") as (v: string) => void} disabled={isBlocked("audio.mic_device")} status={tracker.statusFor("audio.mic_device")} />
      <InlineEditRow label="System audio device" type="select" value={cfg.audio.system_audio_device ?? ""} options={sysOpts} help="ScreenCaptureKit channel" onCommit={(v) => commit("audio.system_audio_device")(v || null)} disabled={isBlocked("audio.system_audio_device")} status={tracker.statusFor("audio.system_audio_device")} />
      <InlineEditRow label="Output directory" type="path" mode="folder" value={cfg.audio.output_dir} onCommit={commit("audio.output_dir") as (v: string) => void} disabled={isBlocked("audio.output_dir")} status={tracker.statusFor("audio.output_dir")} />
      <InlineEditRow label="Silence threshold" type="number" min={0} max={1} step={0.01} value={cfg.audio.silence_threshold} help="RMS below this counts as silence" onCommit={commit("audio.silence_threshold") as (v: number) => void} disabled={isBlocked("audio.silence_threshold")} status={tracker.statusFor("audio.silence_threshold")} />
      <InlineEditRow label="Silence duration" type="number" min={1} step={1} value={cfg.audio.silence_duration_sec} help="seconds" onCommit={commit("audio.silence_duration_sec") as (v: number) => void} disabled={isBlocked("audio.silence_duration_sec")} status={tracker.statusFor("audio.silence_duration_sec")} />
      <InlineEditRow label="Backend" type="select" value={cfg.audio.backend ?? "daemon"} options={[{ value: "daemon", label: "daemon" }]} onCommit={commit("audio.backend") as (v: string) => void} disabled={isBlocked("audio.backend")} status={tracker.statusFor("audio.backend")} />
    </section>
  );
}
