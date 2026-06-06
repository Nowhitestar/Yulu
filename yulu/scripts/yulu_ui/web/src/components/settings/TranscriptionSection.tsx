import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

const TRANSCRIPTION_MODES = [
  { value: "local", label: "local" },
  { value: "cloud-fallback", label: "cloud-fallback" },
  { value: "cloud-priority", label: "cloud-priority" },
] as const;

export interface TranscriptionSectionProps {
  tracker: SettingsRestartTracker;
}

export function TranscriptionSection({ tracker }: TranscriptionSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  // SET-04: the model selector lists whisper models Phase 3 detected across host caches.
  const { data: models } = trpc.capabilities.detected_models.useQuery();

  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });

  const commit = (key: string) => (value: unknown) => updateMut.mutateAsync({ key, value });

  if (!cfg) return null;

  const tr = cfg.transcription as {
    mode?: "local" | "cloud-fallback" | "cloud-priority";
    realtime_enabled?: boolean;
    final_engine?: "mlx" | "whisper";
    language?: string;
    local_model_path?: string;
    mlx?: Record<string, unknown>;
  };
  const mode = tr.mode ?? "local";
  const modelOptions = (models ?? []).map((m) => ({ value: m.path, label: m.name }));
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

      {/* TRANS-01 (D-03): transcription mode — local (default) / cloud-fallback / cloud-priority. */}
      <div className="row">
        <div className="row-label">
          <div>Transcription mode</div>
          <div className="row-help">local keeps transcription on this machine (default). Cloud modes use your own command below.</div>
        </div>
        <div className="row-value">
          <div role="radiogroup" aria-label="Transcription mode">
            {TRANSCRIPTION_MODES.map((m) => (
              <label key={m.value} style={{ marginRight: 16 }}>
                <input
                  type="radio"
                  name="transcription-mode"
                  value={m.value}
                  checked={mode === m.value}
                  onChange={() => commit("transcription.mode")(m.value)}
                />{" "}
                {m.label}
              </label>
            ))}
          </div>
        </div>
        <div className="row-status">{tracker.statusFor("transcription.mode") === "saved" ? "✓" : tracker.statusFor("transcription.mode") === "restart" ? "⟳" : null}</div>
      </div>

      {/* SET-04 (D-05): pick among the whisper models Phase 3 detected; persists the chosen .bin path. */}
      <div className="row">
        <div className="row-label">
          <div>Detected model</div>
          <div className="row-help">Whisper models found across your host caches. Choosing one sets the local model path.</div>
        </div>
        <div className="row-value">
          <select
            aria-label="Detected model"
            className="value-input"
            disabled={modelOptions.length === 0}
            value={tr.local_model_path ?? ""}
            onChange={(e) => commit("transcription.local_model_path")(e.target.value)}
          >
            {modelOptions.length === 0 ? (
              <option value="">no models detected</option>
            ) : (
              <>
                <option value="">(choose a model)</option>
                {modelOptions.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </>
            )}
          </select>
        </div>
        <div className="row-status" />
      </div>

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
        options={[{ value: "mlx", label: "mlx" }, { value: "whisper", label: "whisper.cpp" }]}
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
