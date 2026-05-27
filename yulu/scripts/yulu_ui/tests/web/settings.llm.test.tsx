import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsLlm } from "../../web/src/routes/settings/llm.js";

const testMutateMock = vi.fn(async () => ({ ok: true, stdout: "hi there", stderr: "" }));
const updateMock = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: ["agentqueue"] }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: {}, transcription: {}, llm: { enabled: true, command: ["claude", "--print"] } }, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: async (_vars: unknown) => updateMock() }) },
    },
    daemons: { restart: { useMutation: () => ({ mutateAsync: async () => ({ ok: true }) }) } },
    llm: { test: { useMutation: () => ({ mutateAsync: async () => testMutateMock(), isPending: false }) } },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/llm", Component: SettingsLlm }], { initialEntries: ["/settings/llm"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/LLM page", () => {
  it("renders Enabled toggle + CommandEditor + Test button", () => {
    mount();
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);   // CommandEditor: 2 args
    expect(screen.getByRole("button", { name: /test command/i })).toBeInTheDocument();
  });

  it("clicking Test command triggers llm.test + popover shows stdout", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /test command/i }));
    await vi.waitFor(() => expect(testMutateMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
  });
});
