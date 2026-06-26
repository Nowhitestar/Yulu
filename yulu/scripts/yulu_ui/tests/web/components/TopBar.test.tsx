// tests/web/components/TopBar.test.tsx
import type { ReactNode } from "react";
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, useMatches } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { TopBar } from "../../../web/src/components/TopBar.js";
import { ThemeProvider } from "../../../web/src/theme.js";
import { trpc, makeTrpcClient } from "../../../web/src/trpc.js";

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useMatches: vi.fn() };
});
vi.mock("../../../web/src/components/Pill.js", () => ({
  Pill: () => <button type="button">Record</button>,
}));

const mUseMatches = useMatches as unknown as ReturnType<typeof vi.fn>;

function setMatches(handles: unknown[]) {
  mUseMatches.mockReturnValue(handles.map((handle, i) => ({
    id: String(i),
    pathname: "/",
    params: {},
    data: undefined,
    handle,
  })));
}

function Wrap({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tc = makeTrpcClient();
  return (
    <trpc.Provider client={tc} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <MemoryRouter>{children}</MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

describe("TopBar", () => {
  it("joins multi-level breadcrumb handles with ' / '", () => {
    setMatches([{}, { breadcrumb: "Inbox" }, { breadcrumb: "Recordings" }]);
    const { container } = render(<Wrap><TopBar /></Wrap>);
    expect(container.querySelector(".topbar-breadcrumb")?.textContent).toBe("Inbox / Recordings");
  });

  it("resolves function breadcrumbs with route params", () => {
    mUseMatches.mockReturnValue([
      { id: "0", pathname: "/", params: {}, data: undefined, handle: { breadcrumb: "Inbox" } },
      { id: "1", pathname: "/inbox", params: {}, data: undefined, handle: { breadcrumb: "Recordings" } },
      { id: "2", pathname: "/inbox/abc", params: { stem: "abc" }, data: undefined,
        handle: { breadcrumb: (p: { stem?: string }) => p.stem ?? "?" } },
    ]);
    const { container } = render(<Wrap><TopBar /></Wrap>);
    expect(container.querySelector(".topbar-breadcrumb")?.textContent).toBe("Inbox / Recordings / abc");
  });

  it("does not render a placeholder dash when no segments", () => {
    setMatches([{}]);
    const { container } = render(<Wrap><TopBar /></Wrap>);
    const bc = container.querySelector(".topbar-breadcrumb");
    expect(bc?.textContent).toBe("");
  });

  it("renders the GlobalSearch slot", () => {
    setMatches([{ breadcrumb: "Inbox" }]);
    const { container } = render(<Wrap><TopBar /></Wrap>);
    expect(container.querySelector('[data-testid="topbar-search"]')).not.toBeNull();
  });

  it("renders the ThemeToggle in TopBar", () => {
    setMatches([{ breadcrumb: "Inbox" }]);
    const { container } = render(<Wrap><TopBar /></Wrap>);
    expect(container.querySelector('[role="group"][aria-label="主题"]')).not.toBeNull();
  });

  it("links the settings icon to Settings", () => {
    setMatches([{ breadcrumb: "Inbox" }]);
    render(<Wrap><TopBar /></Wrap>);
    expect(screen.getByLabelText("设置")).toHaveAttribute("href", "/settings");
  });
});
