import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

const getMock = vi.fn();
const transcribeMutate = vi.fn();
const renameMutate = vi.fn();
const setTagsMutate = vi.fn();
const deleteMutate = vi.fn();
const renameSpeakerMutate = vi.fn();
const mergeSpeakersMutate = vi.fn();
const assignSegmentSpeakerMutate = vi.fn();
const navigateMock = vi.fn();
const confirmMock = vi.fn(() => true);

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      get: { useQuery: (...a: unknown[]) => getMock(...a) },
      transcribe: { useMutation: () => ({ mutate: transcribeMutate }) },
      summarize: { useMutation: () => ({ mutate: vi.fn() }) },
      rename: { useMutation: () => ({ mutate: renameMutate, isPending: false }) },
      setTags: { useMutation: () => ({ mutate: setTagsMutate, isPending: false }) },
      delete: { useMutation: () => ({ mutate: deleteMutate, isPending: false }) },
      renameSpeaker: { useMutation: () => ({ mutate: renameSpeakerMutate, isPending: false }) },
      mergeSpeakers: { useMutation: () => ({ mutate: mergeSpeakersMutate, isPending: false }) },
      assignSegmentSpeaker: { useMutation: () => ({ mutate: assignSegmentSpeakerMutate, isPending: false }) },
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

const baseData = {
  stem: "TeamSync_20260102_090000", type: "meeting" as const, title: "TeamSync",
  tags: [] as string[], mtimeMs: 1, transcript: "t", summary: "s", realtime: null,
  hasRealtime: false, status: "idle",
};

function renderAt(stem: string) {
  return render(
    <MemoryRouter initialEntries={[`/inbox/${stem}`]}>
      <Routes><Route path="/inbox/:stem" element={<RecordingReader />} /></Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  transcribeMutate.mockClear();
  renameMutate.mockClear(); setTagsMutate.mockClear(); deleteMutate.mockClear();
  renameSpeakerMutate.mockClear(); mergeSpeakersMutate.mockClear(); assignSegmentSpeakerMutate.mockClear();
  navigateMock.mockClear(); confirmMock.mockClear(); confirmMock.mockReturnValue(true);
});

describe("RecordingReader", () => {
  it("shows Realtime tab when hasRealtime is true (meeting)", () => {
    getMock.mockReturnValue({ data: { stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", mtimeMs: 1, transcript: "t", summary: "s", realtime: "r", hasRealtime: true, status: "idle" }, isPending: false });
    renderAt("TeamSync_20260102_090000");
    expect(screen.getByRole("button", { name: /实时/i })).toBeInTheDocument();
  });

  it("hides Realtime tab when hasRealtime is false", () => {
    getMock.mockReturnValue({ data: { stem: "Memo_20260101_120000", title: "Memo", mtimeMs: 1, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("Memo_20260101_120000");
    expect(screen.queryByRole("button", { name: /实时/i })).toBeNull();
  });

  it("renders Re-transcribe + Re-generate summary buttons", () => {
    getMock.mockReturnValue({ data: { stem: "Memo_20260101_120000", title: "Memo", mtimeMs: 1, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("Memo_20260101_120000");
    expect(screen.getByRole("button", { name: /重新转写/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /重新生成摘要/i })).toBeInTheDocument();
  });

  it("passes a speaker-count override when re-transcribing from the reader", () => {
    getMock.mockReturnValue({ data: { ...baseData, wavPath: "/tmp/TeamSync.wav" }, isPending: false });
    renderAt(baseData.stem);
    fireEvent.change(screen.getByRole("combobox", { name: /说话人数/i }), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: /重新转写/i }));
    expect(transcribeMutate).toHaveBeenCalledWith(
      { stem: baseData.stem, diarizationNumSpeakers: 3 },
      expect.anything(),
    );
  });

  it("renders the summary through MarkdownView, not a raw <pre>", () => {
    getMock.mockReturnValue({ data: { stem: "Memo_20260101_120000", title: "Memo", mtimeMs: 1, transcript: "t", summary: "# Heading", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("Memo_20260101_120000");
    expect(screen.getByTestId("markdown")).toHaveTextContent("# Heading");
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
