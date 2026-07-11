import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLogTailer, type LogTailer } from "../src/logTailer.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";

describe("logTailer", () => {
  let root: string;
  let tailer: LogTailer | undefined;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["logs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu_lt_"));
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("logs", (m) => events.push(m));
  });
  afterEach(() => {
    tailer?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function waitMs(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  it("publishes new lines appended to a watched log file", async () => {
    writeFileSync(join(root, "audiodaemon.log"), "initial\n");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "audiodaemon.log"), "new line 1\nnew line 2\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), { timeout: 1000 });
    const lines = events.filter((e) => e.name === "audiodaemon").map((e) => e.line);
    expect(lines).toEqual(expect.arrayContaining(["new line 1", "new line 2"]));
  });

  it("uses the short daemon name (sans com.yulu. prefix) in published events", async () => {
    writeFileSync(join(root, "statusagent.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "statusagent.log"), "hello\n");
    await vi.waitFor(() => expect(events.some((e) => e.name === "statusagent")).toBe(true));
  });

  it("skips missing log files silently (no throw)", () => {
    expect(() => {
      tailer = startLogTailer({ configDir: root, pubsub });   // root has no .log files
    }).not.toThrow();
  });

  it("emits events with numeric ts (timestamp in ms)", async () => {
    writeFileSync(join(root, "ui.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "ui.log"), "x\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(typeof events[0]!.ts).toBe("number");
    expect(events[0]!.ts).toBeGreaterThan(0);
  });

  it("ignores empty trailing lines (final \\n does not emit an empty-string event)", async () => {
    writeFileSync(join(root, "scheduler.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "scheduler.log"), "one\ntwo\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    expect(events.every((e) => e.line !== "")).toBe(true);
  });

  it("stop() closes watchers (no further events after stop + append)", async () => {
    writeFileSync(join(root, "detector.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    tailer.stop();
    tailer = undefined;
    const before = events.length;
    appendFileSync(join(root, "detector.log"), "after stop\n");
    await waitMs(200);
    expect(events.length).toBe(before);
  });

  it("survives logrotate-style rotation (mv + new inode at same path)", async () => {
    const renameSync = (await import("node:fs")).renameSync;
    const logPath = join(root, "audiodaemon.log");
    writeFileSync(logPath, "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);

    // First write — verify the tailer is alive.
    appendFileSync(logPath, "before rotation\n");
    await vi.waitFor(() => expect(events.some((e) => e.line === "before rotation")).toBe(true), { timeout: 1000 });

    // Rotate: rename, recreate fresh file at the same path with new inode.
    renameSync(logPath, join(root, "audiodaemon.log.1"));
    writeFileSync(logPath, "");           // new inode at the original path
    await waitMs(100);
    appendFileSync(logPath, "after rotation\n");

    // The tailer should publish the post-rotation line — meaning it noticed
    // the inode change, closed the old fd, and reopened the new file.
    await vi.waitFor(
      () => expect(events.some((e) => e.line === "after rotation")).toBe(true),
      { timeout: 2000 },
    );
  });
});
