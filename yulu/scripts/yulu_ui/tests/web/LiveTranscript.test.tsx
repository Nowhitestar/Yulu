// tests/web/LiveTranscript.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LiveTranscript, formatLines } from "../../web/src/components/LiveTranscript.js";

const wsHandlers = new Map<string, (payload: unknown) => void>();
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: (channel: string, fn: (p: unknown) => void) => { wsHandlers.set(channel, fn); },
  nextBackoff: (n: number) => n,
}));

beforeEach(() => {
  wsHandlers.clear();
});

describe("LiveTranscript", () => {
  it("renders nothing until an active live-transcript event arrives", () => {
    const { container } = render(<LiveTranscript />);
    expect(container.querySelector(".live-transcript")).toBeNull();
  });

  it("shows captions when an active event arrives", () => {
    render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({
      active: true, stem: "Memo_20260601_120000",
      text: "[Me] hello there\n[Them] hi back\n",
    }));
    expect(screen.getByTestId("live-transcript")).toBeInTheDocument();
    expect(screen.getByText("hello there")).toBeInTheDocument();
    expect(screen.getByText("hi back")).toBeInTheDocument();
    // Speaker tags are relabeled for readability.
    expect(screen.getByText("You")).toBeInTheDocument();
    expect(screen.getByText("Them")).toBeInTheDocument();
  });

  it("updates text as the recording grows", () => {
    render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "[Me] one\n" }));
    expect(screen.getByText("one")).toBeInTheDocument();
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "[Me] one\n[Me] two\n" }));
    expect(screen.getByText("two")).toBeInTheDocument();
  });

  it("hides when an active:false event arrives (recording stopped)", () => {
    const { container } = render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "[Me] hi\n" }));
    expect(container.querySelector(".live-transcript")).not.toBeNull();
    act(() => wsHandlers.get("live-transcript")?.({ active: false }));
    expect(container.querySelector(".live-transcript")).toBeNull();
  });

  it("dismiss button hides the panel for the current recording", () => {
    const { container } = render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "[Me] hi\n" }));
    const close = screen.getByRole("button", { name: /hide live transcript/i });
    act(() => close.click());
    expect(container.querySelector(".live-transcript")).toBeNull();
  });

  it("reappears for a NEW recording after being dismissed", () => {
    const { container } = render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "[Me] a\n" }));
    act(() => screen.getByRole("button", { name: /hide live transcript/i }).click());
    expect(container.querySelector(".live-transcript")).toBeNull();
    // A different recording starts → panel must come back.
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s2", text: "[Me] b\n" }));
    expect(container.querySelector(".live-transcript")).not.toBeNull();
    expect(screen.getByText("b")).toBeInTheDocument();
  });

  it("shows a Listening… placeholder when active but no text yet", () => {
    render(<LiveTranscript />);
    act(() => wsHandlers.get("live-transcript")?.({ active: true, stem: "s1", text: "" }));
    expect(screen.getByText(/listening/i)).toBeInTheDocument();
  });
});

describe("formatLines", () => {
  it("strips [Me]/[Them] tags and drops blank lines", () => {
    const lines = formatLines("[Me] hello\n\n[Them]  world \n");
    expect(lines).toEqual([
      { tag: "Me", text: "hello" },
      { tag: "Them", text: "world" },
    ]);
  });

  it("keeps untagged lines with a null tag", () => {
    const lines = formatLines("plain line\n");
    expect(lines).toEqual([{ tag: null, text: "plain line" }]);
  });
});
