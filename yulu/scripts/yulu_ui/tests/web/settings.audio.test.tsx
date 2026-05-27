import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsAudio } from "../../web/src/routes/settings/audio.js";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["audiodaemon"], daemonsNeedingSighup: [] }));
const restartMutate = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: { mic_device: ":0", system_audio_device: ":1", output_dir: "/x", silence_threshold: 0.01, silence_duration_sec: 300, backend: "daemon" }, transcription: {}, llm: {} }, isPending: false }) },
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
      audioDevices: { useQuery: () => ({ data: { input: [{uid:":0",name:"Built-in"},{uid:":1",name:"BlackHole"}], output: [{uid:":1",name:"BlackHole"}] }, isPending: false }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/audio", Component: SettingsAudio }], { initialEntries: ["/settings/audio"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/Audio page", () => {
  it("renders all 6 row labels", () => {
    mount();
    for (const label of ["Mic device", "System audio device", "Output dir", "Silence threshold", "Silence duration sec", "Backend"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("editing silence_threshold triggers config.update + restart banner appears", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("0.01"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.02{Enter}");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ key: "audio.silence_threshold", value: 0.02 }));
    await vi.waitFor(() => expect(screen.getByText(/Restart required/)).toBeInTheDocument());
  });

  it("Restart now fires daemons.restart for audiodaemon", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("0.01"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.02{Enter}");
    await vi.waitFor(() => expect(screen.getByText(/Restart required/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /restart now/i }));
    await vi.waitFor(() => expect(restartMutate).toHaveBeenCalled());
  });
});
