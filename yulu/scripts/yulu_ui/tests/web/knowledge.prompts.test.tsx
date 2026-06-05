import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, MemoryRouter, Routes, Route } from "react-router";
// createMemoryRouter + RouterProvider used by the Prompts list tests (E.6).
// MemoryRouter + Routes/Route used by the reader-route tests (E.7); the classic
// API propagates `useNavigate()` updates in jsdom where the data-router API does not.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Prompts } from "../../web/src/routes/knowledge/prompts.js";
import { PromptsIndex } from "../../web/src/routes/knowledge/prompts.index.js";
import { PromptReaderRoute } from "../../web/src/routes/knowledge/prompts.$id.js";

// ---------- shared mock state ----------
const LIST_DATA = [
  { id: "id-1", slug: "default",  name: "Default Summary", category: "summary",   content: "x", is_auto_run: 1, source: "seed",   sort_order: 0, note: null, created_at: "", updated_at: "" },
  { id: "id-2", slug: "cleanup",  name: "Cleanup",          category: "cleanup",   content: "y", is_auto_run: 0, source: "seed",   sort_order: 1, note: null, created_at: "", updated_at: "" },
  { id: "id-3", slug: "action-items", name: "Action Items", category: "summary", content: "z", is_auto_run: 0, source: "manual", sort_order: 2, note: null, created_at: "", updated_at: "" },
];

const EXISTING_PROMPT = {
  id: "id-1",
  slug: "default",
  name: "Default Summary",
  category: "summary" as const,
  content: "Body",
  is_auto_run: 1,
  source: "seed",
  sort_order: 0,
  note: null,
  created_at: "",
  updated_at: "",
};

const mockState: {
  getReturn: unknown;
} = {
  getReturn: EXISTING_PROMPT,
};

const updateMutate = vi.fn(async (_: unknown) => ({}));
const createMutate = vi.fn(async (_: unknown) => ({ id: "id-NEW" }));
const deleteMutate = vi.fn(async (_: unknown) => ({}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    prompts: {
      list: { useQuery: () => ({ data: LIST_DATA, isPending: false }) },
      get: { useQuery: () => ({ data: mockState.getReturn, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
      create: { useMutation: () => ({ mutateAsync: createMutate }) },
      delete: { useMutation: () => ({ mutateAsync: deleteMutate }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

function mount(initialPath = "/knowledge/prompts") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{
    path: "/knowledge/prompts",
    Component: Prompts,
    children: [{ index: true, Component: PromptsIndex }],
  }], { initialEntries: [initialPath] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

function rowNames(): string[] {
  return screen.getAllByTestId("prompt-row").map((el) => {
    const t = el.querySelector(".prompt-row-title");
    return t?.textContent ?? "";
  });
}

describe("Prompts page", () => {
  it("renders 3 prompt rows with names + category chips + autorun star", () => {
    mount();
    const names = rowNames();
    expect(names).toContain("Default Summary");
    expect(names).toContain("Cleanup");
    expect(names).toContain("Action Items");
    // Category chips inside rows: one per row
    const rows = screen.getAllByTestId("prompt-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-category="summary"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-category="cleanup"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-category="summary"]')).not.toBeNull();
    // Autorun star on first row only
    expect(rows[0]).toHaveTextContent("★");
    expect(rows[1]).not.toHaveTextContent("★");
  });

  it("renders 3 filter chips (All/Summary/Cleanup) + New prompt button", () => {
    mount();
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^summary$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cleanup$/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^voicemail$/i })).toBeNull();
    expect(screen.getByRole("link", { name: /\+ new prompt/i })).toBeInTheDocument();
  });

  it("clicking Summary filter shows only summary prompts", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^summary$/i }));
    const names = rowNames();
    expect(names).toContain("Default Summary");
    expect(names).toContain("Action Items"); // also a summary-category prompt
    expect(names).not.toContain("Cleanup");
  });

  it("index outlet renders empty state when no :id selected", () => {
    mount();
    expect(screen.getByText(/select a prompt/i)).toBeInTheDocument();
  });
});

describe("Prompts reader route", () => {
  beforeEach(() => {
    updateMutate.mockClear();
    createMutate.mockClear();
    deleteMutate.mockClear();
    mockState.getReturn = EXISTING_PROMPT;
  });

  it("edit mode: editing name then Save fires prompts.update with diff", async () => {
    mockState.getReturn = EXISTING_PROMPT;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/knowledge/prompts/id-1"]}>
          <Routes>
            <Route path="/knowledge/prompts/:id" element={<PromptReaderRoute />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const name = screen.getByLabelText(/^name$/i);
    await user.clear(name);
    await user.type(name, "Renamed");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ id: "id-1", name: "Renamed" }),
    );
  });

  it("create mode (id=new): Save fires prompts.create + navigates to /knowledge/prompts/:newId", async () => {
    mockState.getReturn = undefined;
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={["/knowledge/prompts/new"]}>
          <Routes>
            <Route path="/knowledge/prompts/:id" element={<PromptReaderRoute />} />
            <Route path="/knowledge/prompts/id-NEW" element={<div data-testid="navigated-to-new" />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/^name$/i), "X");
    await user.type(screen.getByLabelText(/^slug$/i), "x-slug");
    await user.type(screen.getByLabelText(/^content$/i), "body");
    await user.click(screen.getByRole("button", { name: /^save$/i }));
    await vi.waitFor(() => expect(createMutate).toHaveBeenCalled());
    await vi.waitFor(
      () => expect(screen.getByTestId("navigated-to-new")).toBeInTheDocument(),
      { timeout: 3000 },
    );
  });
});
