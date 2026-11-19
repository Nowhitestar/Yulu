import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";

const searchMock = vi.fn();
vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    search: { run: { useQuery: (input: { query: string }, opts: { enabled: boolean }) => searchMock(input, opts) } },
    config: { schema: { useQuery: () => ({ data: [
      { path: "audio.mic_device", category: "audio", label: "Microphone device" },
      { path: "status_agent.feedback_sounds", category: "voice", label: "Dictation feedback sounds" },
      { path: "llm.enabled", category: "llm", label: "Enable LLM" },
    ] }) } },
  },
}));

import { CommandPalette } from "../../../web/src/components/CommandPalette.js";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const hit = {
  kind: "meeting_summary", stem: "Review_20260101_140000", meetingTitle: "Design review", recordedAt: "2026-01-01T14:00:00",
  sourcePath: "", score: 1, snippet: "share stays a [hit]manual[/hit] step",
};

function Where() {
  const location = useLocation();
  return <output data-testid="where">{location.pathname + location.search}</output>;
}

function mount(onClose = vi.fn()) {
  localStorage.setItem("yulu_ui.lang", "en");
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={["/inbox"]}>
        <button type="button">opener</button>
        <Routes><Route path="*" element={<Where />} /></Routes>
        <CommandPalette onClose={onClose} />
      </MemoryRouter>
    </LanguageProvider>,
  );
  return onClose;
}

const options = () => screen.getAllByRole("option").map((option) => option.querySelector(".gs-result-title")?.textContent);
const type = (value: string) => {
  fireEvent.change(screen.getByRole("combobox", { name: "Search" }), { target: { value } });
  act(() => { vi.advanceTimersByTime(250); });
};

beforeEach(() => {
  vi.useFakeTimers();
  searchMock.mockReset();
  searchMock.mockImplementation((input: { query: string }, opts: { enabled: boolean }) =>
    ({ data: opts.enabled && input.query === "manual" ? { hits: [hit] } : undefined, isFetching: false }));
});
afterEach(() => { vi.useRealTimers(); localStorage.clear(); });

describe("CommandPalette", () => {
  it("opens as a list of every place, with the field focused and nothing searched", () => {
    mount();
    expect(screen.getByRole("combobox", { name: "Search" })).toHaveFocus();
    expect(screen.getByText("Go to")).toBeInTheDocument();
    expect(options()).toEqual([
      "Recordings", "General", "Recording & summaries", "Meeting reminders", "Voice Input", "Connections",
      "Templates", "Glossary", "Runtime status",
    ]);
    expect(searchMock).toHaveBeenLastCalledWith({ query: "", limit: 8 }, { enabled: false });
  });

  it("narrows the places as you type and opens the first on Return", () => {
    const onClose = mount();
    type("gloss");
    expect(options()).toEqual(["Glossary"]);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Enter" });
    expect(screen.getByTestId("where")).toHaveTextContent("/knowledge/glossary");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("moves through results with the arrow keys", () => {
    mount();
    const field = screen.getByRole("combobox");
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowDown" });
    fireEvent.keyDown(field, { key: "ArrowUp" });
    expect(screen.getByRole("option", { selected: true })).toHaveTextContent("General");
    fireEvent.keyDown(field, { key: "Enter" });
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/general");
  });

  it("finds a setting by name and sends you to the page that holds it", () => {
    mount();
    type("microphone");
    expect(options()).toEqual(["Recording & summaries"]);
    fireEvent.click(screen.getByRole("option", { name: /Recording & summaries/ }));
    expect(screen.getByTestId("where")).toHaveTextContent("/settings/recording");
  });

  it("does not surface retired model settings", () => {
    mount();
    type("Enable LLM");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText("No matches")).toBeInTheDocument();
  });

  it("searches recordings and opens a hit on the matching tab, at the matching words", () => {
    mount();
    type("manual");
    expect(searchMock).toHaveBeenLastCalledWith({ query: "manual", limit: 8 }, { enabled: true });
    const result = screen.getByRole("option", { name: /Design review/ });
    expect(result.querySelector("mark")).toHaveTextContent("manual");
    fireEvent.click(result);
    expect(screen.getByTestId("where")).toHaveTextContent("/inbox/Review_20260101_140000?tab=summary&snippet=manual");
  });

  it("closes on Escape and on a click outside, without going anywhere", () => {
    const onClose = mount();
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    fireEvent.mouseDown(document.querySelector(".gs-scrim") as HTMLElement);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId("where")).toHaveTextContent("/inbox");
  });
});
