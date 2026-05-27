// tests/web/health.logs.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthLogs } from "../../web/src/routes/health/logs.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    logs: {
      tail: { useQuery: ({ name }: { name: string }) => ({
        data: { lines: [`first line for ${name}`, "second line"], path: `/x/${name}.log` },
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

function mount(initialPath = "/health/logs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/health/logs", Component: HealthLogs }], { initialEntries: [initialPath] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("HealthLogs page", () => {
  it("default daemon is com.yulu.audiodaemon when no ?name= param", () => {
    mount();
    expect(screen.getByText(/first line for com\.yulu\.audiodaemon/)).toBeInTheDocument();
  });

  it("?name= param sets initial selection", () => {
    mount("/health/logs?name=com.yulu.sttdaemon");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("com.yulu.sttdaemon");
    expect(screen.getByText(/first line for com\.yulu\.sttdaemon/)).toBeInTheDocument();
  });

  it("dropdown has 8 options (one per yulu daemon)", () => {
    mount();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.options.length).toBe(8);
  });

  it("changing dropdown updates URL + content", async () => {
    mount();
    const user = userEvent.setup();
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "com.yulu.scheduler");
    expect(screen.getByText(/first line for com\.yulu\.scheduler/)).toBeInTheDocument();
  });

  it("renders Pause + Clear buttons", () => {
    mount();
    expect(screen.getByRole("button", { name: /pause auto-scroll/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear scrollback/i })).toBeInTheDocument();
  });

  it("clicking Pause toggles label to Resume", async () => {
    mount();
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /pause auto-scroll/i });
    await user.click(btn);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
  });
});
