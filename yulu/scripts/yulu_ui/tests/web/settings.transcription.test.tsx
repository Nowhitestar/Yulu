import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsTranscription } from "../../web/src/routes/settings/transcription.js";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] }));
const restartMutate = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: {
        audio: {},
        transcription: {
          final_engine: "mlx",
          language: "zh",
          local_model_path: "/models/ggml.bin",
          mlx: {
            model: "mlx-community/whisper-large-v3",
            final_model: "mlx-community/whisper-large-v3-turbo",
            preprocess_audio: true,
            passthrough_max_sec: 30,
            passthrough_max_bytes: 1048576,
          },
        },
        llm: {},
      }, isPending: false }) },
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
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: null }) }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/transcription", Component: SettingsTranscription }], { initialEntries: ["/settings/transcription"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/Transcription page", () => {
  it("renders all 8 row labels", () => {
    mount();
    for (const label of [
      "Final engine",
      "Language",
      "Local model path",
      "MLX model",
      "MLX final model",
      "MLX preprocess audio",
      "MLX passthrough max sec",
      "MLX passthrough max bytes",
    ]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("editing Final engine triggers config.update + restart banner appears", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("mlx"));
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "whisper-cli");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.final_engine", value: "whisper-cli" }));
    await vi.waitFor(() => expect(screen.getByText(/Restart required/)).toBeInTheDocument());
  });

  it("renders Manage glossary link", () => {
    mount();
    const link = screen.getByRole("link", { name: /manage glossary/i });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/knowledge/glossary");
  });
});
