import { describe, it, expect, vi, beforeEach } from "vitest";
import { searchRouter } from "../../src/routers/search.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

beforeEach(() => execFileMock.mockReset());

const FAKE_HITS = {
  hits: [
    { kind: "meeting_summary", stem: "Memo_20260526_100000",
      meeting_title: "Memo", recorded_at: "2026-05-26T10:00:00",
      source_path: "/x/y.md", score: 1.2, snippet: "[hit]OKR[/hit] meeting" }
  ],
  elapsed_ms: 16,
  fallback_used: false,
  telemetry: { sweep_ms: 12, query_ms: 4, fallback_used: false, hit_count: 1 }
};

function lastCb(args: unknown[]) {
  const last = args[args.length - 1];
  return typeof last === "function" ? (last as (e: unknown, r?: { stdout: string; stderr: string }) => void) : null;
}

describe("searchRouter", () => {
  it("run() spawns python search.cli with --json and returns parsed hits", async () => {
    execFileMock.mockImplementation((...args: unknown[]) => {
      lastCb(args)?.(null, { stdout: JSON.stringify(FAKE_HITS), stderr: "" });
    });
    const ctx = { paths: { scriptDir: "/fake/yulu/scripts" } } as unknown as AppContext;
    const caller = createCaller(searchRouter, ctx);
    const r = await caller.run({ query: "OKR" });
    expect(r.hits.length).toBe(1);
    expect(r.hits[0].meetingTitle).toBe("Memo");
    expect(r.hits[0].recordedAt).toBe("2026-05-26T10:00:00");
    expect(r.hits[0].sourcePath).toBe("/x/y.md");
    expect(r.elapsedMs).toBe(16);
    expect(r.telemetry.fallbackUsed).toBe(false);
    const firstCall = execFileMock.mock.calls.find((c: unknown[]) => c.length > 0);
    expect(firstCall![0]).toBe("python3");
    expect(firstCall![1]).toContain("search.cli");
    expect(firstCall![1]).toContain("--json");
    expect(firstCall![1]).toContain("OKR");
  });
});
