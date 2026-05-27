import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { SettingsHotkey } from "../../web/src/routes/settings/hotkey.js";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["statusagent"], daemonsNeedingSighup: [] }));
const restartMutate = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: {}, transcription: {}, llm: {}, status_agent: { enabled: true, hotkey: { key: "V", modifiers: ["cmd", "shift"] } } }, isPending: false }) },
      update: { useMutation: ({ onSuccess }: { onSuccess?: (res: { daemonsNeedingRestart: string[] }, vars: { key: string; value: unknown }) => void }) => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => {
          const res = await updateMutate(vars);
          onSuccess?.(res, vars);
          return res;
        },
        isPending: false,
      }) },
    },
    daemons: {
      restart: { useMutation: ({ onSuccess }: { onSuccess?: (res: unknown, vars: { name: string }) => void }) => ({
        mutateAsync: async (vars: { name: string }) => {
          const res = await restartMutate();
          onSuccess?.(res, vars);
          return res;
        },
        isPending: false,
      }) },
    },
    system: {
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/hotkey", Component: SettingsHotkey }], { initialEntries: ["/settings/hotkey"] });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>,
  );
}

describe("Settings/Hotkey & UI page", () => {
  it("renders status_agent enabled toggle", () => {
    mount();
    expect(screen.getByText("Status agent enabled")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("renders HotkeyCapture showing current glyph", () => {
    mount();
    expect(screen.getByText("Hotkey")).toBeInTheDocument();
    // formatHotkey({ key: "V", modifiers: ["cmd", "shift"] }) === "⌘⇧V"
    expect(screen.getByText("⌘⇧V")).toBeInTheDocument();
  });

  it("renders ThemeToggle", () => {
    mount();
    expect(screen.getByText("UI theme")).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Theme" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Auto" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Light" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dark" })).toBeInTheDocument();
  });

  it("renders readonly UI port row with 7777 + help text", () => {
    mount();
    expect(screen.getByText("UI port")).toBeInTheDocument();
    expect(screen.getByText("7777")).toBeInTheDocument();
    expect(screen.getByText(/Edit com\.yulu\.ui\.plist/)).toBeInTheDocument();
  });
});
