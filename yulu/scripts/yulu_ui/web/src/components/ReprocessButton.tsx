import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import "./ReprocessButton.css";

export type ReprocessButtonState = "idle" | "running" | "done" | "failed";

export interface ReprocessButtonProps {
  label: string;
  icon: ReactNode;
  state: ReprocessButtonState;
  error?: string;
  onClick: () => void;
  disabled?: boolean;
  disabledReason?: string;
}

const DONE_HOLD_MS = 2000;

/**
 * 4-state pill button for triggering re-transcribe / re-summarize.
 *
 * - idle: clickable, shows label + icon
 * - running: disabled, spinner + "Running…" text
 * - done: ✓ + "Done" for 2s then auto-falls back to idle visual
 * - failed: ⚠ + label, clickable to retry, error in tooltip
 */
export function ReprocessButton({
  label, icon, state, error, onClick, disabled, disabledReason,
}: ReprocessButtonProps) {
  const [visualState, setVisualState] = useState<ReprocessButtonState>(state);

  useEffect(() => {
    if (state === "done") {
      setVisualState("done");
      const timer = setTimeout(() => setVisualState("idle"), DONE_HOLD_MS);
      return () => clearTimeout(timer);
    }
    setVisualState(state);
    return undefined;
  }, [state]);

  const hardDisabled = disabled === true;
  const interactionDisabled = hardDisabled || visualState === "running";
  const title = hardDisabled
    ? disabledReason
    : visualState === "failed" && error
      ? error
      : undefined;

  const handleClick = () => {
    if (interactionDisabled) return;
    onClick();
  };

  let content: ReactNode;
  let aria: string;
  switch (visualState) {
    case "running":
      content = (
        <>
          <Loader2 size={14} strokeWidth={1.75} className="rpb-spin" />
          <span>Running…</span>
        </>
      );
      aria = "Running";
      break;
    case "done":
      content = (
        <>
          <Check size={14} strokeWidth={2} />
          <span>Done</span>
        </>
      );
      aria = "Done";
      break;
    case "failed":
      content = (
        <>
          <AlertCircle size={14} strokeWidth={1.75} />
          <span>{label}</span>
        </>
      );
      aria = `${label} (failed${error ? `: ${error}` : ""})`;
      break;
    default:
      content = (
        <>
          {icon}
          <span>{label}</span>
        </>
      );
      aria = label;
  }

  return (
    <button
      type="button"
      className={`rpb rpb-${visualState}`}
      onClick={handleClick}
      disabled={interactionDisabled}
      aria-label={aria}
      title={title}
    >
      {content}
    </button>
  );
}
