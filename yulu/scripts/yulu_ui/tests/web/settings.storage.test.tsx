import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsStorage } from "../../web/src/routes/settings/storage.js";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
const reindexMutate = vi.fn(async () => ({ ok: true }));

const DB_STATS = [
  { name: "prompts", path: "/x/prompts.sqlite", size: 1024, rows: 12 },
  { name: "vocab", path: "/x/vocab.sqlite", size: 2048, rows: 34 },
  { name: "search", path: "/x/search.sqlite", size: 4096, rows: 56 },
];

const LOG_PATHS = [
  { name: "audiodaemon", path: "/logs/audiodaemon.log" },
  { name: "sttdaemon", path: "/logs/sttdaemon.log" },
  { name: "agentqueue", path: "/logs/agentqueue.log" },
  { name: "statusagent", path: "/logs/statusagent.log" },
  { name: "scheduler", path: "/logs/scheduler.log" },
  { name: "detector", path: "/logs/detector.log" },
  { name: "calendar", path: "/logs/calendar.log" },
  { name: "ui", path: "/logs/ui.log" },
];

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: { output_dir: "/tmp/out" }, transcription: {}, llm: {} }, isPending: false }) },
      update: { useMutation: () => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => updateMutate(vars),
        isPending: false,
      }) },
    },
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: null }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
      dbStats: { useQuery: () => ({ data: DB_STATS, isPending: false }) },
      logPaths: { useQuery: () => ({ data: LOG_PATHS, isPending: false }) },
    },
    search: {
      reindex: { useMutation: () => ({
        mutateAsync: async () => reindexMutate(),
        isPending: false,
      }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/storage", Component: SettingsStorage }], { initialEntries: ["/settings/storage"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/Storage page", () => {
  it("renders Output dir row", () => {
    mount();
    expect(screen.getByText("Output dir")).toBeInTheDocument();
    expect(screen.getByText("/tmp/out")).toBeInTheDocument();
  });

  it("renders 3 DbStatsRow entries (prompts/vocab/search)", () => {
    const { container } = mount();
    const dbRows = container.querySelectorAll(".dbstats-row");
    expect(dbRows.length).toBe(3);
    expect(screen.getByText("/x/prompts.sqlite")).toBeInTheDocument();
    expect(screen.getByText("/x/vocab.sqlite")).toBeInTheDocument();
    expect(screen.getByText("/x/search.sqlite")).toBeInTheDocument();
  });

  it("Reindex button (only on search row) fires search.reindex", async () => {
    mount();
    const user = userEvent.setup();
    const buttons = screen.getAllByRole("button", { name: "Reindex" });
    expect(buttons.length).toBe(1);
    await user.click(buttons[0]!);
    await vi.waitFor(() => expect(reindexMutate).toHaveBeenCalled());
  });

  it("renders log rows under 'Logs' section", () => {
    mount();
    expect(screen.getByText("Logs")).toBeInTheDocument();
    for (const lp of LOG_PATHS) {
      expect(screen.getByText(lp.name)).toBeInTheDocument();
      expect(screen.getByText(lp.path)).toBeInTheDocument();
    }
  });
});
