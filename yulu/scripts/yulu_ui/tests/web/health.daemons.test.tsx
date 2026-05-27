// tests/web/health.daemons.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthDaemons } from "../../web/src/routes/health/daemons.js";

const HEALTH = [
  { name: "com.yulu.audiodaemon", status: "running",  pid: 1234, exitStatus: 0, lastLog: "Listening" },
  { name: "com.yulu.sttdaemon",    status: "running",  pid: 1235, exitStatus: 0, lastLog: "Ready" },
  { name: "com.yulu.agentqueue",   status: "stopped",  pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.statusagent",  status: "running",  pid: 1236, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.scheduler",    status: "running",  pid: 1237, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.detector",     status: "crashed",  pid: 0,    exitStatus: 137, lastLog: "OOM" },
  { name: "com.yulu.calendar",     status: "stopped",  pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.ui",           status: "running",  pid: 1238, exitStatus: 0, lastLog: "" },
];

const restartMutate = vi.fn(async () => ({ ok: true }));
const stopMutate    = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    daemons: {
      health:  { useQuery: () => ({ data: HEALTH, isPending: false }) },
      restart: { useMutation: () => ({ mutateAsync: restartMutate, isPending: false }) },
      stop:    { useMutation: () => ({ mutateAsync: stopMutate, isPending: false }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HealthDaemons />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("HealthDaemons page", () => {
  it("renders 8 daemon cards", () => {
    mount();
    const cards = screen.getAllByText(/^(audiodaemon|sttdaemon|agentqueue|statusagent|scheduler|detector|calendar|ui)$/);
    expect(cards).toHaveLength(8);
  });

  it("shows status pills with right counts (5 running, 2 stopped, 1 crashed)", () => {
    const { container } = mount();
    expect(container.querySelectorAll('[data-status="running"].status-pill')).toHaveLength(5);
    expect(container.querySelectorAll('[data-status="stopped"].status-pill')).toHaveLength(2);
    expect(container.querySelectorAll('[data-status="crashed"].status-pill')).toHaveLength(1);
  });

  it("clicking Restart on audiodaemon card calls daemons.restart with full name", async () => {
    mount();
    const user = userEvent.setup();
    const restartButtons = screen.getAllByRole("button", { name: /^restart$/i });
    await user.click(restartButtons[0]!);   // first card = audiodaemon (HEALTH[0])
    expect(restartMutate).toHaveBeenCalledWith({ name: "com.yulu.audiodaemon" });
  });

  it("View logs → links point to /health/logs?name=<full-name>", () => {
    mount();
    const links = screen.getAllByRole("link", { name: /view logs/i });
    expect(links[0]).toHaveAttribute("href", "/health/logs?name=com.yulu.audiodaemon");
    expect(links[5]).toHaveAttribute("href", "/health/logs?name=com.yulu.detector");
  });
});
