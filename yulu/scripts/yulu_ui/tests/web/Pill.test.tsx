// tests/web/Pill.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Pill, type PillState } from "../../web/src/components/Pill.js";

const toggleMock = vi.fn();
let mutationError: Error | null = null;
type StateData = { state: string; hotkey: string; recordingStartedAt?: number | null };
const stateQueryMock = vi.fn((): { data: StateData; dataUpdatedAt: number } => ({ data: { state: "idle", hotkey: "⌘⇧V" }, dataUpdatedAt: 0 }));
let queryOptions: { refetchInterval?: number; refetchIntervalInBackground?: boolean } | undefined;

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recording: {
      state: { useQuery: (_input: unknown, options: typeof queryOptions) => {
        queryOptions = options;
        return stateQueryMock();
      } },
      toggle: { useMutation: () => ({ mutate: toggleMock, isPending: false, error: mutationError }) },
    },
  },
}));

const wsHandlers = new Map<string, (payload: unknown) => void>();
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: (channel: string, fn: (p: unknown) => void) => { wsHandlers.set(channel, fn); },
  nextBackoff: (n: number) => n,
}));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-10T04:00:00Z"));
  toggleMock.mockReset();
  mutationError = null;
  wsHandlers.clear();
  queryOptions = undefined;
  stateQueryMock.mockReturnValue({ data: { state: "idle", hotkey: "⌘⇧V" }, dataUpdatedAt: 0 });
});
afterEach(() => vi.useRealTimers());

describe("Pill state machine", () => {
  const cases: { state: PillState; mustContain: RegExp }[] = [
    { state: "idle",        mustContain: /录制/ },
    { state: "recording",   mustContain: /:[0-9]{2}/ },
    { state: "processing",  mustContain: /转写/ },
    { state: "meetingBusy", mustContain: /会议/ },
    { state: "daemonDown",  mustContain: /音频守护/ },
    { state: "unknown",     mustContain: /录音状态不可用/ },
  ];

  it.each(cases)("renders the right markup for state: $state", ({ state, mustContain }) => {
    stateQueryMock.mockReturnValue({ data: { state, hotkey: "⌘⇧V", recordingStartedAt: Date.now() }, dataUpdatedAt: 0 });
    render(<Pill />);
    expect(screen.getByText(mustContain)).toBeInTheDocument();
  });

  it("follows confirmed recording state and advances the timer", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Pill />);
      stateQueryMock.mockReturnValue({ data: { state: "recording", hotkey: "⌘⇧V", recordingStartedAt: Date.now() }, dataUpdatedAt: 1 });
      rerender(<Pill />);
      expect(screen.getByText("0:00")).toBeInTheDocument();

      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByText("0:01")).toBeInTheDocument();

      stateQueryMock.mockReturnValue({ data: { state: "idle", hotkey: "⌘⇧V" }, dataUpdatedAt: 2 });
      rerender(<Pill />);
      expect(screen.getByRole("button", { name: /录制/ })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores capture duration when the window closes and reopens", () => {
    const data = { state: "recording", hotkey: "⌘⇧V", recordingStartedAt: Date.now() - 125_000 };
    stateQueryMock.mockReturnValue({ data, dataUpdatedAt: 1 });
    const firstWindow = render(<Pill />);
    expect(screen.getByText("2:05")).toBeInTheDocument();
    firstWindow.unmount();

    act(() => vi.advanceTimersByTime(35_000));
    render(<Pill />);
    expect(screen.getByText("2:40")).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("2:41")).toBeInTheDocument();
  });

  it("catches up after background callbacks are suspended", () => {
    stateQueryMock.mockReturnValue({ data: {
      state: "recording", hotkey: "⌘⇧V", recordingStartedAt: Date.now() - 30_000,
    }, dataUpdatedAt: 1 });
    render(<Pill />);
    expect(screen.getByText("0:30")).toBeInTheDocument();
    vi.setSystemTime(Date.now() + 90_000); // Time passes with no interval callbacks.
    act(() => vi.advanceTimersByTime(1_000));
    expect(screen.getByText("2:01")).toBeInTheDocument();
  });

  it("keeps the clock across polls and uses a new capture's start time", () => {
    const data = { state: "recording", hotkey: "⌘⇧V", recordingStartedAt: Date.now() - 61_000 };
    stateQueryMock.mockReturnValue({ data, dataUpdatedAt: 1 });
    const { rerender } = render(<Pill />);
    act(() => vi.advanceTimersByTime(1_000));
    stateQueryMock.mockReturnValue({ data, dataUpdatedAt: 2 });
    rerender(<Pill />);
    expect(screen.getByText("1:02")).toBeInTheDocument();

    // The window may have missed the idle transition between two captures.
    stateQueryMock.mockReturnValue({ data: { ...data, recordingStartedAt: Date.now() - 2_000 }, dataUpdatedAt: 3 });
    rerender(<Pill />);
    expect(screen.getByText("0:02")).toBeInTheDocument();
  });

  it.each([undefined, null, 0, -1, NaN, Infinity])("does not invent a timer for unavailable capture time: %s", (recordingStartedAt) => {
    stateQueryMock.mockReturnValue({ data: { state: "recording", hotkey: "⌘⇧V", recordingStartedAt }, dataUpdatedAt: 1 });
    render(<Pill />);
    act(() => vi.advanceTimersByTime(5_000));
    expect(screen.getByText("--:--")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();
  });

  it("reconciles a stale WS state after an unchanged confirmed poll", () => {
    const confirmedIdle = { state: "idle", hotkey: "⌘⇧V" };
    stateQueryMock.mockReturnValue({ data: confirmedIdle, dataUpdatedAt: 1 });
    const { rerender } = render(<Pill />);

    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText("--:--")).toBeInTheDocument();

    stateQueryMock.mockReturnValue({ data: confirmedIdle, dataUpdatedAt: 2 });
    rerender(<Pill />);
    expect(screen.getByRole("button", { name: /录制/ })).toBeInTheDocument();
  });

  it("shows unavailable controls instead of offering a toggle against stale state", () => {
    const { rerender } = render(<Pill />);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText("--:--")).toBeInTheDocument();

    stateQueryMock.mockReturnValue({ data: { state: "unknown", hotkey: "?" }, dataUpdatedAt: 1 });
    rerender(<Pill />);
    expect(screen.getByRole("alert")).toHaveTextContent("录音状态不可用");
    expect(screen.queryByRole("button", { name: /停止/ })).not.toBeInTheDocument();
  });

  it("explains a rejected update-time command without replaying it", () => {
    mutationError = new Error("controls_quiescing");
    render(<Pill />);
    expect(screen.getByRole("alert")).toHaveTextContent("更新期间暂停录音控制");
    expect(toggleMock).not.toHaveBeenCalled();
  });

  it("does not offer a recording action before status is known", () => {
    stateQueryMock.mockReturnValue({ data: { state: "unknown", hotkey: "?" }, dataUpdatedAt: 1 });
    render(<Pill />);

    expect(screen.getByRole("alert")).toHaveTextContent("录音状态不可用");
    expect(screen.queryByRole("button", { name: /录制/ })).not.toBeInTheDocument();
  });

  it("clicking the idle pill fires recording.toggle", async () => {
    render(<Pill />);
    const btn = screen.getByRole("button", { name: /录制/ });
    btn.click();
    expect(toggleMock).toHaveBeenCalledTimes(1);
  });

  it("polls the confirmed recording state in the background", () => {
    render(<Pill />);
    expect(queryOptions).toMatchObject({
      refetchInterval: 500,
      refetchIntervalInBackground: true,
    });
  });

  it("transitions to recording when WS publishes recording state", () => {
    render(<Pill />);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText("--:--")).toBeInTheDocument();
  });

  it("flips to daemonDown when audiodaemon WS event reports non-running", () => {
    render(<Pill />);
    act(() => wsHandlers.get("daemons")?.({ name: "com.yulu.audiodaemon", status: "stopped", pid: 0 }));
    expect(screen.getByText(/音频守护/)).toBeInTheDocument();
  });

  it("keeps recording controls without an in-app live transcript popup", () => {
    render(<Pill />);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    act(() => wsHandlers.get("realtime-transcript")?.({
      status: "transcribing",
      stem: "中文会议_20260714_160000",
      language: "zh",
      text: "这是中文，with an English term",
      coveredMs: 15_000,
      trusted: false,
    }));
    expect(screen.queryByRole("log")).not.toBeInTheDocument();
    expect(screen.queryByText(/实时转写|这是中文/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /停止/ })).toBeInTheDocument();
    expect(screen.getByText("--:--")).toBeInTheDocument();
  });
});
