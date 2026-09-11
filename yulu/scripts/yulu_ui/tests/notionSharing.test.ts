import { describe, expect, it } from "vitest";
import { normalizeNotionShareDestination, notionFetchedSharePage, notionShareContentMatches, notionSharingPageId } from "../src/notionSharing.js";

const id = "01234567-89ab-cdef-0123-456789abcdef";
const compact = id.replaceAll("-", "");

describe("Notion sharing formats", () => {
  it.each([
    id, compact.toUpperCase(), `https://app.notion.com/p/${compact}?pvs=204`,
    `https://www.notion.so/Private-notes-${compact}?source=copy_link#block`,
  ])("normalizes an exact page identity from %s", (value) => {
    expect(notionSharingPageId(value)).toBe(compact);
    expect(normalizeNotionShareDestination(value)).toBe(JSON.stringify({ page_id: id }));
  });

  it.each([
    "Private Notes", `http://notion.so/${compact}`, `https://notion.so.evil.example/${compact}`,
    `https://user@notion.so/${compact}`, `https://notion.so:8443/${compact}`,
    `https://notion.so/${compact}/attachment`, `https://notion.so/${compact}bad`,
    '{"page_id":"one","data_source_id":"two"}', '{"page_id":"one","extra":"decoy"}',
    '{"page_id":"one","type":"data_source_id"}', '{"page_id":"one”}',
    '{"page_id":"Private Notes"}',
  ])("rejects ambiguous or untrusted destinations: %s", (value) => {
    expect(() => normalizeNotionShareDestination(value)).toThrow(/Notion page link/);
  });

  it("keeps explicit connector parent objects compatible", () => {
    expect(normalizeNotionShareDestination(JSON.stringify({ type: "page_id", page_id: id })))
      .toBe(JSON.stringify({ page_id: id }));
    expect(normalizeNotionShareDestination(JSON.stringify({ data_source_id: id })))
      .toBe(JSON.stringify({ data_source_id: id }));
  });

  it("permits only Notion's empty paragraph separator normalization", () => {
    expect(notionShareContentMatches("# Summary\nDecision.\n- Keep it local.", "# Summary\n\nDecision.\n\n- Keep it local.\n")).toBe(true);
    expect(notionShareContentMatches("# Summary\nDifferent decision.", "# Summary\n\nDecision.")).toBe(false);
    expect(notionShareContentMatches("Decision.\nExtra private content.", "Decision.")).toBe(false);
    expect(notionShareContentMatches("Decision.", "Decision.\nOmitted content.")).toBe(false);
    expect(notionShareContentMatches("```\nx\ny\n```", "```\nx\n\ny\n```")).toBe(false);
    expect(notionShareContentMatches("- x\n- y", "- x\n\t- y")).toBe(false);
  });

  it("never treats model prose as a fetched page", () => {
    expect(notionFetchedSharePage({ status: "verified", content: "approved" })).toBeNull();
    expect(notionFetchedSharePage("I verified the page")).toBeNull();
  });
});
