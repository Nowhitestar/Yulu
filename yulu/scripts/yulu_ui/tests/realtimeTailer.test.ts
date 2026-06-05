import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRealtimeTailer, type RealtimeTailer } from "../src/realtimeTailer.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";

describe("realtimeTailer", () => {
  let root: string;
  let voicemailsDir: string;
  let moviesDir: string;
  let tailer: RealtimeTailer | undefined;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["live-transcript"][];
  let nowMs: number;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu_rt_"));
    voicemailsDir = join(root, "voicemails");
    moviesDir = root;
    mkdirSync(voicemailsDir);
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("live-transcript", (m) => events.push(m));
    nowMs = 1_000_000_000_000;
  });

  afterEach(() => {
    tailer?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function makeTailer() {
    return startRealtimeTailer({
      voicemailsDir, moviesDir, pubsub,
      now: () => nowMs,
      activeWindowMs: 90_000,
    });
  }

  function writeRealtime(dir: string, stem: string, text: string, mtimeMs = nowMs) {
    const p = join(dir, `${stem}.realtime.transcript.txt`);
    writeFileSync(p, text);
    const sec = mtimeMs / 1000;
    utimesSync(p, sec, sec);
    return p;
  }

  it("publishes active live-transcript for a recently-modified realtime file", () => {
    writeRealtime(voicemailsDir, "voicemail_20260601_120000", "[Me] hello world\n");
    tailer = makeTailer();
    tailer.scanOnce();
    const active = events.filter((e) => e.active);
    expect(active.length).toBeGreaterThan(0);
    const last = active[active.length - 1]!;
    expect(last.stem).toBe("voicemail_20260601_120000");
    expect(last.kind).toBe("voicemail");
    expect(last.text).toContain("hello world");
  });

  it("classifies a meeting (movies dir) recording with kind=meeting", () => {
    writeRealtime(moviesDir, "Standup_20260601_120000", "[Me] standup notes\n");
    tailer = makeTailer();
    tailer.scanOnce();
    const last = events.filter((e) => e.active).at(-1)!;
    expect(last.kind).toBe("meeting");
    expect(last.stem).toBe("Standup_20260601_120000");
  });

  it("treats a stale (old-mtime) realtime file as NOT active", () => {
    // mtime 5 minutes in the past — outside the 90s active window.
    writeRealtime(voicemailsDir, "voicemail_20260601_120000", "[Me] old\n", nowMs - 300_000);
    tailer = makeTailer();
    events.length = 0;
    tailer.scanOnce();
    expect(events.every((e) => e.active === false)).toBe(true);
  });

  it("emits active:false once when an active recording goes stale", () => {
    const stem = "voicemail_20260601_120000";
    writeRealtime(voicemailsDir, stem, "[Me] live\n");
    tailer = makeTailer();
    tailer.scanOnce();
    expect(events.at(-1)!.active).toBe(true);

    // Advance time past the window so the file is now stale (recording stopped).
    nowMs += 120_000;
    events.length = 0;
    tailer.scanOnce();
    expect(events.length).toBe(1);
    expect(events[0]!.active).toBe(false);
  });

  it("only re-publishes when the transcript grows (dedupes unchanged scans)", () => {
    const stem = "voicemail_20260601_120000";
    writeRealtime(voicemailsDir, stem, "[Me] one\n");
    tailer = makeTailer();
    tailer.scanOnce();
    const afterFirst = events.length;

    tailer.scanOnce(); // no change → no new event
    expect(events.length).toBe(afterFirst);

    writeRealtime(voicemailsDir, stem, "[Me] one\n[Me] two\n"); // grew
    tailer.scanOnce();
    expect(events.length).toBeGreaterThan(afterFirst);
    expect(events.at(-1)!.text).toContain("two");
  });

  it("picks the most-recently-modified realtime file when several exist", () => {
    writeRealtime(voicemailsDir, "voicemail_20260601_120000", "[Me] older\n", nowMs - 5_000);
    writeRealtime(moviesDir, "Meeting_20260601_120500", "[Me] newest\n", nowMs - 100);
    tailer = makeTailer();
    tailer.scanOnce();
    const last = events.filter((e) => e.active).at(-1)!;
    expect(last.stem).toBe("Meeting_20260601_120500");
  });

  it("does not throw when watched dirs are missing", () => {
    expect(() => {
      tailer = startRealtimeTailer({
        voicemailsDir: join(root, "nope-vm"),
        moviesDir: join(root, "nope-mt"),
        pubsub,
        now: () => nowMs,
      });
    }).not.toThrow();
  });

  it("ignores non-realtime files in the dir", () => {
    writeFileSync(join(voicemailsDir, "voicemail_20260601_120000.wav"), Buffer.alloc(0));
    writeFileSync(join(voicemailsDir, "voicemail_20260601_120000.transcript.txt"), "final");
    tailer = makeTailer();
    events.length = 0;
    tailer.scanOnce();
    expect(events.every((e) => e.active === false)).toBe(true);
  });
});
