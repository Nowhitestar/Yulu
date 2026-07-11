import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const listMock = vi.fn();
const renameMutate = vi.fn();
const deleteMutate = vi.fn();
const transcribeMutate = vi.fn();
const summarizeMutate = vi.fn();
const sendSummaryMutate = vi.fn();
const shareTargetsMock = vi.fn(() => ({ data: { targets: [], history: [] } }));
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      shareTargets: { useQuery: () => shareTargetsMock() },
      rename: { useMutation: () => ({ mutate: renameMutate }) },
      delete: { useMutation: () => ({ mutate: deleteMutate }) },
      transcribe: { useMutation: () => ({ mutate: transcribeMutate }) },
      summarize: { useMutation: () => ({ mutate: summarizeMutate }) },
      sendSummary: { useMutation: () => ({ mutate: sendSummaryMutate }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("../../web/src/hooks/useConfirm.js", () => ({ useConfirm: () => vi.fn(() => true) }));

import { RecordingsList } from "../../web/src/routes/inbox/recordings";

function rows() {
  return [
    { stem: "TeamSync_20260102_090000", title: "TeamSync", tags: ["Design"], recordedAt: "2026-01-02T09:00:00", durationSeconds: 2720, mtimeMs: 2, hasTranscript: true, hasSummary: true, hasRealtime: true, firstWords: "we discussed", status: "idle" },
    { stem: "Memo_20260101_120000", title: "Memo", tags: [], recordedAt: "2026-01-01T12:00:00", durationSeconds: 42, mtimeMs: 1, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "quick note", status: "transcribing" },
  ];
}

describe("RecordingsList", () => {
  beforeEach(() => {
    renameMutate.mockClear();
    deleteMutate.mockClear();
    transcribeMutate.mockClear();
    summarizeMutate.mockClear();
    sendSummaryMutate.mockClear();
    shareTargetsMock.mockClear();
    shareTargetsMock.mockReturnValue({ data: { targets: [], history: [] } });
  });

  it("renders compact recording rows without transcript previews", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByText("TeamSync")).toBeInTheDocument();
    expect(screen.getByText("Memo")).toBeInTheDocument();
    expect(screen.queryByText(/quick note/)).toBeNull();
    expect(screen.queryByText(/we discussed/)).toBeNull();
    expect(screen.getByText("45:20")).toBeInTheDocument();
    expect(screen.getByText("0:42")).toBeInTheDocument();
    expect(screen.getByText("Design")).toBeInTheDocument();
    expect(screen.getByLabelText("添加标签")).toBeInTheDocument();
    expect(screen.getAllByLabelText("Transcript ready")).toHaveLength(2);
    expect(screen.getByLabelText("Summary ready")).toBeInTheDocument();
    expect(screen.getByLabelText("Realtime transcript ready")).toBeInTheDocument();
    // The Voicemail/Meeting type badge is gone.
    expect(screen.queryByText(/voicemail/i)).toBeNull();
  });

  it("renders no type filter chips (every recording is a meeting now)", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.queryByRole("button", { name: "Voicemail" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Meeting" })).toBeNull();
  });

  it("shows a status chip on a transcribing row", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByTestId("recording-status")).toHaveAttribute("data-state", "transcribing");
  });

  it("shows a Failed badge (not a forever-spinner) with the error in a tooltip", () => {
    listMock.mockReturnValue({
      data: [{ stem: "TeamSync_20260102_090000", title: "TeamSync", tags: [], recordedAt: "2026-01-02T09:00:00", durationSeconds: null, mtimeMs: 2, hasTranscript: false, hasSummary: false, hasRealtime: false, firstWords: null, status: "failed", statusError: "engine crashed" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    const badge = screen.getByTestId("recording-status");
    expect(badge).toHaveAttribute("data-state", "failed");
    expect(badge).toHaveAttribute("title", "engine crashed");
  });

  it("renders no status badge for an idle row", () => {
    listMock.mockReturnValue({
      data: [{ stem: "TeamSync_20260102_090000", title: "TeamSync", tags: [], recordedAt: "2026-01-02T09:00:00", durationSeconds: null, mtimeMs: 2, hasTranscript: true, hasSummary: true, hasRealtime: false, firstWords: "hi", status: "idle" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.queryByTestId("recording-status")).toBeNull();
  });

  it("opens a row context menu with actions based on available outputs", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    expect(screen.getByRole("menuitem", { name: /重命名/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /重新转写/i }));
    expect(transcribeMutate).toHaveBeenCalledWith({ stem: "TeamSync_20260102_090000" });

    fireEvent.contextMenu(screen.getByText("Memo"));
    expect(screen.queryByRole("menuitem", { name: /重新生成摘要/i })).toBeNull();
  });

  it("keeps row sharing and the context menu mutually exclusive", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);

    const shareButtons = screen.getAllByRole("button", { name: "分享摘要" });
    fireEvent.click(shareButtons[0]!);
    expect(screen.getByRole("dialog", { name: "分享摘要" })).toBeInTheDocument();

    fireEvent.contextMenu(screen.getByText("TeamSync"));
    expect(screen.queryByRole("dialog", { name: "分享摘要" })).toBeNull();
    expect(screen.getByRole("menu")).toBeInTheDocument();

    fireEvent.click(shareButtons[1]!);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("dialog", { name: "分享摘要" })).toBeInTheDocument();
  });

  it("closes row sharing with Escape and an outside pointer", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    const shareButton = screen.getAllByRole("button", { name: "分享摘要" })[0]!;

    fireEvent.click(shareButton);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "分享摘要" })).toBeNull();

    fireEvent.click(shareButton);
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog", { name: "分享摘要" })).toBeNull();
  });
});
