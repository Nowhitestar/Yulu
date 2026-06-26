import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const HEALTH = [
  { name: "com.yulu.audiodaemon", status: "running", pid: 1234, exitStatus: 0, lastLog: "Listening" },
  { name: "com.yulu.sttdaemon",   status: "running", pid: 1235, exitStatus: 0, lastLog: "Ready" },
  { name: "com.yulu.agentqueue",  status: "stopped", pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.statusagent", status: "running", pid: 1236, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.scheduler",   status: "running", pid: 1237, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.detector",    status: "crashed", pid: 0,    exitStatus: 137, lastLog: "OOM" },
  { name: "com.yulu.calendar",    status: "stopped", pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.ui",          status: "running", pid: 1238, exitStatus: 0, lastLog: "" },
];

vi.mock("../../../web/src/trpc.js", () => {
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => ({ ok: true }),
    isPending: false,
  });
  return {
    trpc: {
      daemons: {
        health:  { useQuery: () => ({ data: HEALTH, isPending: false }) },
        restart: { useMutation: noopMutation },
        stop:    { useMutation: noopMutation },
        start:   { useMutation: noopMutation },
      },
      doctor: {
        run: { useQuery: () => ({ data: { ok: true, report: { checks: [] }, search: { ok: true, report: {} } }, isPending: false, refetch: vi.fn() }) },
      },
      queue: {
        list: { useQuery: () => ({ data: { path: "/x/agent-queue.json", entries: [], stats: {}, total: 0 }, isPending: false, refetch: vi.fn() }) },
        retry: { useMutation: noopMutation },
        cancel: { useMutation: noopMutation },
        clearStale: { useMutation: noopMutation },
      },
      scheduler: {
        overview: { useQuery: () => ({
          data: { schedulePath: "/x/schedule.json", events: [], meetings: [], schedulerStatus: { pid: 1, exitStatus: 0 }, calendarStatus: null },
          isPending: false,
          refetch: vi.fn(),
        }) },
        reload: { useMutation: noopMutation },
      },
      logs: {
        tail: { useQuery: ({ name }: { name: string }) => ({
          data: { lines: [`first line for ${name}`], path: `/x/${name}.log` },
          isPending: false,
        }) },
      },
    },
    makeTrpcClient: () => ({}),
  };
});

vi.mock("../../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

import { Health } from "../../../web/src/routes/health.js";

function wrap(initial = "/health") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initial]}>
        <Health />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Health (consolidated)", () => {
  it("renders the summary card", () => {
    const { getByTestId } = wrap();
    expect(getByTestId("health-summary")).toBeInTheDocument();
  });

  it("renders control-surface tabs", () => {
    const { getByTestId } = wrap();
    expect(getByTestId("tab-doctor")).toBeInTheDocument();
    expect(getByTestId("tab-queue")).toBeInTheDocument();
    expect(getByTestId("tab-scheduler")).toBeInTheDocument();
    expect(getByTestId("tab-daemons")).toBeInTheDocument();
    expect(getByTestId("tab-logs")).toBeInTheDocument();
  });

  it("defaults to Doctor tab", () => {
    const { getByTestId } = wrap();
    expect(getByTestId("tab-doctor").getAttribute("aria-selected")).toBe("true");
    expect(getByTestId("tab-logs").getAttribute("aria-selected")).toBe("false");
  });

  it("opens Logs tab when URL hash is #logs", () => {
    const { getByTestId } = wrap("/health#logs");
    expect(getByTestId("tab-logs").getAttribute("aria-selected")).toBe("true");
  });

  it("LogsSection reads ?name= from URL", () => {
    const { container } = wrap("/health?name=com.yulu.scheduler#logs");
    const select = container.querySelector('[data-testid="logs-daemon"]') as HTMLSelectElement | null;
    expect(select?.value).toBe("com.yulu.scheduler");
  });
});
