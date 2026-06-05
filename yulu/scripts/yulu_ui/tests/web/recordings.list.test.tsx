import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const listMock = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: { recordings: { list: { useQuery: (...a: unknown[]) => listMock(...a) } } },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));

import { RecordingsList } from "../../web/src/routes/inbox/recordings";

function rows() {
  return [
    { stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", recordedAt: "2026-01-02T09:00:00", mtimeMs: 2, hasTranscript: true, hasSummary: true, hasRealtime: true, firstWords: "we discussed", status: "idle" },
    { stem: "voicemail_20260101_120000", type: "voicemail", title: null, recordedAt: "2026-01-01T12:00:00", mtimeMs: 1, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "quick note", status: "transcribing" },
  ];
}

describe("RecordingsList", () => {
  it("renders one row per recording with a type badge", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByText("TeamSync")).toBeInTheDocument();
    expect(screen.getByText(/quick note/)).toBeInTheDocument();
    expect(screen.getAllByText(/voicemail/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/meeting/i).length).toBeGreaterThan(0);
  });

  it("renders All / Voicemail / Meeting filter chips", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voicemail" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Meeting" })).toBeInTheDocument();
  });

  it("shows a status chip on a transcribing row", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument();
  });

  it("shows a Failed badge (not a forever-spinner) with the error in a tooltip", () => {
    listMock.mockReturnValue({
      data: [{ stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", recordedAt: "2026-01-02T09:00:00", mtimeMs: 2, hasTranscript: false, hasSummary: false, hasRealtime: false, firstWords: null, status: "failed", statusError: "engine crashed" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    const badge = screen.getByTestId("recording-status");
    expect(badge).toHaveTextContent(/failed/i);
    expect(badge).toHaveAttribute("data-state", "failed");
    expect(badge).toHaveAttribute("title", "engine crashed");
  });

  it("renders no status badge for an idle row", () => {
    listMock.mockReturnValue({
      data: [{ stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", recordedAt: "2026-01-02T09:00:00", mtimeMs: 2, hasTranscript: true, hasSummary: true, hasRealtime: false, firstWords: "hi", status: "idle" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.queryByTestId("recording-status")).toBeNull();
  });

  it("clicking the Voicemail chip re-queries with type: voicemail", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Voicemail" }));
    const lastArg = listMock.mock.calls[listMock.mock.calls.length - 1]?.[0];
    expect(lastArg).toMatchObject({ type: "voicemail" });
  });
});
