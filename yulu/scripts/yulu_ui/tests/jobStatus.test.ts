import { describe, it, expect, beforeEach } from "vitest";
import { JobRegistry, type JobStatus } from "../src/jobStatus.js";

function mkJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    stem: "voicemail_20260101_120000",
    action: "transcribe",
    state: "transcribing",
    startedAt: 0,
    jobId: "j1",
    ...overrides,
  };
}

describe("JobRegistry", () => {
  let r: JobRegistry;
  beforeEach(() => { r = new JobRegistry(); });

  it("get() returns undefined when nothing set", () => {
    expect(r.get("missing")).toBeUndefined();
  });

  it("set() then get() returns the same record", () => {
    const job = mkJob();
    r.set(job);
    expect(r.get(job.stem)).toEqual(job);
  });

  it("set() replaces an existing record for the same stem", () => {
    r.set(mkJob({ jobId: "j1", state: "transcribing" }));
    r.set(mkJob({ jobId: "j2", state: "summarizing" }));
    expect(r.get("voicemail_20260101_120000")?.jobId).toBe("j2");
    expect(r.get("voicemail_20260101_120000")?.state).toBe("summarizing");
  });

  it("clear() removes a stem", () => {
    r.set(mkJob());
    r.clear(mkJob().stem);
    expect(r.get(mkJob().stem)).toBeUndefined();
  });

  it("clear() on missing stem is a no-op", () => {
    expect(() => r.clear("missing")).not.toThrow();
  });

  it("snapshot() returns a copy not a live reference", () => {
    r.set(mkJob());
    const snap = r.snapshot();
    r.clear(mkJob().stem);
    expect(snap.get(mkJob().stem)).toBeDefined();
    expect(r.get(mkJob().stem)).toBeUndefined();
  });

  it("snapshot() reflects multiple stems", () => {
    r.set(mkJob({ stem: "a" }));
    r.set(mkJob({ stem: "b" }));
    const snap = r.snapshot();
    expect(snap.size).toBe(2);
    expect(snap.has("a")).toBe(true);
    expect(snap.has("b")).toBe(true);
  });
});
