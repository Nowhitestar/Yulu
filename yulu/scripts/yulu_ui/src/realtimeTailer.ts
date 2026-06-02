import {
  watch, type FSWatcher, existsSync, readdirSync, statSync,
  readFileSync, openSync, readSync, closeSync,
} from "node:fs";
import { join, basename } from "node:path";
import type { PubSub, AppChannels } from "./pubsub.js";

/**
 * Live-caption tailer.
 *
 * While a recording is in progress, realtime_transcribe.py appends partials to
 * `<stem>.realtime.transcript.txt` next to the WAV. This watcher finds the
 * `.realtime.transcript.txt` that is *currently growing* (mtime within
 * ACTIVE_WINDOW_MS) across the voicemails + meetings dirs, reads its full text,
 * and publishes it on the `live-transcript` channel so the :7777 UI can show
 * captions during recording.
 *
 * It needs no cross-process signal: "recently modified realtime transcript" IS
 * the active-recording signal. When nothing has grown recently it publishes
 * `{ active: false }` once (the panel hides). fs.watch is best-effort, so a
 * low-rate interval poll backs it up (also detects mtime aging into inactive).
 */

const REALTIME_SUFFIX = ".realtime.transcript.txt";
// A realtime transcript whose mtime is within this window is treated as an
// in-progress recording. The live tail writes a partial roughly every
// chunk_sec (default 15s) so this must comfortably exceed a chunk interval.
const ACTIVE_WINDOW_MS = 90_000;
const POLL_MS = 1_000;
const MAX_TEXT_BYTES = 256 * 1024; // cap what we ship to the browser

export interface RealtimeTailerOptions {
  voicemailsDir: string;
  moviesDir: string;
  pubsub: PubSub<AppChannels>;
  /** Override "now" + the active window in tests. */
  now?: () => number;
  activeWindowMs?: number;
}

export interface RealtimeTailer {
  stop(): void;
  /** Exposed for tests: run one scan synchronously. */
  scanOnce(): void;
}

interface ActiveFile {
  path: string;
  stem: string;
  kind: "voicemail" | "meeting";
}

function stemFromRealtime(filename: string): string {
  return basename(filename).slice(0, -REALTIME_SUFFIX.length);
}

export function startRealtimeTailer(opts: RealtimeTailerOptions): RealtimeTailer {
  const now = opts.now ?? (() => Date.now());
  const activeWindowMs = opts.activeWindowMs ?? ACTIVE_WINDOW_MS;
  const watchers: FSWatcher[] = [];

  // Last published snapshot so we only emit on change.
  let lastKey = "";       // `${path}:${size}` — changes when the active file or its content changes
  let lastActive = false;

  const dirs: Array<{ dir: string; kind: "voicemail" | "meeting" }> = [
    { dir: opts.voicemailsDir, kind: "voicemail" },
    { dir: opts.moviesDir, kind: "meeting" },
  ];

  function findActiveFile(): ActiveFile | null {
    let best: (ActiveFile & { mtimeMs: number }) | null = null;
    const cutoff = now() - activeWindowMs;
    for (const { dir, kind } of dirs) {
      if (!existsSync(dir)) continue;
      let names: string[];
      try { names = readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith(REALTIME_SUFFIX)) continue;
        const path = join(dir, name);
        let mtimeMs: number;
        try { mtimeMs = statSync(path).mtimeMs; } catch { continue; }
        if (mtimeMs < cutoff) continue; // not actively growing → not "live"
        if (!best || mtimeMs > best.mtimeMs) {
          best = { path, stem: stemFromRealtime(name), kind, mtimeMs };
        }
      }
    }
    if (!best) return null;
    return { path: best.path, stem: best.stem, kind: best.kind };
  }

  function readText(path: string): string {
    try {
      const stat = statSync(path);
      if (stat.size <= MAX_TEXT_BYTES) {
        return readFileSync(path, "utf8");
      }
      // Tail the last MAX_TEXT_BYTES so the browser payload stays bounded for
      // very long recordings; the leading partial line is dropped on purpose.
      const buf = Buffer.alloc(MAX_TEXT_BYTES);
      const fd = openSync(path, "r");
      try {
        readSync(fd, buf, 0, MAX_TEXT_BYTES, stat.size - MAX_TEXT_BYTES);
      } finally {
        closeSync(fd);
      }
      const text = buf.toString("utf8");
      const nl = text.indexOf("\n");
      return nl >= 0 ? text.slice(nl + 1) : text;
    } catch {
      return "";
    }
  }

  function scanOnce(): void {
    const active = findActiveFile();
    if (!active) {
      if (lastActive) {
        lastActive = false;
        lastKey = "";
        opts.pubsub.publish("live-transcript", { active: false });
      }
      return;
    }
    let size: number;
    try { size = statSync(active.path).size; } catch { return; }
    const key = `${active.path}:${size}`;
    if (key === lastKey && lastActive) return; // unchanged
    lastKey = key;
    lastActive = true;
    opts.pubsub.publish("live-transcript", {
      active: true,
      stem: active.stem,
      kind: active.kind,
      text: readText(active.path),
    });
  }

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    const name = typeof filename === "string" ? filename : filename?.toString() ?? "";
    if (name && !name.endsWith(REALTIME_SUFFIX)) return;
    scanOnce();
  };

  for (const { dir } of dirs) {
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, { persistent: false }, onEvent);
      w.on("error", () => { /* swallow; fs.watch is best-effort */ });
      watchers.push(w);
    } catch {
      // Filesystem may not support fs.watch — the interval poll still drives scans.
    }
  }

  // Backup poll: catches growth fs.watch missed AND ages an active file into
  // inactive once its mtime falls outside the window (recording stopped).
  const interval = setInterval(scanOnce, POLL_MS);
  if (typeof interval.unref === "function") interval.unref();

  // Prime once so a client connecting mid-recording gets state immediately.
  scanOnce();

  return {
    stop() {
      clearInterval(interval);
      for (const w of watchers) w.close();
    },
    scanOnce,
  };
}
