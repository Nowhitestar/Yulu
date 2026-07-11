import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const listMock = vi.fn();
const renameMutate = vi.fn();
const deleteMutate = vi.fn();
const reprocessMutate = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      rename: { useMutation: () => ({ mutate: renameMutate }) },
      delete: { useMutation: () => ({ mutate: deleteMutate }) },
      reprocess: { useMutation: () => ({ mutate: reprocessMutate, isPending: false }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("../../web/src/hooks/useConfirm.js", () => ({ useConfirm: () => vi.fn(() => true) }));

import { RecordingsList } from "../../web/src/routes/inbox/recordings";

function rows() {
  return [
    { stem: "TeamSync_20260102_090000", title: "TeamSync", tags: ["Design"], recordedAt: "2026-01-02T09:00:00", durationSeconds: 2720, mtimeMs: 2, hasTranscript: true, hasSummary: true, firstWords: "we discussed", status: "idle" },
    { stem: "Memo_20260101_120000", title: "Memo", tags: [], recordedAt: "2026-01-01T12:00:00", durationSeconds: 42, mtimeMs: 1, hasTranscript: true, hasSummary: false, firstWords: "quick note", status: "transcribing" },
  ];
}

describe("RecordingsList", () => {
  beforeEach(() => {
    renameMutate.mockClear();
    deleteMutate.mockClear();
    reprocessMutate.mockClear();
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
      data: [{ stem: "TeamSync_20260102_090000", title: "TeamSync", tags: [], recordedAt: "2026-01-02T09:00:00", durationSeconds: null, mtimeMs: 2, hasTranscript: false, hasSummary: false, firstWords: null, status: "failed", statusError: "engine crashed" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    const badge = screen.getByTestId("recording-status");
    expect(badge).toHaveAttribute("data-state", "failed");
    expect(badge).toHaveAttribute("title", "engine crashed");
  });

  it("renders no status badge for an idle row", () => {
    listMock.mockReturnValue({
      data: [{ stem: "TeamSync_20260102_090000", title: "TeamSync", tags: [], recordedAt: "2026-01-02T09:00:00", durationSeconds: null, mtimeMs: 2, hasTranscript: true, hasSummary: true, firstWords: "hi", status: "idle" }],
      isPending: false,
    });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.queryByTestId("recording-status")).toBeNull();
  });

  it("opens a row context menu with the two durable Hermes actions", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    expect(screen.getByRole("menuitem", { name: /重命名/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("menuitem", { name: /Hermes.*处理/i }));
    expect(reprocessMutate).toHaveBeenCalledWith({
      stem: "TeamSync_20260102_090000",
      sendToNotion: false,
    });

    fireEvent.contextMenu(screen.getByText("TeamSync"));
    fireEvent.click(screen.getByRole("menuitem", { name: /发送 Notion/i }));
    expect(reprocessMutate).toHaveBeenLastCalledWith({
      stem: "TeamSync_20260102_090000",
      sendToNotion: true,
    });
  });

  it("disables duplicate Hermes actions while a durable task is active", () => {
    const active = rows();
    active[0] = { ...active[0]!, status: "agent_queued" };
    listMock.mockReturnValue({ data: active, isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    expect(screen.getByRole("menuitem", { name: /Hermes.*处理/i })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /发送 Notion/i })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: /删除/i })).toBeDisabled();
  });

  it("disables deletion while a Notion result is unverified", () => {
    const uncertain = rows();
    uncertain[0] = { ...uncertain[0]!, status: "delivery_unverified" };
    listMock.mockReturnValue({ data: uncertain, isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.contextMenu(screen.getByText("TeamSync"));

    expect(screen.getByRole("menuitem", { name: /删除/i })).toBeDisabled();
  });
});
