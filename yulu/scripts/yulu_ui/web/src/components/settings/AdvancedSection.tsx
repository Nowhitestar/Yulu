import { trpc } from "../../trpc.js";
import { CommandEditor } from "../CommandEditor.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AdvancedSectionProps {
  tracker: SettingsRestartTracker;
}

/**
 * AdvancedSection — fields the registry flags `category: "advanced"`. Today this
 * is the cloud transcription command (the user's OWN command — the llm.command
 * trust model; Yulu holds no cloud credentials). Re-homed out of the
 * transcription section so advanced/danger-leaning knobs live together (P1
 * category→content map; the collapse/danger-confirm polish is P3).
 */
export function AdvancedSection({ tracker }: AdvancedSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });

  if (!cfg) return null;

  const tr = cfg.transcription as { cloud_command?: string[] };

  return (
    <section id="advanced" className="settings-section">
      <h2 className="settings-section-h">Advanced</h2>
      <p className="settings-section-sub">Cloud transcription command and other power-user knobs</p>

      {/* TRANS-02 (D-04): cloud transcription is the user's OWN command — the
          llm.command trust model. Yulu holds and asks for no cloud credentials.
          This is a command array, never a credential field. */}
      <div className="row">
        <div className="row-label">
          <div>Cloud transcription command</div>
          <div className="row-help">Your own cloud transcription command — spawned with the audio. Yulu holds no cloud keys.</div>
        </div>
        <div className="row-value">
          <CommandEditor
            value={tr.cloud_command ?? []}
            onChange={(next) => updateMut.mutateAsync({ key: "transcription.cloud_command", value: next })}
          />
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
