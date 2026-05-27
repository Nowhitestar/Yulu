import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Stub trpc so each sub-query returns minimal config data and mutations no-op
vi.mock("../../../web/src/trpc.js", () => {
  const cfg = {
    audio: {
      mic_device: ":0",
      system_audio_device: ":1",
      output_dir: "/tmp",
      silence_threshold: 0.01,
      silence_duration_sec: 300,
      backend: "daemon",
    },
    transcription: {
      final_engine: "mlx",
      language: "auto",
      local_model_path: "",
      mlx: { model: "", final_model: "", preprocess_audio: false, passthrough_max_sec: 0, passthrough_max_bytes: 0 },
    },
    llm: { enabled: false, command: [] },
    status_agent: { enabled: false, hotkey: { key: "V", modifiers: ["cmd", "shift"] } },
    calendars: [],
  };
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }),
    isPending: false,
  });
  return {
    trpc: {
      config: {
        get: { useQuery: () => ({ data: cfg, isPending: false }) },
        update: { useMutation: noopMutation },
      },
      daemons: {
        restart: { useMutation: noopMutation },
      },
      system: {
        audioDevices: { useQuery: () => ({ data: { input: [], output: [] }, isPending: false }) },
        dbStats: { useQuery: () => ({ data: [], isPending: false }) },
        logPaths: { useQuery: () => ({ data: [], isPending: false }) },
        pickFile: { useMutation: noopMutation },
        openInFinder: { useMutation: noopMutation },
      },
      integrations: {
        test: { useMutation: noopMutation },
      },
      llm: {
        test: { useMutation: noopMutation },
      },
      search: {
        reindex: { useMutation: noopMutation },
      },
    },
    makeTrpcClient: () => ({}),
  };
});

import { Settings } from "../../../web/src/routes/settings.js";
import { ThemeProvider } from "../../../web/src/theme.js";

function wrap(initial = "/settings") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <MemoryRouter initialEntries={[initial]}>
          <Settings />
        </MemoryRouter>
      </QueryClientProvider>
    </ThemeProvider>
  );
}

describe("Settings (consolidated)", () => {
  it("renders all 6 section headings on one page", () => {
    const { getByText } = wrap();
    expect(getByText("Audio")).toBeInTheDocument();
    expect(getByText("Transcription")).toBeInTheDocument();
    expect(getByText("LLM")).toBeInTheDocument();
    expect(getByText("Hotkey & UI")).toBeInTheDocument();
    expect(getByText("Integrations")).toBeInTheDocument();
    expect(getByText("Storage")).toBeInTheDocument();
  });

  it("sections have correct anchor IDs", () => {
    const { container } = wrap();
    expect(container.querySelector("#audio")).not.toBeNull();
    expect(container.querySelector("#transcription")).not.toBeNull();
    expect(container.querySelector("#llm")).not.toBeNull();
    expect(container.querySelector("#hotkey")).not.toBeNull();
    expect(container.querySelector("#integrations")).not.toBeNull();
    expect(container.querySelector("#storage")).not.toBeNull();
  });

  it("does not render an inner TOC sidebar", () => {
    const { container } = wrap();
    expect(container.querySelector(".settings-toc")).toBeNull();
    expect(container.querySelector('[data-testid="settings-toc"]')).toBeNull();
  });
});
