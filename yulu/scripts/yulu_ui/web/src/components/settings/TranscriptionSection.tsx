import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

const TRANSCRIPTION_MODES = [
  { value: "local", label: "local" },
  { value: "cloud-fallback", label: "cloud-fallback" },
  { value: "cloud-priority", label: "cloud-priority" },
] as const;

// The final-transcription engine. MLX runs Apple-Silicon MLX Whisper in-process;
// whisper.cpp runs the whisper-cli binary against a local .bin model. The choice
// gates which model fields are relevant (P4a-1).
const ENGINES = [
  { value: "mlx", label: "MLX" },
  { value: "whisper", label: "Whisper.cpp" },
] as const;

export interface TranscriptionSectionProps {
  tracker: SettingsRestartTracker;
}

export function TranscriptionSection({ tracker }: TranscriptionSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  // SET-04: the model selector lists whisper models Phase 3 detected across host caches.
  const { data: models } = trpc.capabilities.detected_models.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);

  if (!cfg) return null;

  const tr = cfg.transcription as {
    mode?: "local" | "cloud-fallback" | "cloud-priority";
    post_recording_mode?: "fast_summary" | "full_transcribe";
    realtime_enabled?: boolean;
    final_engine?: "mlx" | "whisper";
    language?: string;
    local_model_path?: string;
    whisper_cli?: string;
    mlx?: Record<string, unknown>;
    realtime?: Record<string, unknown>;
  };
  const mode = tr.mode ?? "local";
  const engine = tr.final_engine ?? "mlx";
  const modelOptions = (models ?? []).map((m) => ({ value: m.path, label: m.name }));
  const mlx = (tr.mlx ?? {}) as { model?: string };
  const realtime = (tr.realtime ?? {}) as { mlx_model?: string };

  return (
    <section id="transcription" className="settings-section">
      <h2 className="settings-section-h">Transcription</h2>
      <p className="settings-section-sub">Choose the transcription engine and model</p>

      {/* P4a-1: engine selector — MLX (Apple Silicon, in-process) vs whisper.cpp
          (whisper-cli + a local .bin). Picks transcription.final_engine and gates
          which model fields show below. */}
      <div className="row">
        <div className="row-label">
          <div>Engine</div>
          <div className="row-help">MLX runs on Apple Silicon. Whisper.cpp runs the whisper-cli binary against a local model file.</div>
        </div>
        <div className="row-value">
          <div role="radiogroup" aria-label="Transcription engine">
            {ENGINES.map((e) => (
              <label key={e.value} style={{ marginRight: 16 }}>
                <input
                  type="radio"
                  name="transcription-engine"
                  value={e.value}
                  checked={engine === e.value}
                  disabled={isBlocked("transcription.final_engine")}
                  onChange={() => commit("transcription.final_engine")(e.value)}
                />{" "}
                {e.label}
              </label>
            ))}
            {isBlocked("transcription.final_engine") && <span className="value-disabled-note">录音中不可改</span>}
          </div>
        </div>
        <div className="row-status">{tracker.statusFor("transcription.final_engine") === "restart" ? "⟳" : null}</div>
      </div>

      {/* MLX engine → MLX final model + the faster realtime model. Both are HF
          repo ids, downloaded lazily on first use. */}
      {engine === "mlx" && (
        <>
          <InlineEditRow
            label="MLX model"
            help="HuggingFace repo id (e.g. mlx-community/whisper-large-v3-mlx). Downloaded from HuggingFace on first use."
            type="text"
            value={mlx.model ?? ""}
            onCommit={commit("transcription.mlx.model") as (v: string) => void}
            disabled={isBlocked("transcription.mlx.model")}
            status={tracker.statusFor("transcription.mlx.model")}
          />
          <InlineEditRow
            label="Realtime model"
            help="Faster model for live captions; default turbo (mlx-community/whisper-large-v3-turbo)."
            type="text"
            value={realtime.mlx_model ?? ""}
            onCommit={commit("transcription.realtime.mlx_model") as (v: string) => void}
            disabled={isBlocked("transcription.realtime.mlx_model")}
            status={tracker.statusFor("transcription.realtime.mlx_model")}
          />
        </>
      )}

      {/* whisper.cpp engine → a local .bin model. The "Detected model" dropdown
          (host-cache scan, SET-04) and the manual path picker live ONLY here. */}
      {engine === "whisper" && (
        <>
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
                disabled={modelOptions.length === 0 || isBlocked("transcription.local_model_path")}
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
            label="Local model path"
            help="Path to a whisper.cpp .bin model file."
            type="path"
            mode="file"
            filter="bin"
            value={tr.local_model_path ?? ""}
            onCommit={commit("transcription.local_model_path") as (v: string) => void}
            disabled={isBlocked("transcription.local_model_path")}
            status={tracker.statusFor("transcription.local_model_path")}
          />
        </>
      )}

      {/* Always-relevant fields, regardless of engine. */}
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
        disabled={isBlocked("transcription.language")}
        status={tracker.statusFor("transcription.language")}
      />
      {/* P2-1: what happens when a recording stops — a quick summary, or a full re-transcribe.
          transcribe.py reads this each run, so no daemon reload is needed (reload:none). */}
      <InlineEditRow
        label="Post-recording"
        help="fast_summary: summarize from the live transcript. full_transcribe: re-transcribe the whole recording first."
        type="select"
        value={tr.post_recording_mode ?? "fast_summary"}
        options={[
          { value: "fast_summary", label: "fast_summary" },
          { value: "full_transcribe", label: "full_transcribe" },
        ]}
        onCommit={commit("transcription.post_recording_mode") as (v: string) => void}
        disabled={isBlocked("transcription.post_recording_mode")}
        status={tracker.statusFor("transcription.post_recording_mode")}
      />
      <InlineEditRow
        label="Realtime transcription"
        help="Transcribe live while recording. Off = transcribe after the recording stops."
        type="toggle"
        value={tr.realtime_enabled ?? true}
        onCommit={commit("transcription.realtime_enabled") as (v: boolean) => void}
        status={tracker.statusFor("transcription.realtime_enabled")}
      />

      {/* Advanced — the transcription mode (local / cloud-*) and, on the whisper
          engine, the whisper-cli binary path. Collapsed by default (P4a-1). */}
      <AdvancedDisclosure title="Advanced — change with care" note="power-user knobs">
        {/* TRANS-01 (D-03): transcription mode — local (default) / cloud-fallback / cloud-priority. */}
        <div className="row">
          <div className="row-label">
            <div>Transcription mode</div>
            <div className="row-help">local keeps transcription on this machine (default). Cloud modes use your own command in Advanced settings.</div>
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
                    disabled={isBlocked("transcription.mode")}
                    onChange={() => commit("transcription.mode")(m.value)}
                  />{" "}
                  {m.label}
                </label>
              ))}
              {isBlocked("transcription.mode") && <span className="value-disabled-note">录音中不可改</span>}
            </div>
          </div>
          <div className="row-status">{tracker.statusFor("transcription.mode") === "restart" ? "⟳" : null}</div>
        </div>

        {engine === "whisper" && (
          <InlineEditRow
            label="whisper.cpp CLI"
            help="The whisper-cli binary (name on PATH or absolute path). Only used by the Whisper.cpp engine."
            type="text"
            value={tr.whisper_cli ?? ""}
            onCommit={commit("transcription.whisper_cli") as (v: string) => void}
            disabled={isBlocked("transcription.whisper_cli")}
            status={tracker.statusFor("transcription.whisper_cli")}
          />
        )}
      </AdvancedDisclosure>

      <div style={{ marginTop: 16 }}>
        <Link to="/knowledge/glossary">Manage glossary →</Link>
      </div>
    </section>
  );
}
