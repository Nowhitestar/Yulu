import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startInboxWatcher, type InboxWatcher } from "../src/inboxWatcher.js";
import { PubSub } from "../src/pubsub.js";
import type { AppChannels } from "../src/pubsub.js";

describe("inboxWatcher", () => {
  let root: string;
  let moviesDir: string;
  let watcher: InboxWatcher | undefined;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["recordings-changed"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu_iw_"));
    moviesDir = root;
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("recordings-changed", (m) => events.push(m));
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function waitMs(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  it("publishes recordings-changed when a new .wav appears", async () => {
    watcher = startInboxWatcher({ moviesDir, pubsub });
    await waitMs(50); // let fs.watch initialize
    writeFileSync(join(moviesDir, "Memo_20260526_180000.wav"), Buffer.alloc(0));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
    expect(events[0]).toEqual({ reason: "changed" });
  });

  it("publishes recordings-changed when a .summary.md appears", async () => {
    writeFileSync(join(moviesDir, "Memo_20260526_180000.wav"), Buffer.alloc(0));
    watcher = startInboxWatcher({ moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(moviesDir, "Memo_20260526_180000.summary.md"), "# summary");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
  });

  it("publishes recordings-changed when a meeting .wav appears", async () => {
    watcher = startInboxWatcher({ moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(moviesDir, "Standup_20260526_180000.wav"), Buffer.alloc(0));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
  });

  it("ignores non-relevant files (.DS_Store, partial writes)", async () => {
    watcher = startInboxWatcher({ moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(moviesDir, ".DS_Store"), "x");
    writeFileSync(join(moviesDir, "Memo_20260526_180000.wav.tmp"), Buffer.alloc(0));
    await waitMs(200);
    expect(events).toEqual([]);
  });

  it("does not throw when the watched dir is missing — falls back silently", () => {
    expect(() => {
      watcher = startInboxWatcher({
        moviesDir: join(root, "nonexistent-mt"),
        pubsub,
      });
    }).not.toThrow();
  });

  it("debounces rapid creates: 5 files within 100 ms emit no more than 2 events", async () => {
    watcher = startInboxWatcher({ moviesDir, pubsub });
    await waitMs(50);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(moviesDir, `Memo_20260526_18000${i}.wav`), Buffer.alloc(0));
    }
    await waitMs(300);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);
  });
});
