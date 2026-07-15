// tests/web/Pill.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Pill, type PillState } from "../../web/src/components/Pill.js";

const toggleMock = vi.fn();
const stateQueryMock = vi.fn(() => ({ data: { state: "idle", hotkey: "⌘⇧V" }, dataUpdatedAt: 0 }));
let queryOptions: { refetchInterval?: number; refetchIntervalInBackground?: boolean } | undefined;

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recording: {
      state: { useQuery: (_input: unknown, options: typeof queryOptions) => {
        queryOptions = options;
        return stateQueryMock();
      } },
      toggle: { useMutation: () => ({ mutate: toggleMock, isPending: false }) },
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
  toggleMock.mockReset();
  wsHandlers.clear();
  queryOptions = undefined;
  stateQueryMock.mockReturnValue({ data: { state: "idle", hotkey: "⌘⇧V" }, dataUpdatedAt: 0 });
});

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
    stateQueryMock.mockReturnValue({ data: { state, hotkey: "⌘⇧V" }, dataUpdatedAt: 0 });
    render(<Pill />);
    expect(screen.getByText(mustContain)).toBeInTheDocument();
  });

  it("follows confirmed recording state and advances the timer", () => {
    vi.useFakeTimers();
    try {
      const { rerender } = render(<Pill />);
      stateQueryMock.mockReturnValue({ data: { state: "recording", hotkey: "⌘⇧V" }, dataUpdatedAt: 1 });
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

  it("reconciles a stale WS state after an unchanged confirmed poll", () => {
    const confirmedIdle = { state: "idle", hotkey: "⌘⇧V" };
    stateQueryMock.mockReturnValue({ data: confirmedIdle, dataUpdatedAt: 1 });
    const { rerender } = render(<Pill />);

    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText("0:00")).toBeInTheDocument();

    stateQueryMock.mockReturnValue({ data: confirmedIdle, dataUpdatedAt: 2 });
    rerender(<Pill />);
    expect(screen.getByRole("button", { name: /录制/ })).toBeInTheDocument();
  });

  it("keeps the last live state when status polling is unavailable", () => {
    const { rerender } = render(<Pill />);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText("0:00")).toBeInTheDocument();

    stateQueryMock.mockReturnValue({ data: { state: "unknown", hotkey: "?" }, dataUpdatedAt: 1 });
    rerender(<Pill />);
    expect(screen.getByText("0:00")).toBeInTheDocument();
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
    expect(screen.getByText(/:[0-9]{2}/)).toBeInTheDocument();
  });

  it("flips to daemonDown when audiodaemon WS event reports non-running", () => {
    render(<Pill />);
    act(() => wsHandlers.get("daemons")?.({ name: "com.yulu.audiodaemon", status: "stopped", pid: 0 }));
    expect(screen.getByText(/音频守护/)).toBeInTheDocument();
  });

  it("shows realtime Chinese transcript while recording", () => {
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
    expect(screen.getByText(/实时转写/)).toBeInTheDocument();
    expect(screen.getByText(/这是中文/)).toBeInTheDocument();
  });
});
