import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LogTail } from "../../web/src/components/LogTail.js";

const wsHandlers = new Map<string, (payload: { name: string; line: string; ts: number }) => void>();

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: (channel: string, fn: (msg: { name: string; line: string; ts: number }) => void) => {
    wsHandlers.set(channel, fn);
  },
  nextBackoff: (n: number) => n,
}));

beforeEach(() => { wsHandlers.clear(); });

describe("LogTail", () => {
  it("renders initial lines in order", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["line 1", "line 2", "line 3"]} paused={false} onClear={() => {}} />);
    const pre = screen.getByTestId("logtail-pre");
    expect(pre.textContent).toContain("line 1");
    expect(pre.textContent).toContain("line 2");
    expect(pre.textContent).toContain("line 3");
  });

  it("WS event with matching name appends a new line", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused={false} onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "audiodaemon", line: "two", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).toContain("two");
  });

  it("WS event with NON-matching name is ignored", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused={false} onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "statusagent", line: "noise", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).not.toContain("noise");
  });

  it("paused=true: WS events are NOT appended", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "audiodaemon", line: "two", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).not.toContain("two");
  });

  it("renders empty state when no initial lines and no WS events", () => {
    render(<LogTail daemonShortName="agentqueue" daemonLabel="com.yulu.agentqueue" initialLines={[]} paused={false} onClear={() => {}} />);
    expect(screen.getByText(/no log entries yet/i)).toBeInTheDocument();
  });

  it("caps line buffer at 2000 (drops oldest)", () => {
    render(<LogTail daemonShortName="ui" daemonLabel="com.yulu.ui" initialLines={[]} paused={false} onClear={() => {}} />);
    act(() => {
      for (let i = 0; i < 2100; i++) {
        wsHandlers.get("logs")?.({ name: "ui", line: `line ${i}`, ts: i });
      }
    });
    const pre = screen.getByTestId("logtail-pre");
    expect(pre.textContent).not.toContain("line 0");
    expect(pre.textContent).toContain("line 2099");
  });
});
