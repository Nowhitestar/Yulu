import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AutomationSectionProps {
  tracker: SettingsRestartTracker;
}

/**
 * AutomationSection — meeting auto-detection knobs (P2-3). The detector daemon
 * polls window titles and offers to record when it sees a meeting; these fields
 * are restart-class (the daemon reads them at startup), so useConfigField guards
 * them while a recording is in flight. The large keyword/app match arrays
 * (window_keywords, app_name_hints, …) are intentionally NOT edited here — they
 * land in the P3 "advanced" disclosure.
 */
export function AutomationSection({ tracker }: AutomationSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);

  if (!cfg) return null;

  const md = (cfg.meeting_detection ?? {}) as {
    enabled?: boolean;
    interval_sec?: number;
    stable_sec?: number;
    prompt_cooldown_sec?: number;
  };

  return (
    <section id="automation" className="settings-section">
      <h2 className="settings-section-h">Automation</h2>
      <p className="settings-section-sub">Meeting detection and auto-record prompts</p>

      <InlineEditRow
        label="Meeting detection"
        help="Watch for meeting windows and offer to record. Off = never auto-prompt."
        type="toggle"
        value={md.enabled ?? false}
        onCommit={commit("meeting_detection.enabled") as (v: boolean) => void}
        disabled={isBlocked("meeting_detection.enabled")}
        status={tracker.statusFor("meeting_detection.enabled")}
      />
      <InlineEditRow
        label="Poll interval (s)"
        help="How often to check the foreground window for a meeting."
        type="number"
        min={1}
        step={1}
        value={md.interval_sec ?? 10}
        onCommit={commit("meeting_detection.interval_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.interval_sec")}
        status={tracker.statusFor("meeting_detection.interval_sec")}
      />
      <InlineEditRow
        label="Stable window (s)"
        help="A meeting window must persist this long before prompting (debounce)."
        type="number"
        min={1}
        step={1}
        value={md.stable_sec ?? 15}
        onCommit={commit("meeting_detection.stable_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.stable_sec")}
        status={tracker.statusFor("meeting_detection.stable_sec")}
      />
      <InlineEditRow
        label="Prompt cooldown (s)"
        help="Wait at least this long before prompting again after a dismissal."
        type="number"
        min={0}
        step={1}
        value={md.prompt_cooldown_sec ?? 1800}
        onCommit={commit("meeting_detection.prompt_cooldown_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.prompt_cooldown_sec")}
        status={tracker.statusFor("meeting_detection.prompt_cooldown_sec")}
      />
    </section>
  );
}
