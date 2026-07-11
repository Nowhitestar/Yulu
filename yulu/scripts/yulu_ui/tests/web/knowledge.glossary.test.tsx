// tests/web/knowledge.glossary.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Glossary } from "../../web/src/routes/knowledge/glossary.js";

const ROWS = [
  { id: "1", term: "AgentKey", canonical: "AgentKey", scope: "both" },
  { id: "2", term: "Agency", canonical: "AgentKey", scope: "both" },
  { id: "3", term: "OpenClaw", canonical: "OpenClaw", scope: "both" },
  { id: "4", term: "Yulu", canonical: "Yulu", scope: "prompt" },
];

const addMutate = vi.fn(async () => ({ ok: true }));
const deleteMutate = vi.fn(async () => ({ deleted: 1 }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    glossary: {
      list: { useQuery: () => ({ data: ROWS, isPending: false }) },
      add: { useMutation: () => ({ mutateAsync: addMutate, isPending: false }) },
      deleteMany: { useMutation: () => ({ mutateAsync: deleteMutate, isPending: false }) },
    },
  },
}));

beforeEach(() => {
  addMutate.mockReset();
  addMutate.mockResolvedValue({ ok: true });
  deleteMutate.mockReset();
  deleteMutate.mockResolvedValue({ deleted: 1 });
});

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/knowledge/glossary", Component: Glossary }],
    { initialEntries: ["/knowledge/glossary"] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("Glossary page", () => {
  it("renders one tag per canonical proper noun", () => {
    mount();
    expect(screen.getByRole("heading", { name: "专有名词" })).toBeInTheDocument();
    expect(screen.getByText("3 个词")).toBeInTheDocument();
    expect(screen.getAllByText("AgentKey")).toHaveLength(1);
    expect(screen.queryByText("Agency")).not.toBeInTheDocument();
    expect(screen.getByText("OpenClaw")).toBeInTheDocument();
    expect(screen.getByText("Yulu")).toBeInTheDocument();
  });

  it("adds a term with prompt and correction semantics on Enter", async () => {
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("输入专有名词，按回车添加"), "Liquid Glass{Enter}");
    await vi.waitFor(() => expect(addMutate).toHaveBeenCalledWith({
      term: "Liquid Glass",
      canonical: "Liquid Glass",
      scope: "both",
      notes: undefined,
    }));
  });

  it("deletes every hidden alias row behind a canonical tag without confirmation", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "删除 AgentKey" }));
    await vi.waitFor(() => expect(deleteMutate).toHaveBeenCalledWith({ ids: ["1", "2"] }));
  });

  it("does not add a duplicate term", async () => {
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("输入专有名词，按回车添加"), "agentkey{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("这个词已经在术语表里了。");
    expect(addMutate).not.toHaveBeenCalled();
  });

  it("shows a recoverable error when adding fails", async () => {
    addMutate.mockRejectedValueOnce(new Error("offline"));
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("输入专有名词，按回车添加"), "New term{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("添加失败，请重试。");
    expect(screen.getByLabelText("输入专有名词，按回车添加")).toHaveValue("New term");
  });

  it("keeps the tag visible and shows an error when deleting fails", async () => {
    deleteMutate.mockRejectedValueOnce(new Error("offline"));
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "删除 AgentKey" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("删除失败，请重试。");
    expect(screen.getByText("AgentKey")).toBeInTheDocument();
  });
});
