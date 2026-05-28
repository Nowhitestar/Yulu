import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface TranscriptionSectionProps {
  tracker: SettingsRestartTracker;
}

export function TranscriptionSection({ tracker }: TranscriptionSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();

  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });

  const commit = (key: string) => (value: unknown) => updateMut.mutateAsync({ key, value });

  if (!cfg) return null;

  const tr = cfg.transcription as {
    realtime_enabled?: boolean;
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
    <section id="transcription" className="settings-section">
      <h2 className="settings-section-h">Transcription</h2>
      <p className="settings-section-sub">Whisper / MLX engine and post-recording mode</p>
      <InlineEditRow
        label="Realtime transcription"
        help="Transcribe live while recording. Off = transcribe after the recording stops."
        type="toggle"
        value={tr.realtime_enabled ?? true}
        onCommit={commit("transcription.realtime_enabled") as (v: boolean) => void}
        status={tracker.statusFor("transcription.realtime_enabled")}
      />
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
        label="MLX passthrough max"
        help="seconds"
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
    </section>
  );
}
