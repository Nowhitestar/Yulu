import { CircleAlert, Clock3, Loader2 } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./RecordingStatusBadge.css";

export type RecordingJobState =
  | "idle"
  | "transcribing"
  | "summarizing"
  | "failed"
  | "recording_failed"
  | "transcription_failed"
  | "summary_failed"
  | "agent_queued"
  | "awaiting_agent"
  | "awaiting_policy"
  | "agent_failed"
  | "sending_notion"
  | "delivery_unverified"
  | "execution_unverified"
  | string;

export interface RecordingStatusBadgeProps {
  state: RecordingJobState;
  error?: string;
  /** Compact variant for dense list rows (no spinner text). */
  compact?: boolean;
}

// i18n key per known job state. Unknown / idle states render no badge.
const LABEL_KEYS: Record<string, string> = {
  transcribing: "status.transcribing",
  summarizing: "status.summarizing",
  failed: "status.failed",
  recording_failed: "status.recording_failed",
  transcription_failed: "status.transcription_failed",
  summary_failed: "status.summary_failed",
  agent_queued: "status.agent_queued",
  awaiting_agent: "status.awaiting_agent",
  awaiting_policy: "status.awaiting_policy",
  agent_failed: "status.agent_failed",
  sending_notion: "status.sending_notion",
  delivery_unverified: "status.delivery_unverified",
  execution_unverified: "status.execution_unverified",
};

/**
 * Shows a real per-recording job state. `transcribing`/`summarizing` render an
 * animated spinner; `failed` renders a warning glyph + tooltip with the error.
 * `idle` (and any unknown state) render nothing — there's no badge at rest.
 */
export function RecordingStatusBadge({ state, error, compact }: RecordingStatusBadgeProps) {
  const t = useT();
  if (state === "idle" || !(state in LABEL_KEYS)) return null;
  const failed = state === "failed" || state.endsWith("_failed") ||
    state === "delivery_unverified" || state === "execution_unverified";
  const waiting = state === "agent_queued" || state === "awaiting_agent" || state === "awaiting_policy";
  const label = t(LABEL_KEYS[state]!);
  // In a list the state is an icon alone; its name and any reason are one hover away.
  const size = compact ? 15 : 12;
  return (
    <span
      className={`rec-status rec-status-${failed ? "failed" : "busy"}`}
      data-testid="recording-status"
      data-state={state}
      role={compact ? "img" : undefined}
      aria-label={compact ? label : undefined}
      title={failed && error ? error : compact ? label : undefined}
    >
      {failed
        ? <CircleAlert size={size} strokeWidth={1.9} />
        : waiting
          ? <Clock3 size={size} strokeWidth={1.9} />
          : <Loader2 size={size} strokeWidth={2} className="rec-status-spin" />}
      {!compact && <span>{label}</span>}
    </span>
  );
}
