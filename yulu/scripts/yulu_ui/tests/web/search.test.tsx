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

  it("renders result rows with stem + score + snippet (hit segments colored)", async () => {
    // Override the mock to return some hits
    const hits = {
      hits: [
        {
          kind: "voicemail_summary",
          stem: "voicemail_20260526_120000",
          meetingTitle: "voicemail",
          recordedAt: "2026-05-26T12:00:00",
          sourcePath: "/x/y.md",
          score: 1.5,
          snippet: "Quarter [hit]OKR[/hit] review next",
        },
      ],
      telemetry: { sweepMs: 12, queryMs: 4, fallbackUsed: false, hitCount: 1 },
    };
    // Reset module mock with new return value
    const { vi } = await import("vitest");
    vi.resetModules();
    vi.doMock("../../web/src/trpc.js", () => ({
      trpc: {
        search: { run: { useQuery: () => ({ data: hits, isPending: false }) } },
      },
    }));
    // Re-import after re-mock (vitest convention)
    const { Search: SearchHits } = await import("../../web/src/routes/inbox/search.js");
    const { createMemoryRouter, RouterProvider } = await import("react-router");
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter(
      [{ path: "/inbox/search", Component: SearchHits }],
      { initialEntries: ["/inbox/search?q=OKR"] },
    );
    const { render } = await import("@testing-library/react");
    const { container } = render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    expect(container.querySelector(".search-result")).not.toBeNull();
    expect(container.querySelector(".search-snippet-hit")).not.toBeNull();
    expect(container.querySelector(".search-snippet-hit")?.textContent).toBe("OKR");
  });
});
