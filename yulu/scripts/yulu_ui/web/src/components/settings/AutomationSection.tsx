import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
import { ArrayField } from "./ArrayField.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AutomationSectionProps {
  tracker: SettingsRestartTracker;
}

// The advanced match arrays — registry key → label/help. The detector matches a
// foreground window against these; they're power-user knobs, hidden behind the
// Advanced disclosure (P3-2).
const MATCH_ARRAYS: Array<{ key: string; label: string; help: string }> = [
  { key: "meeting_detection.window_keywords",        label: "Window title keywords",  help: "A window whose title contains any of these is treated as a meeting." },
  { key: "meeting_detection.app_name_hints",         label: "App name hints",         help: "App names that hint a meeting is in progress." },
  { key: "meeting_detection.target_app_names",       label: "Target app names",       help: "Apps whose windows are scanned for meetings." },
  { key: "meeting_detection.dedicated_meeting_apps", label: "Dedicated meeting apps", help: "Apps that are always a meeting when frontmost (e.g. Zoom)." },
  { key: "meeting_detection.ignore_window_keywords", label: "Ignore window keywords", help: "Windows whose title contains any of these are never a meeting." },
];

/**
 * AutomationSection — meeting auto-detection knobs (P2-3). The detector daemon
 * polls window titles and offers to record when it sees a meeting; these fields
 * are restart-class (the daemon reads them at startup), so useConfigField guards
 * them while a recording is in flight. The large keyword/app match arrays
 * (window_keywords, app_name_hints, …) are edited as string-array chips behind an
 * Advanced disclosure (P3-2).
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
    [key: string]: unknown;
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

      <AdvancedDisclosure title="Advanced — match rules" note="change with care">
        {MATCH_ARRAYS.map(({ key, label, help }) => (
          <ArrayField
            key={key}
            label={label}
            help={help}
            value={Array.isArray(md[key]) ? (md[key] as string[]) : []}
            onChange={(next) => commit(key)(next)}
            blocked={isBlocked(key)}
          />
        ))}
      </AdvancedDisclosure>
    </section>
  );
}
