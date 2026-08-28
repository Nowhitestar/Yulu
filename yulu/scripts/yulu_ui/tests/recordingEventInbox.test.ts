import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startRecordingEventInbox, type RecordingEventInbox } from "../src/recordingEventInbox.js";
import {
  InvalidRecordingCompletionError,
  RecordingPipelinePolicyDisabledError,
  type RecordingPipeline,
} from "../src/recordingPipeline.js";

describe("recording completion spool", () => {
  let root = "";
  let inbox: RecordingEventInbox | undefined;
  afterEach(() => {
    inbox?.stop();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("replays a durable event exactly once", async () => {
    root = mkdtempSync(join(tmpdir(), "yulu-recording-events-"));
    const calls: unknown[] = [];
    const pipeline = {
      enqueueCompletion: (input: unknown) => { calls.push(input); return { task: {}, created: true }; },
    } as unknown as RecordingPipeline;
    inbox = startRecordingEventInbox({ dir: root, pipeline, rescanMs: 10 });
    const path = join(root, "019f0000-0000-7000-8000-000000000001.json");
    writeFileSync(path, JSON.stringify({ audioPath: "/movies/Demo_20260711_120000.wav", title: "Demo", sendToNotion: true }));
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    expect(calls).toEqual([{
      audioPath: "/movies/Demo_20260711_120000.wav",
      title: "Demo",
    }]);
    expect(existsSync(path)).toBe(false);
    inbox.scan();
    expect(calls).toHaveLength(1);
  });

  it("quarantines malformed events", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-recording-events-"));
    writeFileSync(join(root, "019f0000-0000-7000-8000-000000000001.json"), "{}");
    inbox = startRecordingEventInbox({
      dir: root,
      pipeline: { enqueueCompletion: () => { throw new Error("must not run"); } } as unknown as RecordingPipeline,
    });
    expect(readdirSync(root)).toEqual(["019f0000-0000-7000-8000-000000000001.json.rejected"]);
  });

  it("preserves transient Host failures and replays them on the periodic scan", async () => {
    root = mkdtempSync(join(tmpdir(), "yulu-recording-events-"));
    const path = join(root, "019f0000-0000-7000-8000-000000000001.json");
    writeFileSync(path, JSON.stringify({ audioPath: "/movies/Demo_20260711_120000.wav" }));
    let attempts = 0;
    inbox = startRecordingEventInbox({
      dir: root,
      rescanMs: 10,
      pipeline: {
        enqueueCompletion: () => {
          attempts += 1;
          if (attempts === 1) throw new SyntaxError("prompt cache JSON is temporarily unreadable");
          return { task: {}, created: true };
        },
      } as unknown as RecordingPipeline,
    });
    expect(existsSync(path)).toBe(true);
    await vi.waitFor(() => expect(attempts).toBe(2));
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root).some((name) => name.endsWith(".rejected"))).toBe(false);
  });

  it("quarantines explicitly permanent recording validation failures", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-recording-events-"));
    const path = join(root, "019f0000-0000-7000-8000-000000000001.json");
    writeFileSync(path, JSON.stringify({ audioPath: "/movies/missing.wav" }));
    inbox = startRecordingEventInbox({
      dir: root,
      pipeline: {
        enqueueCompletion: () => { throw new InvalidRecordingCompletionError("recording WAV is missing"); },
      } as unknown as RecordingPipeline,
    });
    expect(readdirSync(root)).toEqual(["019f0000-0000-7000-8000-000000000001.json.rejected"]);
  });

  it("archives policy-disabled events so they never become an implicit future backlog", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-recording-events-"));
    const path = join(root, "019f0000-0000-7000-8000-000000000001.json");
    writeFileSync(path, JSON.stringify({ audioPath: "/movies/Demo_20260711_120000.wav" }));
    inbox = startRecordingEventInbox({
      dir: root,
      pipeline: {
        enqueueCompletion: () => {
          throw new RecordingPipelinePolicyDisabledError("automatic processing is paused");
        },
      } as unknown as RecordingPipeline,
    });

    expect(readdirSync(root)).toEqual([
      "019f0000-0000-7000-8000-000000000001.json.policy-disabled",
    ]);
    inbox.scan();
    expect(readdirSync(root)).toHaveLength(1);
  });
});
