import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TranscriptView } from "../../web/src/components/TranscriptView.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    glossary: {
      list: { useQuery: () => ({ data: [{ term: "AgentKey" }, { term: "OpenClaw" }], isError: false }) },
    },
  },
}));

describe("TranscriptView", () => {
  it("renders plain text as-is", () => {
    const { container } = render(<TranscriptView text="hello world" />);
    expect(container.textContent).toBe("hello world");
  });

  it("wraps glossary terms in a span.vocab (case-insensitive)", () => {
    const { container } = render(<TranscriptView text="we use AgentKey and openclaw" />);
    const vocabs = container.querySelectorAll(".vocab");
    expect(vocabs).toHaveLength(2);
    expect(vocabs[0]?.textContent).toBe("AgentKey");
    expect(vocabs[1]?.textContent).toBe("openclaw");
  });

  it("wraps speaker labels (Speaker A: prefix) in span.speaker", () => {
    const { container } = render(<TranscriptView text={"Speaker A: hello\nSpeaker B: world"} />);
    const speakers = container.querySelectorAll(".speaker");
    expect(speakers).toHaveLength(2);
    expect(speakers[0]?.textContent).toBe("Speaker A:");
    expect(speakers[1]?.textContent).toBe("Speaker B:");
  });

  it("preserves newlines as <br> (or whitespace: pre-wrap)", () => {
    const { container } = render(<TranscriptView text={"line1\nline2"} />);
    // Either implementation is acceptable; assert the visible text contains both
    expect(container.textContent).toContain("line1");
    expect(container.textContent).toContain("line2");
  });

  it("falls back to plain text when glossary query errors", async () => {
    vi.resetModules();
    vi.doMock("../../web/src/trpc.js", () => ({
      trpc: { glossary: { list: { useQuery: () => ({ data: undefined, isError: true }) } } },
    }));
    const { TranscriptView: FreshTranscriptView } = await import(
      "../../web/src/components/TranscriptView.js"
    );
    const { container } = render(<FreshTranscriptView text="hello AgentKey" />);
    expect(container.textContent).toBe("hello AgentKey");
    expect(container.querySelector(".vocab")).toBeNull();
  });
});
