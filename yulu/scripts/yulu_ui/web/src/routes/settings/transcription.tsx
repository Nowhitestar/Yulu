import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../../src/routers/_app.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

export const handle = { breadcrumb: "Settings / Transcription", filters: null };

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

export function SettingsTranscription() {
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

  const tr = cfg.transcription as {
    final_engine?: "mlx" | "whisper-cli";
    language?: string;
    local_model_path?: string;
    mlx?: Record<string, unknown>;
  };
  const mlx = (tr.mlx ?? {}) as {
    model?: string;
    final_model?: string;
    preprocess_audio?: boolean;
    passthrough_max_sec?: number;
    passthrough_max_bytes?: number;
  };

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow
        label="Final engine"
        type="select"
        value={tr.final_engine ?? "mlx"}
        options={[{ value: "mlx", label: "mlx" }, { value: "whisper-cli", label: "whisper-cli" }]}
        onCommit={commit("transcription.final_engine") as (v: string) => void}
        status={tracker.statusFor("transcription.final_engine")}
      />
      <InlineEditRow
        label="Language"
        type="select"
        value={tr.language ?? "auto"}
        options={[
          { value: "zh", label: "zh" },
          { value: "en", label: "en" },
          { value: "ja", label: "ja" },
          { value: "auto", label: "auto" },
        ]}
        onCommit={commit("transcription.language") as (v: string) => void}
        status={tracker.statusFor("transcription.language")}
      />
      <InlineEditRow
        label="Local model path"
        type="path"
        mode="file"
        filter="bin"
        value={tr.local_model_path ?? ""}
        onCommit={commit("transcription.local_model_path") as (v: string) => void}
        status={tracker.statusFor("transcription.local_model_path")}
      />
      <InlineEditRow
        label="MLX model"
        type="text"
        value={mlx.model ?? ""}
        onCommit={commit("transcription.mlx.model") as (v: string) => void}
        status={tracker.statusFor("transcription.mlx.model")}
      />
      <InlineEditRow
        label="MLX final model"
        type="text"
        value={mlx.final_model ?? ""}
        onCommit={commit("transcription.mlx.final_model") as (v: string) => void}
        status={tracker.statusFor("transcription.mlx.final_model")}
      />
      <InlineEditRow
        label="MLX preprocess audio"
        type="toggle"
        value={mlx.preprocess_audio ?? false}
        onCommit={commit("transcription.mlx.preprocess_audio") as (v: boolean) => void}
        status={tracker.statusFor("transcription.mlx.preprocess_audio")}
      />
      <InlineEditRow
        label="MLX passthrough max sec"
        type="number"
        min={0}
        step={1}
        value={mlx.passthrough_max_sec ?? 0}
        onCommit={commit("transcription.mlx.passthrough_max_sec") as (v: number) => void}
        status={tracker.statusFor("transcription.mlx.passthrough_max_sec")}
      />
      <InlineEditRow
        label="MLX passthrough max bytes"
        type="number"
        min={0}
        step={1}
        value={mlx.passthrough_max_bytes ?? 0}
        onCommit={commit("transcription.mlx.passthrough_max_bytes") as (v: number) => void}
        status={tracker.statusFor("transcription.mlx.passthrough_max_bytes")}
      />
      <div style={{ marginTop: 16 }}>
        <Link to="/knowledge/glossary">Manage glossary →</Link>
      </div>
    </SettingsPage>
  );
}
