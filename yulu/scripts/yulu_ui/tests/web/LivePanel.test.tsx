import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

type Snapshot = {
  stem: string; title: string; status: string; reason: string | null; language: "zh" | "en";
  markdown: string; myNotes: Array<{ at: string; text: string }>; startedAt: string; updatedAt: string | null;
};
let snapshot: Snapshot | null;
const addNote = vi.fn();
const setLanguage = vi.fn();

vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("../../web/src/components/MarkdownView.js", () => ({
  MarkdownView: ({ text }: { text: string }) => <div data-testid="notes-section">{text}</div>,
}));
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    liveNotes: {
      current: { useQuery: () => ({ data: snapshot, isPending: false }) },
      addNote: { useMutation: () => ({ mutate: addNote, isPending: false }) },
      setLanguage: { useMutation: () => ({ mutate: setLanguage, isPending: false }) },
    },
  },
}));

import { LivePanel } from "../../web/src/routes/live.js";

function mount() {
  localStorage.setItem("yulu_ui.lang", "zh");
  return render(<LanguageProvider><LivePanel /></LanguageProvider>);
}

beforeEach(() => {
  addNote.mockReset();
  setLanguage.mockReset();
  delete (window as unknown as { webkit?: unknown }).webkit;
  snapshot = {
    stem: "Review_20261119_093000", title: "数据同步方案评审", status: "ready", reason: null, language: "zh",
    markdown: "## 结论\n\n- 改为增量推送\n\n## 待确认\n\n- 旧客户端怎么办",
    myNotes: [{ at: new Date(2026, 10, 19, 9, 41).toISOString(), text: "预算按二十万估" }],
    startedAt: new Date(Date.now() - 768_000).toISOString(),
    updatedAt: null,
  };
});

describe("LivePanel", () => {
  it("shows the notes by section, the attendee's notes and one line to add another", async () => {
    mount();
    expect(screen.getByText("数据同步方案评审")).toBeInTheDocument();
    expect(screen.getAllByTestId("notes-section").map((section) => section.textContent)).toEqual([
      "## 结论\n\n- 改为增量推送",
      "## 待确认\n\n- 旧客户端怎么办",
    ]);
    expect(screen.getByText("预算按二十万估")).toBeInTheDocument();
    expect(screen.getByText("12:48")).toBeInTheDocument();
    // In a browser there is no native panel to collapse or stop.
    expect(screen.queryByRole("button", { name: "收起成图标" })).toBeNull();
    expect(screen.queryByRole("button", { name: "结束录制" })).toBeNull();

    await userEvent.type(screen.getByLabelText("记一笔，回车保存"), "问法务留存期限{Enter}");
    expect(addNote).toHaveBeenCalledWith(
      { stem: "Review_20261119_093000", text: "问法务留存期限" },
      expect.anything(),
    );
    await userEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(setLanguage).toHaveBeenCalledWith({ stem: "Review_20261119_093000", language: "en" }, expect.anything());
  });

  it("names the missing step when live notes cannot run, and still takes notes", () => {
    snapshot = { ...snapshot!, status: "unavailable", reason: "needs_connection", markdown: "" };
    mount();
    expect(screen.getByText("实时笔记未开启")).toBeInTheDocument();
    expect(screen.getByText(/需要先在「设置 › 连接」里连接 xAI/)).toBeInTheDocument();
    expect(screen.getByLabelText("记一笔，回车保存")).toBeEnabled();
  });

  it("asks the native panel to collapse when it hosts the page", async () => {
    const postMessage = vi.fn();
    (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { yuluPanel: { postMessage } } };
    mount();
    expect(postMessage).toHaveBeenCalledWith({ action: "appearance", dark: false });
    await userEvent.click(screen.getByRole("button", { name: "收起成图标" }));
    expect(postMessage).toHaveBeenCalledWith({ action: "collapse" });
    await userEvent.click(screen.getByRole("button", { name: "结束录制" }));
    expect(postMessage).toHaveBeenCalledWith({ action: "stop" });
  });

  it("shows what the native panel reports about stopping and the recording", async () => {
    const postMessage = vi.fn();
    (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { yuluPanel: { postMessage } } };
    mount();
    act(() => {
      window.dispatchEvent(new CustomEvent("yulu-panel", { detail: { stopping: true, warning: "录音连接异常，请检查录音状态" } }));
    });
    expect(screen.getByText("正在结束…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "结束录制" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("录音连接异常");
    act(() => { window.dispatchEvent(new CustomEvent("yulu-panel", { detail: { stopping: false, warning: null } })); });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "结束录制" })).toBeEnabled();
  });

  it("waits quietly before anyone speaks", () => {
    snapshot = { ...snapshot!, status: "idle", markdown: "", myNotes: [] };
    mount();
    expect(screen.getByText("开始说话后，要点会出现在这里。")).toBeInTheDocument();
  });
});
