// tests/web/knowledge.glossary.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Glossary } from "../../web/src/routes/knowledge/glossary.js";

const ROWS = [
  { id: "1", term: "AgentKey", canonical: "AgentKey", scope: "both", notes: "product", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-02T03:04:05Z" },
  { id: "2", term: "OpenClaw", canonical: "OpenClaw", scope: "both", notes: "", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-03T00:00:00Z" },
  { id: "3", term: "Yulu", canonical: "Yulu", scope: "prompt", notes: "the app", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-04T00:00:00Z" },
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
  it("renders rows + canonical glossary headers", () => {
    mount();
    expect(screen.getByText("术语/别名")).toBeInTheDocument();
    expect(screen.getByText("标准写法")).toBeInTheDocument();
    expect(screen.getByText("作用")).toBeInTheDocument();
    expect(screen.getByText("备注")).toBeInTheDocument();
    expect(screen.getByText("最后编辑")).toBeInTheDocument();
    expect(screen.getByTestId("cell-1-term")).toHaveTextContent("AgentKey");
    expect(screen.getByTestId("cell-2-term")).toHaveTextContent("OpenClaw");
    expect(screen.getByTestId("cell-3-term")).toHaveTextContent("Yulu");
  });

  it("click cell + edit + Enter fires glossary.update", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByTestId("cell-1-term"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "AgentKey2{Enter}");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ id: "1", term: "AgentKey2" }));
  });

  it("+ Add term opens a draft row and saves glossary.add", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /\+ 添加术语/i }));
    const termInput = screen.getByPlaceholderText("术语/别名");
    await user.type(termInput, "Liquid Glass");
    await user.click(screen.getByRole("button", { name: /^保存$/i }));
    await vi.waitFor(() => expect(addMutate).toHaveBeenCalledWith({
      term: "Liquid Glass",
      canonical: "Liquid Glass",
      scope: "both",
      notes: undefined,
    }));
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
    expect(deleteMutate).toHaveBeenNthCalledWith(1, { id: "1" });
    expect(deleteMutate).toHaveBeenNthCalledWith(2, { id: "2" });
  });
});
