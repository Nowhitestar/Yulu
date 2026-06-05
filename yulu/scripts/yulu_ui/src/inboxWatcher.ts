import { watch, type FSWatcher, existsSync } from "node:fs";
import type { PubSub, AppChannels } from "./pubsub.js";

const RELEVANT_RE = /^[^.]+_\d{8}_\d{6}\.(wav|transcript\.txt|summary\.md|raw\.transcript\.txt|realtime\.transcript\.txt|summary\.html)$/;
const DEBOUNCE_MS = 80;

export interface InboxWatcherOptions {
  moviesDir: string;
  pubsub: PubSub<AppChannels>;
}

export interface InboxWatcher {
  stop(): void;
}

/**
 * Watch the recordings directory and emit a recordings-changed WS event
 * whenever a relevant file appears or disappears. Debounces bursts (typical:
 * a recording lands as .wav + .transcript.txt + .summary.md within
 * milliseconds) so the UI doesn't get hammered.
 */
export function startInboxWatcher(opts: InboxWatcherOptions): InboxWatcher {
  const watchers: FSWatcher[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    pendingTimer = null;
    // Emit an "unknown deltas" signal — the recordings list invalidates
    // its query and re-fetches. We don't compute which delta because the
    // fs event is too noisy.
    opts.pubsub.publish("recordings-changed", { reason: "changed" });
  };

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    const name = typeof filename === "string" ? filename : filename?.toString() ?? "";
    if (!name || !RELEVANT_RE.test(name)) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  for (const dir of [opts.moviesDir]) {
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, { persistent: false }, onEvent);
      w.on("error", () => { /* swallow; fs.watch is best-effort */ });
      watchers.push(w);
    } catch {
      // Silently ignore (e.g., the dir is on a filesystem that doesn't support fs.watch)
    }
  }

  return {
    stop() {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      for (const w of watchers) w.close();
    },
  };
}
