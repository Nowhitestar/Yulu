import { trpc } from "../../trpc.js";
import { CommandEditor } from "../CommandEditor.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AdvancedSectionProps {
  tracker: SettingsRestartTracker;
}

/**
 * AdvancedSection — fields the registry flags `category: "advanced"`. Today this
 * is the cloud transcription command (the user's OWN command — the llm.command
 * trust model; Yulu holds no cloud credentials). Re-homed out of the
 * transcription section so advanced/danger-leaning knobs live together (P1
 * category→content map). P3-2: the knobs sit behind a collapsed-by-default
 * disclosure so the category opens calm, with a "change with care" note.
 */
export function AdvancedSection({ tracker }: AdvancedSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);

  if (!cfg) return null;

  const tr = cfg.transcription as { cloud_command?: string[] };
  const blocked = isBlocked("transcription.cloud_command");

  return (
    <section id="advanced" className="settings-section">
      <h2 className="settings-section-h">Advanced</h2>
      <p className="settings-section-sub">Cloud transcription command and other power-user knobs</p>

      <AdvancedDisclosure title="Advanced — change with care" note="power-user knobs">
        {/* TRANS-02 (D-04): cloud transcription is the user's OWN command — the
            llm.command trust model. Yulu holds and asks for no cloud credentials.
            This is a command array, never a credential field. */}
        <div className="row">
          <div className="row-label">
            <div>Cloud transcription command</div>
            <div className="row-help">Your own cloud transcription command — spawned with the audio. Yulu holds no cloud keys.</div>
          </div>
          <div className="row-value">
            {blocked ? (
              <span className="value-disabled">
                <span className="value-disabled-text">{(tr.cloud_command ?? []).join(" ") || "(unset)"}</span>
                <span className="value-disabled-note">录音中不可改</span>
              </span>
            ) : (
              <CommandEditor
                value={tr.cloud_command ?? []}
                onChange={(next) => commit("transcription.cloud_command")(next)}
              />
            )}
          </div>
          <div className="row-status" />
        </div>
      </AdvancedDisclosure>
    </section>
  );
}
