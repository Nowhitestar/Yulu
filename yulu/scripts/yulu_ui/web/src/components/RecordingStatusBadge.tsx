import { Loader2, AlertTriangle } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./RecordingStatusBadge.css";

export type RecordingJobState = "idle" | "transcribing" | "summarizing" | "failed" | string;

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
};

/**
 * Shows a real per-recording job state. `transcribing`/`summarizing` render an
 * animated spinner; `failed` renders a warning glyph + tooltip with the error.
 * `idle` (and any unknown state) render nothing — there's no badge at rest.
 */
export function RecordingStatusBadge({ state, error, compact }: RecordingStatusBadgeProps) {
  const t = useT();
  if (state === "idle" || !(state in LABEL_KEYS)) return null;
  const failed = state === "failed";
  return (
    <span
      className={`rec-status rec-status-${failed ? "failed" : "busy"}`}
      data-testid="recording-status"
      data-state={state}
      title={failed && error ? error : undefined}
    >
      {failed
        ? <AlertTriangle size={11} strokeWidth={2} />
        : <Loader2 size={11} strokeWidth={2.25} className="rec-status-spin" />}
      {!compact && <span>{t(LABEL_KEYS[state]!)}</span>}
    </span>
  );
}
