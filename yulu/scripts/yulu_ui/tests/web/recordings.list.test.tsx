import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const listMock = vi.fn();
const renameMutate = vi.fn();
const deleteMutate = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
      rename: { useMutation: () => ({ mutate: renameMutate }) },
      delete: { useMutation: () => ({ mutate: deleteMutate }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("../../web/src/hooks/useConfirm.js", () => ({ useConfirm: () => vi.fn(() => true) }));

import { RecordingsList, InboxIndex, fmtLength, fmtWhen } from "../../web/src/routes/inbox/recordings";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider";

function renderList(path = "/inbox") {
  return render(<LanguageProvider><MemoryRouter initialEntries={[path]}><RecordingsList /></MemoryRouter></LanguageProvider>);
}

function rows() {
  return [
    { stem: "TeamSync_20260102_090000", title: "TeamSync", tags: ["Design"], recordedAt: "2026-01-02T09:00:00", durationSeconds: 2720, mtimeMs: 2, hasTranscript: true, hasSummary: true, firstWords: "we discussed", status: "idle" },
    { stem: "Memo_20260101_120000", title: "Memo", tags: [], recordedAt: "2026-01-01T12:00:00", durationSeconds: 42, mtimeMs: 1, hasTranscript: true, hasSummary: false, firstWords: "quick note", status: "transcribing" },
  ];
}

const t = (key: string, vars: Record<string, string | number> = {}) =>
  `${key}${Object.keys(vars).length ? ":" + Object.values(vars).join(",") : ""}`;

describe("recording row time and length", () => {
  const now = new Date("2026-11-18T15:00:00");

  it("shows a time today, a word yesterday, a weekday this week, then a date", () => {
    expect(fmtWhen("2026-11-18T09:05:00", "en-US", t, now)).toBe("09:05");
    expect(fmtWhen("2026-11-17T23:50:00", "en-US", t, now)).toBe("time.yesterday");
    expect(fmtWhen("2026-11-13T10:00:00", "en-US", t, now)).toBe("Fri");
    expect(fmtWhen("2026-11-10T10:00:00", "en-US", t, now)).toBe("Nov 10");
    expect(fmtWhen("2025-12-31T10:00:00", "en-US", t, now)).toBe("Dec 31, 2025");
    expect(fmtWhen("2026-11-10T10:00:00", "zh-CN", t, now)).toBe("11月10日");
  });

  it("says nothing for a missing or unreadable time", () => {
    expect(fmtWhen(null, "en-US", t, now)).toBe("");
    expect(fmtWhen("not a date", "en-US", t, now)).toBe("");
  });

  it("rounds a length to what you would say out loud", () => {
    expect(fmtLength(42, t)).toBe("duration.seconds:42");
    expect(fmtLength(0, t)).toBe("duration.seconds:1");
    expect(fmtLength(1820, t)).toBe("duration.minutes:30");
    expect(fmtLength(3600, t)).toBe("duration.hours:1");
    expect(fmtLength(5400, t)).toBe("duration.hoursMinutes:1,30");
    expect(fmtLength(null, t)).toBe("");
    expect(fmtLength(-3, t)).toBe("");
  });
});

describe("RecordingsList", () => {
  beforeEach(() => {
    renameMutate.mockClear();
    deleteMutate.mockClear();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-03T10:00:00"));
  });
  afterEach(() => { vi.useRealTimers(); });

  it("renders a title and one quiet line per recording, nothing else", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    renderList();
    expect(screen.getByText("TeamSync")).toBeInTheDocument();
    expect(screen.getByText("昨天 · 45 分钟")).toBeInTheDocument();
    expect(screen.getByText("周四 · 42 秒")).toBeInTheDocument();
    // No transcript preview, tags or type badge compete with the titles.
    expect(screen.queryByText(/quick note/)).toBeNull();
    expect(screen.queryByText(/we discussed/)).toBeNull();
    expect(screen.queryByText("Design")).toBeNull();
    expect(screen.queryByLabelText("添加标签")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("falls back to the file name when a recording has no title", () => {
    listMock.mockReturnValue({ data: [{ ...rows()[0]!, title: null }], isPending: false });
    renderList();
    expect(screen.getByText("TeamSync_20260102_090000")).toBeInTheDocument();
  });

  it("says so when there are no recordings", () => {
    listMock.mockReturnValue({ data: [], isPending: false });
    renderList();
    expect(screen.getByText("还没有录音。")).toBeInTheDocument();
  });

  it("shows processing as an icon that names its state", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    renderList();
    const status = screen.getByTestId("recording-status");
    expect(status).toHaveAttribute("data-state", "transcribing");
    expect(status).toHaveAttribute("role", "img");
    expect(status).toHaveAccessibleName("转写中");
    expect(status).toHaveTextContent("");
  });

  it("shows a failure as an icon with the reason one hover away", () => {
    listMock.mockReturnValue({
      data: [{ ...rows()[0]!, status: "failed", statusError: "engine crashed" }],
      isPending: false,
    });
    renderList();
    const status = screen.getByTestId("recording-status");
    expect(status).toHaveAttribute("data-state", "failed");
    expect(status).toHaveAccessibleName("失败");
    expect(status).toHaveAttribute("title", "engine crashed");
    expect(status).toHaveTextContent("");
  });

  it("renders no status icon for a finished recording", () => {
    listMock.mockReturnValue({ data: [rows()[0]!], isPending: false });
    renderList();
    expect(screen.queryByTestId("recording-status")).toBeNull();
  });

  it("offers only rename and delete from a row's context menu", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    renderList();
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    expect(screen.getAllByRole("menuitem").map((item) => item.textContent)).toEqual(["重命名", "删除"]);
  });

  it("renames from the context menu", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    const prompt = vi.spyOn(window, "prompt").mockReturnValue("  Weekly sync  ");
    renderList();
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    fireEvent.click(screen.getByRole("menuitem", { name: "重命名" }));
    expect(renameMutate).toHaveBeenCalledWith({ stem: "TeamSync_20260102_090000", title: "Weekly sync" });
    prompt.mockRestore();
  });

  it("deletes from the context menu after confirming", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    renderList();
    fireEvent.contextMenu(screen.getByText("TeamSync"));
    fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
    expect(deleteMutate).toHaveBeenCalledWith({ stem: "TeamSync_20260102_090000" }, expect.any(Object));
  });

  it.each(["agent_queued", "transcribing", "delivery_unverified", "execution_unverified"])(
    "protects a recording from deletion while it is %s", (status) => {
      listMock.mockReturnValue({ data: [{ ...rows()[0]!, status }], isPending: false });
      renderList();
      fireEvent.contextMenu(screen.getByText("TeamSync"));
      expect(screen.getByRole("menuitem", { name: "删除" })).toBeDisabled();
      expect(screen.getByRole("menuitem", { name: "重命名" })).toBeEnabled();
    });
});

describe("InboxIndex", () => {
  it("invites a first recording when there are none", () => {
    listMock.mockReturnValue({ data: [], isPending: false });
    render(<LanguageProvider><MemoryRouter initialEntries={["/inbox"]}><InboxIndex /></MemoryRouter></LanguageProvider>);
    expect(screen.getByText("还没有录音。点击右上角「录制」开始第一场会议。")).toBeInTheDocument();
  });
});
