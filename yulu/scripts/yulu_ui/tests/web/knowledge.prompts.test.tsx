import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Prompts } from "../../web/src/routes/knowledge/prompts.js";
import { PromptsIndex } from "../../web/src/routes/knowledge/prompts.index.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    prompts: {
      list: { useQuery: () => ({
        data: [
          { id: "id-1", slug: "default",  name: "Default Summary", category: "summary",   content: "x", is_auto_run: 1, source: "seed",   sort_order: 0, note: null, created_at: "", updated_at: "" },
          { id: "id-2", slug: "cleanup",  name: "Cleanup",          category: "cleanup",   content: "y", is_auto_run: 0, source: "seed",   sort_order: 1, note: null, created_at: "", updated_at: "" },
          { id: "id-3", slug: "vm",       name: "Voicemail Summary", category: "voicemail", content: "z", is_auto_run: 0, source: "manual", sort_order: 2, note: null, created_at: "", updated_at: "" },
        ],
        isPending: false,
      }) },
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
    expect(names).toContain("Voicemail Summary");
    // Category chips inside rows: one per row
    const rows = screen.getAllByTestId("prompt-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]?.querySelector('[data-category="summary"]')).not.toBeNull();
    expect(rows[1]?.querySelector('[data-category="cleanup"]')).not.toBeNull();
    expect(rows[2]?.querySelector('[data-category="voicemail"]')).not.toBeNull();
    // Autorun star on first row only
    expect(rows[0]).toHaveTextContent("★");
    expect(rows[1]).not.toHaveTextContent("★");
  });

  it("renders 4 filter chips (All/Summary/Cleanup/Voicemail) + New prompt button", () => {
    mount();
    expect(screen.getByRole("button", { name: /^all$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^summary$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^cleanup$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^voicemail$/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /\+ new prompt/i })).toBeInTheDocument();
  });

  it("clicking Summary filter shows only summary prompts", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^summary$/i }));
    const names = rowNames();
    expect(names).toContain("Default Summary");
    expect(names).not.toContain("Cleanup");
    expect(names).not.toContain("Voicemail Summary");
  });

  it("index outlet renders empty state when no :id selected", () => {
    mount();
    expect(screen.getByText(/select a prompt/i)).toBeInTheDocument();
  });
});
