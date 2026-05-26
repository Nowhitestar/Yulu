import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { meetingsRouter } from "../../src/routers/meetings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_meet_"));
  mkdirSync(join(dir, "voicemails"));
  writeFileSync(join(dir, "voicemails/voicemail_20260526_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.transcript.txt"), "agenda");
  writeFileSync(join(dir, "WeeklyStandup_20260520_100000.realtime.transcript.txt"), "noisy live");
  writeFileSync(join(dir, "1on1_20260521_140000.wav"), Buffer.alloc(0));
  const ctx = {
    paths: { moviesDir: dir, voicemailsDir: join(dir, "voicemails") },
    pubsub: { publish: () => {} },
  } as unknown as AppContext;
  return { ctx, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("meetingsRouter", () => {
  it("list() excludes voicemails subdir and matches <title>_DATE_TIME stems", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const rows = await caller.list({});
      const titles = rows.map((r) => r.meetingTitle).sort();
      expect(titles).toEqual(["1on1", "WeeklyStandup"]);
    } finally { cleanup(); }
  });

  it("get() includes realtime transcript when present", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const r = await caller.get({ stem: "WeeklyStandup_20260520_100000" });
      expect(r.transcript).toBe("agenda");
      expect(r.realtime).toBe("noisy live");
    } finally { cleanup(); }
  });
});
