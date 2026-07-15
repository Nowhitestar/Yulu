// web/src/hooks/useIsRecording.ts
import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";

type RecState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown" | "unknown";

interface RecordingMsg { state: RecState }

/**
 * True while a capture is in flight — `recording` (mic open) or `processing`
 * (transcription running). Uses the same confirmed recording-state poll and
 * live WebSocket fast path as the menu-bar Pill.
 */
export function useIsRecording(): boolean {
  const initial = trpc.recording.state.useQuery(undefined, {
    refetchInterval: 500,
    refetchIntervalInBackground: true,
  });
  const [state, setState] = useState<RecState>("unknown");

  useEffect(() => {
    const s = (initial.data as { state?: RecState } | undefined)?.state;
    if (s) setState((current) => s === "unknown" && current !== "unknown" ? current : s);
  }, [initial.data, initial.dataUpdatedAt]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    if (msg.state) setState(msg.state);
  });

  return state === "recording" || state === "processing" || state === "unknown";
}
