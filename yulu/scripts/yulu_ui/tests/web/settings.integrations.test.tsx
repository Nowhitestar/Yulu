import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsIntegrations } from "../../web/src/routes/settings/integrations.js";

const updateMock = vi.fn(async (_vars: unknown) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
const testMock = vi.fn(async (_vars: unknown) => ({ ok: true, stdout: "connected as user@example.com", stderr: "" }));

let cfgData: unknown = {
  audio: {},
  transcription: {},
  llm: {},
  calendars: [
    { type: "feishu", enabled: true, credentials_path: "/tmp/feishu.json", account: "alice@feishu" },
    { type: "google", enabled: false, credentials_path: "", account: "" },
  ],
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: cfgData, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: async (vars: unknown) => updateMock(vars as never) }) },
    },
    integrations: {
      test: { useMutation: () => ({ mutateAsync: async (vars: unknown) => testMock(vars as never), isPending: false }) },
    },
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: null }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn(), mutateAsync: async () => ({ ok: true }) }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/integrations", Component: SettingsIntegrations }], { initialEntries: ["/settings/integrations"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/Integrations page", () => {
  it("renders a card per calendar provider with its type as header", () => {
    cfgData = {
      audio: {}, transcription: {}, llm: {},
      calendars: [
        { type: "feishu", enabled: true, credentials_path: "/tmp/feishu.json", account: "alice@feishu" },
        { type: "google", enabled: false, credentials_path: "", account: "" },
      ],
    };
    mount();
    expect(screen.getByText("feishu")).toBeInTheDocument();
    expect(screen.getByText("google")).toBeInTheDocument();
    // each card has Enabled / Credentials path / Account / Test connection rows
    expect(screen.getAllByText("Enabled")).toHaveLength(2);
    expect(screen.getAllByText("Credentials path")).toHaveLength(2);
    expect(screen.getAllByText("Account")).toHaveLength(2);
    expect(screen.getAllByText("Test connection")).toHaveLength(2);
  });

  it("shows empty state when no calendars configured", () => {
    cfgData = { audio: {}, transcription: {}, llm: {}, calendars: [] };
    mount();
    expect(screen.getByText(/No calendar providers configured/i)).toBeInTheDocument();
  });

  it("clicking Test fires integrations.test mutation and popover shows stdout", async () => {
    cfgData = {
      audio: {}, transcription: {}, llm: {},
      calendars: [{ type: "feishu", enabled: true, credentials_path: "/tmp/feishu.json", account: "a@b" }],
    };
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^test$/i }));
    await vi.waitFor(() => expect(testMock).toHaveBeenCalledWith({ provider: "feishu" }));
    await vi.waitFor(() => expect(screen.getByText("connected as user@example.com")).toBeInTheDocument());
  });
});
