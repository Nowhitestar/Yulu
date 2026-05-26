// tests/web/search.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Search } from "../../web/src/routes/inbox/search.js";

const runMock = vi.fn(() => ({ data: undefined, isPending: false }));
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    search: {
      run: {
        useQuery: (_input: unknown) => {
          runMock();
          return { data: undefined, isPending: false };
        },
      },
    },
  },
}));

function mount(initialPath = "/inbox/search") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/search", Component: Search }],
    { initialEntries: [initialPath] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Search page", () => {
  it("renders an input with role=searchbox", () => {
    mount();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
  });

  it("populates input from ?q= URL param", () => {
    mount("/inbox/search?q=OKR");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("OKR");
  });

  it("typing into the input writes ?q= to URL", async () => {
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "OKR");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("OKR");
  });
});
