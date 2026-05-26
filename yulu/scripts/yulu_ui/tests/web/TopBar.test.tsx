// tests/web/TopBar.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { TopBar } from "../../web/src/components/TopBar.js";

function Layout() { return (<><TopBar /><Outlet /></>); }
function Empty() { return null; }

function mount(opts: {
  path: string;
  routeHandle?: { breadcrumb?: string; filters?: React.ReactNode };
}) {
  const router = createMemoryRouter(
    [{
      path: "/",
      element: <Layout />,
      children: [{
        path: opts.path.replace(/^\//, ""),
        element: <Empty />,
        handle: opts.routeHandle,
      }],
    }],
    { initialEntries: [opts.path] },
  );
  return render(<RouterProvider router={router} />);
}

describe("TopBar", () => {
  it("renders the breadcrumb from the active route's handle", () => {
    mount({ path: "/inbox/voicemails", routeHandle: { breadcrumb: "Inbox / Voicemails" } });
    expect(screen.getByText("Inbox / Voicemails")).toBeInTheDocument();
  });

  it("renders the filters slot when handle.filters is provided", () => {
    mount({ path: "/x", routeHandle: { breadcrumb: "X", filters: <span data-testid="f">filter</span> } });
    expect(screen.getByTestId("f")).toBeInTheDocument();
  });

  it("renders no filters area when handle.filters is null/undefined", () => {
    mount({ path: "/x", routeHandle: { breadcrumb: "X" } });
    expect(screen.queryByTestId("topbar-filters")).not.toBeInTheDocument();
  });

  it("falls back to '—' when no breadcrumb is provided", () => {
    mount({ path: "/x" });
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
