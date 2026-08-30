import { watch, type FSWatcher, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { PubSub, AppChannels } from "./pubsub.js";
import { YULU_DAEMON_LOG_SOURCES } from "./daemonLogs.js";

const READ_CHUNK_SIZE = 64 * 1024;
const ROTATION_POLL_MS = 250;

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
 * Rotation safety:
 *   - Truncation (`> file.log`): detected via `stat.size <= lastPos`; position
 *     is reset to `stat.size` and we wait for the next append.
 *   - logrotate (mv + recreate at same path): detected via inode change. We
 *     closeSync the old fd, openSync the new path, and reset position to 0.
 *
 * Because macOS `fs.watch` follows the inode (and so stops firing for the
 * original path after a rename), we also run a low-rate interval poll so
 * rotation is noticed even when the watcher is stranded on the old inode.
 */
export function startLogTailer(opts: LogTailerOptions): LogTailer {
  const watchers = new Map<string, FSWatcher>();
  const fds = new Map<string, number>();
  const positions = new Map<string, number>();
  const inodes = new Map<string, number>();
  const paths = new Map<string, string>();
  const pending = new Set<string>();

  function reopenIfRotated(shortName: string, path: string): boolean {
    /** Returns true if a re-open happened (caller should restart its read loop). */
    try {
      const stat = statSync(path);
      const stored = inodes.get(shortName);
      if (stored !== undefined && stat.ino !== stored) {
        // Inode changed → file was rotated. Close old fd, open new file.
        const oldFd = fds.get(shortName);
        if (oldFd !== undefined) {
          try { closeSync(oldFd); } catch { /* ignore */ }
        }
        const newFd = openSync(path, "r");
        fds.set(shortName, newFd);
        inodes.set(shortName, stat.ino);
        positions.set(shortName, 0);
        // Re-attach watcher to the new inode so subsequent appends fire events.
        const oldWatcher = watchers.get(shortName);
        if (oldWatcher !== undefined) {
          try { oldWatcher.close(); } catch { /* ignore */ }
        }
        try {
          const w = watch(path, { persistent: false }, () => pollFile(shortName, path));
          w.on("error", () => { /* swallow */ });
          watchers.set(shortName, w);
        } catch { /* ignore — interval poll will continue to drive reads */ }
        return true;
      }
    } catch {
      // Path may have been removed between rotation steps; skip this poll.
    }
    return false;
  }

  function pollFile(shortName: string, path: string) {
    if (pending.has(shortName)) return;
    pending.add(shortName);
    queueMicrotask(() => {
      try {
        reopenIfRotated(shortName, path);
        const fd = fds.get(shortName);
        if (fd === undefined) return;
        const stat = statSync(path);
        const lastPos = positions.get(shortName) ?? stat.size;
        if (stat.size <= lastPos) {
          // Truncated in place — reset and bail this cycle.
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

  for (const { shortName, filename } of YULU_DAEMON_LOG_SOURCES) {
    const path = join(opts.configDir, filename);
    if (!existsSync(path)) continue;
    try {
      const fd = openSync(path, "r");
      const stat = statSync(path);
      positions.set(shortName, stat.size);   // start tailing from end
      inodes.set(shortName, stat.ino);
      fds.set(shortName, fd);
      paths.set(shortName, path);
      const w = watch(path, { persistent: false }, () => pollFile(shortName, path));
      w.on("error", () => { /* swallow */ });
      watchers.set(shortName, w);
    } catch {
      // Skip files we can't open
    }
  }

  // Backup interval poll — catches rotation that strands the inode-bound watcher.
  const interval = setInterval(() => {
    for (const [shortName, path] of paths.entries()) {
      pollFile(shortName, path);
    }
  }, ROTATION_POLL_MS);
  if (typeof interval.unref === "function") interval.unref();

  return {
    stop() {
      clearInterval(interval);
      for (const w of watchers.values()) w.close();
      for (const fd of fds.values()) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    },
  };
}
