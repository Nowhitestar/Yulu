import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

const getMock = vi.fn();
const reprocessMutate = vi.fn();
const transcribeMutate = vi.fn();
const summarizeMutate = vi.fn();
const sendSummaryMutate = vi.fn();
const renameMutate = vi.fn();
const setTagsMutate = vi.fn();
const deleteMutate = vi.fn();
const confirmDeliveryMutate = vi.fn();
const abandonDeliveryMutate = vi.fn();
const retryTaskMutate = vi.fn();
const renameSpeakerMutate = vi.fn();
const mergeSpeakersMutate = vi.fn();
const assignSegmentSpeakerMutate = vi.fn();
const promptListMock = vi.fn();
const navigateMock = vi.fn();
const confirmMock = vi.fn(() => true);
const clipboardWriteText = vi.fn(() => Promise.resolve());

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      get: { useQuery: (...a: unknown[]) => getMock(...a) },
      reprocess: { useMutation: () => ({ mutate: reprocessMutate, isPending: false }) },
      transcribe: { useMutation: () => ({ mutate: transcribeMutate, isPending: false }) },
      summarize: { useMutation: () => ({ mutate: summarizeMutate, isPending: false }) },
      sendSummary: { useMutation: () => ({ mutate: sendSummaryMutate, isPending: false }) },
      rename: { useMutation: () => ({ mutate: renameMutate, isPending: false }) },
      setTags: { useMutation: () => ({ mutate: setTagsMutate, isPending: false }) },
      delete: { useMutation: () => ({ mutate: deleteMutate, isPending: false }) },
      renameSpeaker: { useMutation: () => ({ mutate: renameSpeakerMutate, isPending: false }) },
      mergeSpeakers: { useMutation: () => ({ mutate: mergeSpeakersMutate, isPending: false }) },
      assignSegmentSpeaker: { useMutation: () => ({ mutate: assignSegmentSpeakerMutate, isPending: false }) },
    },
    prompts: {
      list: { useQuery: (...a: unknown[]) => promptListMock(...a) },
    },
    agentTasks: {
      retry: { useMutation: () => ({ mutate: retryTaskMutate, isPending: false }) },
      confirmNotionDelivery: { useMutation: () => ({ mutate: confirmDeliveryMutate, isPending: false }) },
      abandonNotionDelivery: { useMutation: () => ({ mutate: abandonDeliveryMutate, isPending: false }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("react-router", async (orig) => ({
  ...(await orig<typeof import("react-router")>()),
  useNavigate: () => navigateMock,
}));
vi.mock("../../web/src/hooks/useConfirm.js", () => ({ useConfirm: () => confirmMock }));
vi.mock("../../web/src/components/AudioPlayer.js", () => ({ AudioPlayer: () => <div data-testid="audio" /> }));
vi.mock("../../web/src/components/TranscriptView.js", () => ({ TranscriptView: ({ text }: { text: string }) => <div>{text}</div> }));
vi.mock("../../web/src/components/MarkdownView.js", () => ({ MarkdownView: ({ text }: { text: string }) => <div data-testid="markdown">{text}</div> }));

import { RecordingReader } from "../../web/src/routes/inbox/recordings.$stem";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const baseData = {
  stem: "TeamSync_20260102_090000", type: "meeting" as const, title: "TeamSync",
  tags: [] as string[], mtimeMs: 1, transcript: "t", summary: "s",
  status: "idle", wavPath: "/tmp/TeamSync_20260102_090000.wav",
};

function renderAt(stem: string, lang?: "zh" | "en") {
  if (lang) localStorage.setItem("yulu_ui.lang", lang);
  const reader = <Routes><Route path="/inbox/:stem" element={<RecordingReader />} /></Routes>;
  return render(
    <MemoryRouter initialEntries={[`/inbox/${stem}`]}>
      {lang ? <LanguageProvider>{reader}</LanguageProvider> : reader}
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.removeItem("yulu_ui.lang");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText: clipboardWriteText },
    configurable: true,
  });
  clipboardWriteText.mockClear();
  reprocessMutate.mockClear();
  transcribeMutate.mockClear(); summarizeMutate.mockClear(); sendSummaryMutate.mockClear();
  promptListMock.mockReset();
  promptListMock.mockReturnValue({ data: [] });
  renameMutate.mockClear(); setTagsMutate.mockClear(); deleteMutate.mockClear();
  confirmDeliveryMutate.mockClear(); abandonDeliveryMutate.mockClear();
  retryTaskMutate.mockClear();
  renameSpeakerMutate.mockClear(); mergeSpeakersMutate.mockClear(); assignSegmentSpeakerMutate.mockClear();
  navigateMock.mockClear(); confirmMock.mockClear(); confirmMock.mockReturnValue(true);
});

describe("RecordingReader", () => {
  it("shows the realtime transcript while the final transcript is not ready", () => {
    getMock.mockReturnValue({ data: { ...baseData, transcript: null, summary: null, realtime: "实时中文内容", hasRealtime: true }, isPending: false });
    renderAt("TeamSync_20260102_090000");
    fireEvent.click(screen.getByRole("button", { name: /^转写$/i }));
    expect(screen.getByText("实时中文内容")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeDisabled();
  });

  it("exposes transcription, summarization, and sharing as separate actions", () => {
    getMock.mockReturnValue({ data: { ...baseData, stem: "Memo_20260101_120000", title: "Memo" }, isPending: false });
    renderAt("Memo_20260101_120000");
    expect(screen.getByRole("button", { name: /重新转写/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /分享摘要/i })).toBeInTheDocument();
  });

  it("keeps only the summary template selector and removes Yulu model/speaker controls", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        summaryTemplateOptions: [
          { id: "p-summary", slug: "summary", name: "标准摘要", isAutoRun: true },
        ],
      },
      isPending: false,
    });
    const { container } = renderAt("TeamSync_20260102_090000");

    expect(container.querySelectorAll(".reader-header-actions select")).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: /摘要模板/i })).toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: /转写模型/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /说话人数/i })).toBeNull();
    expect(container.querySelectorAll(".reader-actions select")).toHaveLength(0);
    expect(container.querySelectorAll(".reader-actions .rpb")).toHaveLength(2);
    expect(container.querySelector(".reader-header-actions .reader-header-delete")).toBeInTheDocument();
  });

  it("shows load errors instead of pretending every recording is missing", () => {
    getMock.mockReturnValue({ data: undefined, error: new Error("connect ECONNREFUSED 127.0.0.1:7777"), isPending: false });
    renderAt("TeamSync_20260102_090000");
    expect(screen.getByText(/无法载入录音/)).toBeInTheDocument();
    expect(screen.queryByText(/未找到录音/)).toBeNull();
  });

  it("shares the current summary without reprocessing it", () => {
    getMock.mockReturnValue({ data: {
      ...baseData,
      shareTargets: [{ channel: "notion", label: "Notion", destination: "Yulu Meeting", enabled: true, disabledReason: null, lastShare: null }],
      shareHistory: [],
    }, isPending: false });
    renderAt(baseData.stem);

    fireEvent.click(screen.getByRole("button", { name: /分享摘要/i }));
    fireEvent.click(screen.getByRole("button", { name: /Notion/i }));
    expect(sendSummaryMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, channel: "notion", label: "Notion", destination: "Yulu Meeting" },
      expect.anything(),
    );
    expect(transcribeMutate).not.toHaveBeenCalled();
    expect(summarizeMutate).not.toHaveBeenCalled();
  });

  it("only disables re-transcription when the WAV is missing", () => {
    getMock.mockReturnValue({
      data: { ...baseData, wavPath: null },
      isPending: false,
    });
    renderAt(baseData.stem);

    expect(screen.getByRole("button", { name: /重新转写/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /分享摘要/i })).toBeEnabled();
  });

  it("offers explicit confirm and abandon actions instead of retrying an uncertain Notion write", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "019f0000-0000-7000-8000-000000000123",
          state: "delivery_unverified",
          phase: "failed",
          sendToNotion: true,
          error: "Host restarted during delivery",
        },
        notionDelivery: {
          status: "reported",
          url: "https://app.notion.com/p/0123456789abcdef0123456789abcdef",
          detail: null,
        },
      },
      isPending: false,
    });
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValueOnce("https://app.notion.com/p/0123456789abcdef0123456789abcdef");
    renderAt(baseData.stem);

    expect(screen.getByRole("button", { name: /重新转写/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /分享摘要/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /确认已有页面/i }));
    expect(confirmDeliveryMutate).toHaveBeenCalledWith({
      id: "019f0000-0000-7000-8000-000000000123",
      url: "https://app.notion.com/p/0123456789abcdef0123456789abcdef",
    }, expect.anything());

    fireEvent.click(screen.getByRole("button", { name: /放弃本次投递/i }));
    expect(abandonDeliveryMutate).toHaveBeenCalledWith({
      id: "019f0000-0000-7000-8000-000000000123",
    }, expect.anything());
    expect(reprocessMutate).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("shows a paused task's pinned provider and explicit same-provider recovery actions", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "019f0000-0000-7000-8000-000000000456",
          state: "awaiting_provider",
          phase: "summarizing",
          trigger: "automatic",
          sendToNotion: false,
          summaryProvider: "xai",
          summaryModel: "grok-4.6-pinned",
          error: "xAI summary request failed (HTTP 403)",
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);

    expect(screen.getByText(/xAI · grok-4\.6-pinned/i)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: /重试同一服务/i });
    const settings = screen.getByRole("link", { name: /打开智能服务设置/i });
    const keepPaused = screen.getByRole("button", { name: /保持暂停/i });
    expect(getComputedStyle(retry.parentElement as HTMLElement).flexWrap).toBe("wrap");
    expect(settings).toHaveAttribute("href", "/settings/llm");
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeDisabled();

    fireEvent.click(retry);
    expect(retryTaskMutate).toHaveBeenCalledWith(
      { id: "019f0000-0000-7000-8000-000000000456" },
      expect.anything(),
    );
    fireEvent.click(keepPaused);
    expect(screen.getByText(/已保持暂停/i)).toBeInTheDocument();
  });

  it("states the pinned summary failure and no-switch recovery contract in English", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "019f0000-0000-7000-8000-000000000457",
          state: "awaiting_provider",
          phase: "summarizing",
          trigger: "automatic",
          sendToNotion: false,
          summaryProvider: "xai",
          summaryModel: "grok-4.6-pinned",
          error: "xAI summary request failed (HTTP 403)",
        },
      },
      isPending: false,
    });

    renderAt(baseData.stem, "en");

    expect(screen.getByText("Provider paused")).toBeInTheDocument();
    expect(screen.getByText("xAI · grok-4.6-pinned failed. Yulu did not switch providers.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry same provider" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open AI Providers" })).toHaveAttribute("href", "/settings/llm");
    expect(screen.getByRole("button", { name: "Keep paused" })).toBeInTheDocument();
  });

  it("re-transcribes without also summarizing or sharing", () => {
    getMock.mockReturnValue({ data: baseData, isPending: false });
    renderAt(baseData.stem);
    expect(screen.queryByRole("combobox", { name: /转写模型/i })).toBeNull();
    expect(screen.queryByRole("combobox", { name: /说话人数/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /重新转写/i }));
    expect(transcribeMutate).toHaveBeenCalledWith({ stem: baseData.stem }, expect.anything());
    expect(summarizeMutate).not.toHaveBeenCalled();
    expect(sendSummaryMutate).not.toHaveBeenCalled();
  });

  it("passes the selected summary template when regenerating summary", () => {
    promptListMock.mockReturnValue({
      data: [
        { id: "p-summary", slug: "summary", name: "标准摘要", is_auto_run: 1 },
        { id: "p-decision", slug: "decisions", name: "决策摘要", is_auto_run: 0 },
      ],
    });
    getMock.mockReturnValue({
      data: {
        ...baseData,
      },
      isPending: false,
    });
    renderAt(baseData.stem);
    fireEvent.change(screen.getByRole("combobox", { name: /摘要模板/i }), { target: { value: "p-decision" } });
    fireEvent.click(screen.getByRole("button", { name: /重新生成摘要/i }));
    expect(summarizeMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, promptId: "p-decision" },
      expect.anything(),
    );
    expect(transcribeMutate).not.toHaveBeenCalled();
  });

  it("allows only transcription when no transcript or summary exists", () => {
    getMock.mockReturnValue({
      data: { ...baseData, transcript: null, summary: null },
      isPending: false,
    });
    renderAt(baseData.stem);
    expect(screen.getByRole("button", { name: /重新转写/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /分享摘要/i })).toBeDisabled();
  });

  it("disables duplicate manual tasks while a recording task is queued", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "task-1",
          state: "queued",
          phase: "queued",
          sendToNotion: false,
          error: null,
        },
      },
      isPending: false,
    });
    const { container } = renderAt(baseData.stem);

    const actionButtons = [...container.querySelectorAll<HTMLButtonElement>(".reader-actions button")];
    expect(actionButtons).toHaveLength(3);
    expect(actionButtons.every((button) => button.disabled)).toBe(true);
    expect(screen.getByRole("button", { name: /删除录音/i })).toBeDisabled();
    expect(screen.getByText("已排队等待处理")).toBeInTheDocument();
  });

  it("allows a paused automatic task to be taken over by an explicit manual action", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "task-auto-paused",
          state: "awaiting_policy",
          phase: "queued",
          trigger: "automatic",
          sendToNotion: false,
          error: "Automatic Agent recording processing is paused by policy",
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);

    const transcribeButton = screen.getByRole("button", { name: /重新转写/i });
    const summarizeButton = screen.getByRole("button", { name: /重新生成摘要/i });
    expect(transcribeButton).toBeEnabled();
    expect(summarizeButton).toBeEnabled();

    fireEvent.click(summarizeButton);
    expect(summarizeMutate).toHaveBeenCalledWith({ stem: baseData.stem, promptId: null }, expect.anything());
    expect(screen.getByRole("button", { name: /删除录音/i })).toBeDisabled();
  });

  it.each(["failed", "cancelled", "completed"])(
    "does not present a historical %s Agent task as the meeting's current status",
    (state) => {
      getMock.mockReturnValue({
        data: {
          ...baseData,
          agentTask: {
            id: "historical-task",
            state,
            phase: state === "completed" ? "completed" : "failed",
            trigger: "automatic",
            sendToNotion: false,
            error: state === "failed" ? "Retired legacy task" : null,
          },
        },
        isPending: false,
      });
      renderAt(baseData.stem);

      expect(screen.queryByTestId("agent-task-status")).toBeNull();
      expect(screen.getByRole("button", { name: /重新转写/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeEnabled();
      expect(screen.getByRole("button", { name: /分享摘要/i })).toBeEnabled();
    },
  );

  it("guides an xAI auth-context expiry to re-authorize", () => {
    const error = "Selected audio engine unavailable after 3 attempts: xAI transcription failed (500): Auth context expired.";
    getMock.mockReturnValue({
      data: {
        ...baseData,
        status: "transcription_failed",
        statusError: error,
        agentTask: {
          id: "expired-xai-task",
          state: "failed",
          phase: "failed",
          trigger: "automatic",
          sendToNotion: false,
          error,
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);

    expect(screen.getByTestId("agent-task-status")).toHaveTextContent("xAI 授权失效");
    expect(screen.getByRole("link", { name: "重新授权 xAI" }))
      .toHaveAttribute("href", "/settings/transcription");
  });

  it("guides a real xAI 401 failure to re-authorize", () => {
    const error = "Selected audio engine unavailable: xAI transcription failed (401): Unauthorized";
    getMock.mockReturnValue({
      data: {
        ...baseData,
        status: "transcription_failed",
        statusError: error,
        agentTask: {
          id: "unauthorized-xai-task",
          state: "failed",
          phase: "failed",
          trigger: "manual",
          sendToNotion: false,
          error,
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);

    expect(screen.getByTestId("agent-task-status")).toHaveTextContent("xAI 授权失效");
    expect(screen.getByRole("link", { name: "重新授权 xAI" }))
      .toHaveAttribute("href", "/settings/transcription");
  });

  it("blocks deletion while Notion delivery is unverified", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "task-1",
          state: "delivery_unverified",
          phase: "failed",
          sendToNotion: true,
          error: "Host restarted during delivery",
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);

    expect(screen.getByRole("button", { name: /删除录音/i })).toBeDisabled();
  });

  it("does not render an untrusted legacy Notion URL as a link", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        agentTask: {
          id: "task-1",
          state: "completed",
          phase: "completed",
          sendToNotion: true,
          error: null,
        },
        notionDelivery: {
          status: "reported",
          url: "javascript:alert(document.cookie)",
          detail: null,
        },
      },
      isPending: false,
    });
    const { container } = renderAt(baseData.stem);

    expect(container.querySelector(".reader-agent-task-status")).toBeNull();
  });

  it("surfaces transcription mutation errors on the button", async () => {
    getMock.mockReturnValue({ data: baseData, isPending: false });
    transcribeMutate.mockImplementation((_args: unknown, opts: { onError?: (err: Error) => void }) => {
      opts.onError?.(new Error("Job already running for this recording"));
    });
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /重新转写/i }));
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Job already running/ })).toBeInTheDocument();
    });
  });

  it("renders the summary through MarkdownView, not a raw <pre>", () => {
    getMock.mockReturnValue({ data: { stem: "Memo_20260101_120000", title: "Memo", mtimeMs: 1, transcript: "t", summary: "# Heading", status: "idle" }, isPending: false });
    renderAt("Memo_20260101_120000");
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Heading");
  });

  it("copies the raw summary Markdown", async () => {
    const summary = "# Heading\n\n- keep\n- markdown";
    getMock.mockReturnValue({ data: { ...baseData, summary }, isPending: false });
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /复制摘要 Markdown/i }));
    await waitFor(() => expect(clipboardWriteText).toHaveBeenCalledWith(summary));
  });

  // ---- Feature 5: rename / tags / delete ----

  it("inline-renames the title and fires the rename mutation on Enter", () => {
    getMock.mockReturnValue({ data: baseData, isPending: false });
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /TeamSync/ }));
    const input = screen.getByLabelText("录音标题") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Q3 Planning" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(renameMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, title: "Q3 Planning" },
      expect.anything(),
    );
  });

  it("Escape cancels the rename without mutating", () => {
    getMock.mockReturnValue({ data: baseData, isPending: false });
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /TeamSync/ }));
    const input = screen.getByLabelText("录音标题");
    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(renameMutate).not.toHaveBeenCalled();
  });

  it("renders existing tags and adds one through the TagEditor", () => {
    getMock.mockReturnValue({ data: { ...baseData, tags: ["work"] }, isPending: false });
    renderAt(baseData.stem);
    expect(screen.getByText("work")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /添加标签/i }));
    const input = screen.getByPlaceholderText("标签…");
    fireEvent.change(input, { target: { value: "client" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(setTagsMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, tags: ["work", "client"] },
      expect.anything(),
    );
  });

  it("renames a speaker from the speaker panel", () => {
    getMock.mockReturnValue({
      data: {
        ...baseData,
        speakerData: {
          provider: "sherpa-onnx",
          num_speakers_detected: 2,
          segments: [
            { start: 0, end: 1, text: "hello", speaker_id: "spk-0", display_name: "Speaker 1", confident: true },
            { start: 2, end: 3, text: "world", speaker_id: "spk-1", display_name: "Speaker 2", confident: false },
          ],
          speakers: {
            "spk-0": { display_name: "Speaker 1", merged_into: null },
            "spk-1": { display_name: "Speaker 2", merged_into: null },
          },
        },
      },
      isPending: false,
    });
    renderAt(baseData.stem);
    expect(screen.getByText("说话人")).toBeInTheDocument();
    const input = screen.getByLabelText("Speaker 1 的说话人名称");
    fireEvent.change(input, { target: { value: "Lewis" } });
    fireEvent.blur(input);
    expect(renameSpeakerMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, speakerId: "spk-0", displayName: "Lewis" },
      expect.anything(),
    );
  });

  it("deletes after confirm and navigates back to /inbox", () => {
    getMock.mockReturnValue({ data: baseData, isPending: false });
    deleteMutate.mockImplementation((_args: unknown, opts: { onSuccess?: () => void }) => opts.onSuccess?.());
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /删除录音/i }));
    expect(confirmMock).toHaveBeenCalled();
    expect(deleteMutate).toHaveBeenCalledWith({ stem: baseData.stem }, expect.anything());
    expect(navigateMock).toHaveBeenCalledWith("/inbox", { replace: true });
  });

  it("does not delete when the confirm is dismissed", () => {
    confirmMock.mockReturnValue(false);
    getMock.mockReturnValue({ data: baseData, isPending: false });
    renderAt(baseData.stem);
    fireEvent.click(screen.getByRole("button", { name: /删除录音/i }));
    expect(deleteMutate).not.toHaveBeenCalled();
  });
});
