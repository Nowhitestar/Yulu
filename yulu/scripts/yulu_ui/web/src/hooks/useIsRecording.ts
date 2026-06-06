// web/src/hooks/useIsRecording.ts
import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";

type RecState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown" | "unknown";

interface RecordingMsg { state: RecState }

/**
 * True while a capture is in flight — `recording` (mic open) or `processing`
 * (transcription running). Hydrates once from `trpc.recording.state`, then
 * follows live `recording` WebSocket events (same source the menu-bar Pill
 * uses, so they share the react-query cache). Used to guard restart-class
 * settings edits, which would interrupt an in-progress recording.
 */
export function useIsRecording(): boolean {
  const initial = trpc.recording.state.useQuery();
  const [state, setState] = useState<RecState>("unknown");
  const hydrated = useRef(false);

  // Hydrate from the bootstrap fetch exactly once; after that WebSocket events
  // own the state (mirrors Pill — avoids the query result re-stomping live
  // transitions on every re-render).
  useEffect(() => {
    if (hydrated.current) return;
    const s = (initial.data as { state?: RecState } | undefined)?.state;
    if (s) { hydrated.current = true; setState(s); }
  }, [initial.data]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    if (msg.state) setState(msg.state);
  });

  return state === "recording" || state === "processing";
}
