import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
import {
  InvalidRecordingCompletionError,
  RecordingPipelinePolicyDisabledError,
  type RecordingPipeline,
} from "./recordingPipeline.js";

const EVENT_RE = /^[0-9a-f-]+\.json$/i;
const RESCAN_MS = 15_000;

export interface RecordingEventInbox {
  scan(): void;
  stop(): void;
}

export function startRecordingEventInbox(input: {
  dir: string;
  pipeline: RecordingPipeline;
  rescanMs?: number;
}): RecordingEventInbox {
  mkdirSync(input.dir, { recursive: true, mode: 0o700 });
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let rescanTimer: ReturnType<typeof setInterval> | null = null;

  const reject = (path: string) => {
    try { renameSync(path, `${path}.rejected`); } catch { /* preserve original on failure */ }
  };
  const archivePolicyDisabled = (path: string) => {
    try { renameSync(path, `${path}.policy-disabled`); } catch { /* preserve original on failure */ }
  };
  const scan = () => {
    let names: string[];
    try {
      names = readdirSync(input.dir).filter((item) => EVENT_RE.test(item)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(input.dir, name);
      let payload: Record<string, unknown>;
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          reject(path);
          continue;
        }
        payload = parsed as Record<string, unknown>;
      } catch (error) {
        // Only a syntax error from this spool file proves that the event itself
        // is malformed. A SyntaxError thrown later by config/prompt admission is
        // an internal transient failure and must keep the durable event pending.
        if (error instanceof SyntaxError) reject(path);
        continue;
      }
      if (typeof payload.audioPath !== "string" || !payload.audioPath.trim()) {
        reject(path);
        continue;
      }
      try {
        input.pipeline.enqueueCompletion({
          audioPath: payload.audioPath,
          title: typeof payload.title === "string" ? payload.title : undefined,
        });
        unlinkSync(path);
      } catch (error) {
        // Explicitly permanent recording validation failures are quarantined.
        // SQLite contention, config/prompt parsing, and other Host errors keep
        // the durable event in place for the next periodic scan/restart.
        if (error instanceof RecordingPipelinePolicyDisabledError) archivePolicyDisabled(path);
        else if (error instanceof InvalidRecordingCompletionError) reject(path);
      }
    }
  };
  const scheduleScan = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; scan(); }, 50);
  };

  if (existsSync(input.dir)) {
    watcher = watch(input.dir, { persistent: false }, (_event, filename) => {
      // macOS may omit the filename for a directory event. Scan on that signal
      // as well; idempotent admission makes an extra directory pass harmless.
      if (filename === null || EVENT_RE.test(filename)) scheduleScan();
    });
    watcher.on("error", () => { /* periodic scan remains the recovery path */ });
  }
  // Register the watcher before the startup scan so an atomic spool write
  // cannot fall into a scan/watch gap. The interval also recovers from dropped
  // fs events and transient Host failures without waiting for another write.
  scan();
  rescanTimer = setInterval(scan, input.rescanMs ?? RESCAN_MS);
  rescanTimer.unref();
  return {
    scan,
    stop() {
      if (timer) clearTimeout(timer);
      if (rescanTimer) clearInterval(rescanTimer);
      watcher?.close();
    },
  };
}
