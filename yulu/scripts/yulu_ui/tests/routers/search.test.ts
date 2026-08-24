import { describe, it, expect, vi, beforeEach } from "vitest";
import { formatConversationSources, normalizeConversationSources, searchRouter } from "../../src/routers/search.js";
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
  it("normalizes only bounded local meeting sources for conversation", () => {
    const hits = Array.from({ length: 10 }, (_, index) => ({
      kind: "meeting_summary",
      stem: `Meeting_${index}`,
      meetingTitle: index === 0 ? `Title ${"界".repeat(10_000)}` : `Meeting ${index}`,
      recordedAt: index === 0 ? `2026-${"1".repeat(10_000)}` : "2026-08-24T10:00:00",
      sourcePath: `/private/meeting-${index}.summary.md`,
      score: 10 - index,
      snippet: index === 0
        ? `[hit]项目[/hit]\u0000 ${"😀".repeat(700)}`
        : `excerpt ${index}`,
    }));
    hits.splice(2, 0, { ...hits[1]!, snippet: "duplicate" });
    hits.splice(3, 0, { ...hits[1]!, kind: "calendar_event" });
    hits.splice(4, 0, { ...hits[1]!, stem: "", snippet: "malformed" });

    const sources = normalizeConversationSources(hits);

    expect(sources).toHaveLength(8);
    expect(sources.map((source) => source.ref)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(sources[0]).toMatchObject({
      kind: "meeting_summary",
      stem: "Meeting_0",
      sourcePath: "/private/meeting-0.summary.md",
      url: "/inbox/Meeting_0",
    });
    expect(sources[0]!.title).toHaveLength(200);
    expect(sources[0]!.recordedAt).toHaveLength(64);
    expect(sources[0]!.snippet).not.toMatch(/\[\/?hit\]|\u0000|[\uD800-\uDFFF]$/u);
    expect(sources.every((source) => source.snippet.length <= 1_200)).toBe(true);
    expect(sources.reduce((total, source) => total + source.snippet.length, 0)).toBeLessThanOrEqual(6_000);
    expect(sources.reduce((total, source) =>
      total + source.title.length + source.recordedAt.length + source.kind.length + source.snippet.length, 0)
    ).toBeLessThanOrEqual(6_000);
    expect(formatConversationSources(sources).length).toBeLessThanOrEqual(6_000);
    expect(sources.filter((source) => source.stem === "Meeting_1")).toHaveLength(1);
  });

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
