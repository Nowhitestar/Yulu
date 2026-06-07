// tests/web/knowledge.glossary.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Glossary } from "../../web/src/routes/knowledge/glossary.js";

const ROWS = [
  { id: 1, term: "AgentKey", pinyin: "",      notes: "product",  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T03:04:05Z" },
  { id: 2, term: "OpenClaw", pinyin: "",      notes: "",         created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
  { id: 3, term: "Yulu",     pinyin: "yu lu", notes: "the app",  created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
];

const updateMutate = vi.fn(async () => ({ updated: 1 }));
const addMutate    = vi.fn(async () => ({ ok: true }));
const deleteMutate = vi.fn(async () => ({ deleted: 1 }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    glossary: {
      list:   { useQuery: () => ({ data: ROWS, isPending: false }) },
      add:    { useMutation: () => ({ mutateAsync: addMutate }) },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
      delete: { useMutation: () => ({ mutateAsync: deleteMutate }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

beforeEach(() => {
  updateMutate.mockClear(); addMutate.mockClear(); deleteMutate.mockClear();
  vi.restoreAllMocks();
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/knowledge/glossary", Component: Glossary }], { initialEntries: ["/knowledge/glossary"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Glossary page", () => {
  it("renders 3 rows + 4 column headers (Term/Pinyin/Notes/Last edited)", () => {
    mount();
    expect(screen.getByText("术语")).toBeInTheDocument();
    expect(screen.getByText("拼音")).toBeInTheDocument();
    expect(screen.getByText("备注")).toBeInTheDocument();
    expect(screen.getByText("最后编辑")).toBeInTheDocument();
    expect(screen.getByText("AgentKey")).toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("Yulu")).toBeInTheDocument();
  });

  it("click cell + edit + Enter fires glossary.update", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("AgentKey"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "AgentKey2{Enter}");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ id: 1, term: "AgentKey2" }));
  });

  it("+ Add term fires glossary.add with empty term", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /\+ 添加术语/i }));
    await vi.waitFor(() => expect(addMutate).toHaveBeenCalledWith({ term: "" }));
  });

  it("bulk delete: select 2 rows + Delete + confirm → loops glossary.delete", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    mount();
    const user = userEvent.setup();
    const checkboxes = screen.getAllByRole("checkbox");
    await user.click(checkboxes[1]!);
    await user.click(checkboxes[2]!);
    await user.click(screen.getByRole("button", { name: /^删除$/i }));
    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalledTimes(2));
    expect(deleteMutate).toHaveBeenNthCalledWith(1, { id: 1 });
    expect(deleteMutate).toHaveBeenNthCalledWith(2, { id: 2 });
  });
});
