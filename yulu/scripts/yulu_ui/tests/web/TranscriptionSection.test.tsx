// tests/web/TranscriptionSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

// ── Mutable holders the trpc mock reads from, so each test drives a different
// transcription config + detected_models payload (CapabilitiesSection + glossary mock pattern). ──
const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let modelsReturn: { data: unknown; isPending: boolean } = { data: [], isPending: false };

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => configReturn },
      update: { useMutation: () => ({ mutateAsync: updateMutate }) },
    },
    capabilities: {
      detected_models: { useQuery: () => modelsReturn },
    },
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: "/picked/dir" }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    // InlineEditRow.PathValue calls useUtils().system.cloud.detect.fetch() (DATA-03).
    // The local-model picker is file-mode (never cloud-warned), but the hook must exist.
    useUtils: () => ({
      system: { cloud: { detect: { fetch: async () => ({ is_cloud: false, engine: "", reason: "", dataless: false }) } } },
    }),
  },
}));

import { TranscriptionSection } from "../../web/src/components/settings/TranscriptionSection.js";

const tracker = {
  record: vi.fn(),
  statusFor: () => null,
  clear: vi.fn(),
  pending: {},
} as never;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    transcription: {
      realtime_enabled: true,
      final_engine: "mlx",
      language: "auto",
      local_model_path: "",
      mlx: { model: "", final_model: "", preprocess_audio: false, passthrough_max_sec: 0, passthrough_max_bytes: 0 },
      ...overrides,
    },
  };
}

beforeEach(() => {
  updateMutate.mockClear();
  configReturn = { data: baseConfig(), isPending: false };
  modelsReturn = { data: [], isPending: false };
});

function mount() {
  return render(
    <MemoryRouter>
      <TranscriptionSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("TranscriptionSection — mode radios (TRANS-01)", () => {
  it("Test 1 — renders local/cloud-fallback/cloud-priority; local is default; selecting cloud-fallback persists transcription.mode", async () => {
    mount();
    const localRadio = screen.getByRole("radio", { name: /local/i });
    const fallbackRadio = screen.getByRole("radio", { name: /cloud-fallback/i });
    const priorityRadio = screen.getByRole("radio", { name: /cloud-priority/i });
    expect(localRadio).toBeInTheDocument();
    expect(fallbackRadio).toBeInTheDocument();
    expect(priorityRadio).toBeInTheDocument();
    // unset mode → "local" is the default selection
    expect((localRadio as HTMLInputElement).checked).toBe(true);

    const user = userEvent.setup();
    await user.click(fallbackRadio);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.mode", value: "cloud-fallback" }),
    );
  });
});

describe("TranscriptionSection — cloud command, not key (TRANS-02)", () => {
  it("Test 2 — a command field is present; editing it persists transcription.cloud_command; no password/key/token/secret input", async () => {
    mount();
    // The cloud command uses the CommandEditor (array-of-strings, "+ Add arg"), the llm.command trust model.
    const addArgButtons = screen.getAllByRole("button", { name: /\+ add arg/i });
    expect(addArgButtons.length).toBeGreaterThanOrEqual(1);

    const user = userEvent.setup();
    // Adding an arg fires onChange → config.update for transcription.cloud_command
    await user.click(addArgButtons[addArgButtons.length - 1]!);
    await vi.waitFor(() =>
      expect(updateMutate.mock.calls.some((c) => c[0]?.key === "transcription.cloud_command")).toBe(true),
    );
  });

  it("Test 4 — no element labelled/placeholdered as api key / token / secret / password (T-04-KEY)", () => {
    const { container } = mount();
    // No password input anywhere.
    expect(container.querySelector('input[type="password"]')).toBeNull();
    // No visible label/placeholder/text matching a credential field.
    const offenders = Array.from(container.querySelectorAll("*")).filter((el) => {
      const text = el.textContent ?? "";
      const ph = el.getAttribute("placeholder") ?? "";
      const aria = el.getAttribute("aria-label") ?? "";
      return /api[\s_-]?key|token|secret|password/i.test(`${ph} ${aria}`) ||
        (el.children.length === 0 && /api[\s_-]?key|token|secret|password/i.test(text));
    });
    expect(offenders).toEqual([]);
  });
});

describe("TranscriptionSection — model selector from detected_models (SET-04)", () => {
  it("Test 3a — lists detected models by name and persists the chosen model path to local_model_path", async () => {
    modelsReturn = {
      data: [
        { name: "ggml-large-v3.bin", path: "/Users/me/.config/yulu/models/ggml-large-v3.bin", size: 100 },
        { name: "ggml-base.bin", path: "/Users/me/.config/yulu/models/ggml-base.bin", size: 50 },
      ],
      isPending: false,
    };
    mount();
    const select = screen.getByLabelText(/detected model/i) as HTMLSelectElement;
    expect(within(select).getByRole("option", { name: "ggml-large-v3.bin" })).toBeInTheDocument();
    expect(within(select).getByRole("option", { name: "ggml-base.bin" })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.selectOptions(select, "/Users/me/.config/yulu/models/ggml-base.bin");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "transcription.local_model_path",
        value: "/Users/me/.config/yulu/models/ggml-base.bin",
      }),
    );
  });

  it("Test 3b — empty detected_models shows a 'no models detected' state and does not crash", () => {
    modelsReturn = { data: [], isPending: false };
    expect(() => mount()).not.toThrow();
    expect(screen.getByText(/no models detected/i)).toBeInTheDocument();
    const select = screen.getByLabelText(/detected model/i) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });
});

describe("TranscriptionSection — existing rows preserved (D-07 extend, not replace)", () => {
  it("keeps the realtime/final-engine/language/local-model rows", () => {
    mount();
    expect(screen.getByText("Realtime transcription")).toBeInTheDocument();
    expect(screen.getByText("Final engine")).toBeInTheDocument();
    expect(screen.getByText("Language")).toBeInTheDocument();
    expect(screen.getByText("Local model path")).toBeInTheDocument();
  });
});
