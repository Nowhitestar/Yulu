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
let recordingState: string = "idle";

// Transcription fields are restart-class (sttdaemon); useConfigField reads this
// to decide the recording-guard + undo. realtime_enabled is reload:none.
const SCHEMA = [
  { path: "transcription.mode",             category: "transcription", label: "转写模式", type: "select", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.language",         category: "transcription", label: "语言",     type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.final_engine",     category: "transcription", label: "最终引擎", type: "select", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.local_model_path", category: "transcription", label: "本地模型", type: "path",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.mlx",              category: "transcription", label: "MLX 参数", type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.realtime_enabled", category: "transcription", label: "实时字幕", type: "toggle", reload: { kind: "none" } },
  { path: "transcription.post_recording_mode", category: "transcription", label: "Post-recording", type: "select", reload: { kind: "none" } },
];

// useConfigField pulls in useIsRecording (→ ws.js). Stub ws so it's a no-op.
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => configReturn },
      schema: { useQuery: () => ({ data: SCHEMA, isPending: false }) },
      update: { useMutation: (opts?: { onSuccess?: (r: unknown, v: unknown) => void }) => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => {
          const res = await updateMutate(vars);
          opts?.onSuccess?.(res, vars);
          return res;
        },
      }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
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
  recordingState = "idle";
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

  it("recording-guard — while recording, the restart-class mode radios are disabled and edits are dropped", async () => {
    recordingState = "recording";
    mount();
    const fallbackRadio = screen.getByRole("radio", { name: /cloud-fallback/i }) as HTMLInputElement;
    expect(fallbackRadio.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(fallbackRadio).catch(() => {});
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("TranscriptionSection — cloud command moved to Advanced (TRANS-02)", () => {
  // The cloud transcription command (transcription.cloud_command) is registry
  // category "advanced", so it now lives in AdvancedSection — see
  // tests/web/AdvancedSection.test.tsx for its behaviour. Here we just assert it
  // is NOT duplicated in the transcription section.
  it("Test 2 — does not render the cloud transcription command here", () => {
    mount();
    expect(screen.queryByText(/cloud transcription command/i)).toBeNull();
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

describe("TranscriptionSection — post-recording mode (P2-1)", () => {
  it("renders a Post-recording select defaulting to fast_summary and persists full_transcribe on change", async () => {
    mount();
    const labelEl = screen.getByText("Post-recording");
    const row = labelEl.closest(".row")!;
    // Defaults to fast_summary (unset in baseConfig), shown as the read-at-rest display.
    expect(within(row as HTMLElement).getByText("fast_summary")).toBeInTheDocument();

    const user = userEvent.setup();
    // Reveal the <select> (InlineEditRow shows a display span until clicked).
    await user.click(within(row as HTMLElement).getByText("fast_summary"));
    const select = within(row as HTMLElement).getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "full_transcribe");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.post_recording_mode", value: "full_transcribe" }),
    );
  });

  it("reflects an explicit full_transcribe value from config", () => {
    configReturn = { data: baseConfig({ post_recording_mode: "full_transcribe" }), isPending: false };
    mount();
    const row = screen.getByText("Post-recording").closest(".row")!;
    expect(within(row as HTMLElement).getByText("full_transcribe")).toBeInTheDocument();
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
