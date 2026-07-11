import { describe, expect, it } from "vitest";
import {
  STANDARD_SUMMARY_INSTRUCTIONS,
  automaticSummaryInstructions,
  recordingDateFromStem,
  renderSummaryInstructions,
  selectAutomaticSummaryPrompt,
} from "../src/promptInstructions.js";

interface PromptRow {
  id: string;
  slug: string;
  name: string;
  category: string;
  content: string;
  is_auto_run: number;
  sort_order: number;
}

function promptDb(rows: PromptRow[]) {
  return {
    prepare: (sql: string) => {
      expect(sql).toContain("category = ? AND is_auto_run = 1");
      expect(sql).toContain("ORDER BY sort_order ASC, slug ASC");
      expect(sql).toContain("LIMIT 1");
      return {
        get: (category: unknown) => rows
          .filter((row) => row.category === category && row.is_auto_run === 1)
          .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))[0],
      };
    },
  };
}

describe("summary instruction rendering", () => {
  it("expands safe metadata and converts every legacy transcript variable to an MCP reference", () => {
    const secretTranscript = "PRIVATE TRANSCRIPT MUST NEVER ENTER THE PROMPT";
    const rendered = renderSummaryInstructions(
      "{{meeting_title}} {{date}} {{transcript}} {{best_transcript}} {{speaker_transcript}} " +
      "{{my_transcript}} {{their_transcript}} {{speaker_list}}",
      { title: "Planning $&", date: "2026-07-11" },
    );

    expect(rendered).toContain("Planning $& 2026-07-11");
    expect(rendered).toContain("recording_task_transcript_read");
    expect(rendered).not.toContain("{{");
    expect(rendered).not.toContain(secretTranscript);
  });

  it("fails closed for unknown and malformed variables", () => {
    expect(() => renderSummaryInstructions("{{unknown}}", { title: "T", date: "2026-07-11" }))
      .toThrow("Unsupported summary template variable(s): unknown");
    expect(() => renderSummaryInstructions("{{ transcript-name }}", { title: "T", date: "2026-07-11" }))
      .toThrow("Malformed summary template variable");
  });

  it("derives the recording-local date from the stem", () => {
    expect(recordingDateFromStem("Team_Sync_20260711_235959")).toBe("2026-07-11");
  });
});

describe("automatic summary prompt selection", () => {
  it("selects exactly the first enabled summary by sort_order then slug", () => {
    const db = promptDb([
      { id: "cleanup", slug: "cleanup", name: "Cleanup", category: "cleanup", content: "wrong category", is_auto_run: 1, sort_order: -100 },
      { id: "disabled", slug: "disabled", name: "Disabled", category: "summary", content: "disabled", is_auto_run: 0, sort_order: -100 },
      { id: "z", slug: "z-last", name: "Z", category: "summary", content: "z body", is_auto_run: 1, sort_order: 5 },
      { id: "a", slug: "a-first", name: "A", category: "summary", content: "a body", is_auto_run: 1, sort_order: 5 },
      { id: "later", slug: "later", name: "Later", category: "summary", content: "later body", is_auto_run: 1, sort_order: 6 },
    ]);

    expect(selectAutomaticSummaryPrompt(db)).toMatchObject({ id: "a", content: "a body" });
  });

  it("falls back to the standard instructions when no eligible prompt or DB is available", () => {
    const context = { title: "Demo", date: "2026-07-11" };
    expect(automaticSummaryInstructions(undefined, context)).toBe(STANDARD_SUMMARY_INSTRUCTIONS);
    expect(automaticSummaryInstructions(() => { throw new Error("missing DB"); }, context))
      .toBe(STANDARD_SUMMARY_INSTRUCTIONS);
  });

  it("does not hide an unknown variable in the selected prompt behind the fallback", () => {
    const db = promptDb([
      { id: "bad", slug: "bad", name: "Bad", category: "summary", content: "{{secret_file}}", is_auto_run: 1, sort_order: 0 },
    ]);
    expect(() => automaticSummaryInstructions(() => db, { title: "Demo", date: "2026-07-11" }))
      .toThrow("Unsupported summary template variable(s): secret_file");
  });
});
