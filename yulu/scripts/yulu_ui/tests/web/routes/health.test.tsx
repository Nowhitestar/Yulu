import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const HEALTH = [
  { name: "com.yulu.audiodaemon", status: "running", pid: 1234, exitStatus: 0, lastLog: "Listening" },
  { name: "com.yulu.statusagent", status: "running", pid: 1236, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.scheduler",   status: "running", pid: 1237, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.detector",    status: "crashed", pid: 0,    exitStatus: 137, lastLog: "OOM" },
  { name: "com.yulu.calendar",    status: "stopped", pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.ui",          status: "running", pid: 1238, exitStatus: 0, lastLog: "" },
];

const RETRY_TASK_ID = "019f0000-0000-7000-8000-000000000001";
const AGENT_TASKS = [
  {
    id: RETRY_TASK_ID,
    recordingStem: "Failed_20260711_120000",
    title: "Failed task",
    state: "failed",
    phase: "failed",
    agentProvider: "hermes",
    attempt: 1,
    error: "Agent exited",
    createdAt: "2026-07-11T12:00:00.000Z",
    updatedAt: "2026-07-11T12:01:00.000Z",
  },
  {
    id: "019f0000-0000-7000-8000-000000000002",
    recordingStem: "Done_20260711_110000",
    title: "Completed task",
    state: "completed",
    phase: "completed",
    agentProvider: "hermes",
    attempt: 1,
    error: null,
    createdAt: "2026-07-11T11:00:00.000Z",
    updatedAt: "2026-07-11T11:05:00.000Z",
  },
  {
    id: "019f0000-0000-7000-8000-000000000003",
    recordingStem: "Unverified_20260711_100000",
    title: "Unverified delivery",
    state: "delivery_unverified",
    phase: "failed",
    agentProvider: "hermes",
    attempt: 1,
    error: "Delivery result unknown",
    createdAt: "2026-07-11T10:00:00.000Z",
    updatedAt: "2026-07-11T10:05:00.000Z",
  },
  {
    id: "019f0000-0000-7000-8000-000000000004",
    recordingStem: "Collision_20260711_090000",
    title: "Superseded failed task",
    state: "failed",
    phase: "failed",
    agentProvider: "hermes",
    attempt: 1,
    error: "Old failure",
    createdAt: "2026-07-11T09:00:00.000Z",
    updatedAt: "2026-07-11T09:01:00.000Z",
  },
  {
    id: "019f0000-0000-7000-8000-000000000005",
    recordingStem: "Collision_20260711_090000",
    title: "Active replacement task",
    state: "running",
    phase: "summarizing",
    agentProvider: "hermes",
    attempt: 1,
    error: null,
    createdAt: "2026-07-11T09:02:00.000Z",
    updatedAt: "2026-07-11T09:03:00.000Z",
  },
];

const retryMutate = vi.fn();

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
      agentTasks: {
        list: { useQuery: () => ({ data: AGENT_TASKS, isPending: false, refetch: vi.fn() }) },
        transcriptionHealth: { useQuery: () => ({ data: { available: true, paused: false, policyReason: null } }) },
        retry: { useMutation: () => ({ mutate: retryMutate, mutateAsync: retryMutate, isPending: false }) },
        confirmNotionDelivery: { useMutation: noopMutation },
        abandonNotionDelivery: { useMutation: noopMutation },
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

  it("shows durable Agent tasks and only offers retry for legal states", () => {
    retryMutate.mockClear();
    const { getByText } = wrap("/health#queue");
    const failedCard = getByText("Failed task").closest(".control-card") as HTMLElement;
    const completedCard = getByText("Completed task").closest(".control-card") as HTMLElement;
    const unverifiedCard = getByText("Unverified delivery").closest(".control-card") as HTMLElement;
    const supersededCard = getByText("Superseded failed task").closest(".control-card") as HTMLElement;

    fireEvent.click(within(failedCard).getByRole("button", { name: "重试" }));
    expect(retryMutate).toHaveBeenCalledWith({ id: RETRY_TASK_ID });
    expect(within(completedCard).queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(unverifiedCard).queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(supersededCard).queryByRole("button", { name: "重试" })).toBeNull();
    expect(within(unverifiedCard).getByRole("button", { name: "确认已有页面" })).toBeInTheDocument();
    expect(within(unverifiedCard).getByRole("button", { name: "放弃投递" })).toBeInTheDocument();
    expect(within(unverifiedCard).getByText("请先人工确认 Notion 投递结果，再决定后续操作。")).toBeInTheDocument();
  });

  it("LogsSection reads ?name= from URL", () => {
    const { container } = wrap("/health?name=com.yulu.scheduler#logs");
    const select = container.querySelector('[data-testid="logs-daemon"]') as HTMLSelectElement | null;
    expect(select?.value).toBe("com.yulu.scheduler");
  });
});
