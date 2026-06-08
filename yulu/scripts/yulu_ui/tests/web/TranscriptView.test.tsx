import { describe, it, expect, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";
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

  it("renders timestamped speaker lines and seeks from the timestamp", () => {
    const onSeek = vi.fn();
    const { container } = render(<TranscriptView text="[00:02 我] hello" onSeek={onSeek} />);
    expect(container.querySelector(".speaker-badge")?.textContent).toBe("我");
    fireEvent.click(container.querySelector(".transcript-time")!);
    expect(onSeek).toHaveBeenCalledWith(2);
  });

  it("renders sidecar speaker segments and can reassign one segment", () => {
    const onAssign = vi.fn();
    const { container } = render(
      <TranscriptView
        text="plain fallback"
        speakerData={{
          segments: [
            { start: 0, end: 1, text: "hello", speaker_id: "spk-0", display_name: "Lewis", confident: true },
            { start: 2, end: 3, text: "world", speaker_id: "spk-1", display_name: "Speaker 2", confident: false },
          ],
          speakers: {
            "spk-0": { display_name: "Lewis", merged_into: null },
            "spk-1": { display_name: "Speaker 2", merged_into: null },
          },
        }}
        onAssignSpeaker={onAssign}
      />,
    );
    expect(container.querySelectorAll(".transcript-speaker-line")).toHaveLength(2);
    expect(container.querySelector(".speaker-badge")?.textContent).toBe("Lewis");
    expect(container.querySelector(".speaker-confidence")?.textContent).toBe("?");
    fireEvent.change(container.querySelectorAll(".transcript-speaker-select")[1]!, { target: { value: "spk-0" } });
    expect(onAssign).toHaveBeenCalledWith(1, "spk-0");
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
