// tests/web/Sidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { Sidebar } from "../../web/src/components/Sidebar.js";

// Mock the trpc react proxy so Sidebar's useQuery returns deterministic data
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    sidebar: { counts: { useQuery: () => ({ data: { voicemails: 3, meetings: 5, prompts: 7, glossary: 12 } }) } },
  },
}));

// Stub ws so Sidebar doesn't try to open a real WebSocket
vi.mock("../../web/src/ws.js", () => ({
  useWsChannel: () => {},
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  nextBackoff: (n: number) => n,
}));

function mount(initialPath = "/inbox/voicemails") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Sidebar />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("Sidebar", () => {
  it("renders all 13 nav items grouped by section", () => {
    mount();
    expect(screen.getByText("Voicemails")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByText("Glossary")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
    expect(screen.getByText("Transcription")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("Hotkey & UI")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("Daemons")).toBeInTheDocument();
    expect(screen.getByText("Logs")).toBeInTheDocument();
  });

  it("renders the four count badges from sidebar.counts", () => {
    mount();
    expect(screen.getByTestId("count-voicemails")).toHaveTextContent("3");
    expect(screen.getByTestId("count-meetings")).toHaveTextContent("5");
    expect(screen.getByTestId("count-prompts")).toHaveTextContent("7");
    expect(screen.getByTestId("count-glossary")).toHaveTextContent("12");
  });

  it("renders a static 7 for the Daemons badge (known yulu daemons)", () => {
    mount();
    expect(screen.getByTestId("count-daemons")).toHaveTextContent("7");
  });

  it("marks the active route as aria-current=page", () => {
    mount("/settings/audio");
    expect(screen.getByRole("link", { name: /audio/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /voicemails/i })).not.toHaveAttribute("aria-current");
  });

  it("includes the ThemeToggle in the sidebar", () => {
    mount();
    expect(screen.getByRole("group", { name: /theme/i })).toBeInTheDocument();
  });
});
