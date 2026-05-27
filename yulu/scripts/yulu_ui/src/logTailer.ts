import { watch, type FSWatcher, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { PubSub, AppChannels } from "./pubsub.js";

const DAEMON_SHORT_NAMES = [
  "audiodaemon", "sttdaemon", "agentqueue", "statusagent",
  "scheduler", "detector", "calendar", "ui",
] as const;

const READ_CHUNK_SIZE = 64 * 1024;

export interface LogTailerOptions {
  configDir: string;
  pubsub: PubSub<AppChannels>;
}

export interface LogTailer {
  stop(): void;
}

/**
 * Tails all known yulu daemon log files in `configDir`. On change, reads the
 * bytes appended since last poll, splits on newline, and publishes one event
 * per line via the `logs` channel.
 *
 * Strategy: open each existing file read-only, record current size, watch
 * via fs.watch. On change events, read from last position to current size
 * and emit. Empty trailing lines are skipped.
 */
export function startLogTailer(opts: LogTailerOptions): LogTailer {
  const watchers: FSWatcher[] = [];
  const fds: number[] = [];
  const positions = new Map<string, number>();   // daemon short name → last read offset
  const pending = new Set<string>();              // debounce: in-flight reads per daemon

  function pollFile(shortName: string, path: string, fd: number) {
    if (pending.has(shortName)) return;
    pending.add(shortName);
    queueMicrotask(() => {
      try {
        const stat = statSync(path);
        const lastPos = positions.get(shortName) ?? stat.size;
        if (stat.size <= lastPos) {
          // File truncated (rotation) — reset to current end and skip
          positions.set(shortName, stat.size);
          return;
        }
        let pos = lastPos;
        const buf = Buffer.alloc(READ_CHUNK_SIZE);
        let leftover = "";
        while (pos < stat.size) {
          const toRead = Math.min(READ_CHUNK_SIZE, stat.size - pos);
          const n = readSync(fd, buf, 0, toRead, pos);
          if (n <= 0) break;
          const text = leftover + buf.subarray(0, n).toString("utf8");
          const lines = text.split("\n");
          leftover = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length === 0) continue;
            opts.pubsub.publish("logs", { name: shortName, line, ts: Date.now() });
          }
          pos += n;
        }
        positions.set(shortName, pos);
      } catch {
        // best-effort; on error, skip this poll cycle
      } finally {
        pending.delete(shortName);
      }
    });
  }

  for (const shortName of DAEMON_SHORT_NAMES) {
    const path = join(opts.configDir, `${shortName}.log`);
    if (!existsSync(path)) continue;
    try {
      const fd = openSync(path, "r");
      positions.set(shortName, statSync(path).size);   // start tailing from end
      fds.push(fd);
      const w = watch(path, { persistent: false }, () => pollFile(shortName, path, fd));
      w.on("error", () => { /* swallow */ });
      watchers.push(w);
    } catch {
      // Skip files we can't open
    }
  }

  return {
    stop() {
      for (const w of watchers) w.close();
      for (const fd of fds) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    },
  };
}
