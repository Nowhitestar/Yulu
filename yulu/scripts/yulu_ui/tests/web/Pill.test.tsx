// tests/web/Pill.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Pill, type PillState } from "../../web/src/components/Pill.js";

const toggleMock = vi.fn();
const stateQueryMock = vi.fn(() => ({ data: { state: "idle", hotkey: "⌘⇧V" } }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recording: {
      state: { useQuery: () => stateQueryMock() },
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
  stateQueryMock.mockReturnValue({ data: { state: "idle", hotkey: "⌘⇧V" } });
});

describe("Pill state machine", () => {
  const cases: { state: PillState; mustContain: RegExp }[] = [
    { state: "idle",        mustContain: /录制/ },
    { state: "recording",   mustContain: /:[0-9]{2}/ },
    { state: "processing",  mustContain: /转写/ },
    { state: "meetingBusy", mustContain: /会议/ },
    { state: "daemonDown",  mustContain: /音频守护/ },
  ];

  it.each(cases)("renders the right markup for state: $state", ({ state, mustContain }) => {
    stateQueryMock.mockReturnValueOnce({ data: { state, hotkey: "⌘⇧V" } });
    render(<Pill />);
    expect(screen.getByText(mustContain)).toBeInTheDocument();
  });

  it("clicking the idle pill fires recording.toggle", async () => {
    render(<Pill />);
    const btn = screen.getByRole("button", { name: /录制/ });
    btn.click();
    expect(toggleMock).toHaveBeenCalledTimes(1);
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
});
