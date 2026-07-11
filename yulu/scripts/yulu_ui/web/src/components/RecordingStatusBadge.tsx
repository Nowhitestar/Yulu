import { Loader2, AlertTriangle, Clock3 } from "lucide-react";
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
};

/**
 * Shows a real per-recording job state. `transcribing`/`summarizing` render an
 * animated spinner; `failed` renders a warning glyph + tooltip with the error.
 * `idle` (and any unknown state) render nothing — there's no badge at rest.
 */
export function RecordingStatusBadge({ state, error, compact }: RecordingStatusBadgeProps) {
  const t = useT();
  if (state === "idle" || !(state in LABEL_KEYS)) return null;
  const failed = state === "failed" || state.endsWith("_failed") || state === "delivery_unverified";
  const waiting = state === "agent_queued" || state === "awaiting_agent" || state === "awaiting_policy";
  return (
    <span
      className={`rec-status rec-status-${failed ? "failed" : "busy"}`}
      data-testid="recording-status"
      data-state={state}
      title={failed && error ? error : undefined}
    >
      {failed
        ? <AlertTriangle size={11} strokeWidth={2} />
        : waiting
          ? <Clock3 size={11} strokeWidth={2} />
          : <Loader2 size={11} strokeWidth={2.25} className="rec-status-spin" />}
      {!compact && <span>{t(LABEL_KEYS[state]!)}</span>}
    </span>
  );
}
