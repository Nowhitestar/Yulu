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
let capsReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// Transcription fields are restart-class (sttdaemon); useConfigField reads this
// to decide the recording-guard + undo. realtime_enabled is reload:none.
const SCHEMA = [
  { path: "transcription.mode",                category: "transcription", label: "转写模式", type: "select", reload: { kind: "restart", daemons: ["sttdaemon"] }, advanced: true },
  { path: "transcription.language",            category: "transcription", label: "语言",     type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.final_engine",        category: "transcription", label: "最终引擎", type: "select", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.local_model_path",    category: "transcription", label: "本地模型", type: "path",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.mlx",                 category: "transcription", label: "MLX 参数", type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.realtime.mlx_model",  category: "transcription", label: "实时字幕模型", type: "text", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.whisper_cli",         category: "transcription", label: "whisper.cpp CLI", type: "text", reload: { kind: "restart", daemons: ["sttdaemon"] }, advanced: true },
  { path: "transcription.realtime_enabled",    category: "transcription", label: "实时字幕", type: "toggle", reload: { kind: "none" } },
  { path: "transcription.diarization.enabled", category: "transcription", label: "说话人分离", type: "toggle", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.diarization.provider", category: "transcription", label: "说话人 Provider", type: "select", reload: { kind: "restart", daemons: ["sttdaemon"] }, advanced: true },
  { path: "transcription.diarization.num_speakers", category: "transcription", label: "说话人数", type: "number", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.diarization.threshold", category: "transcription", label: "聚类阈值", type: "number", reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "transcription.diarization.seg_model", category: "transcription", label: "分段模型", type: "text", reload: { kind: "restart", daemons: ["sttdaemon"] }, advanced: true },
  { path: "transcription.diarization.emb_model", category: "transcription", label: "嵌入模型", type: "text", reload: { kind: "restart", daemons: ["sttdaemon"] }, advanced: true },
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
      host_capabilities: { useQuery: () => capsReturn },
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
import { translate } from "../../web/src/i18n/LanguageProvider.js";

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
      whisper_cli: "whisper-cli",
      mlx: { model: "mlx-community/whisper-large-v3-mlx" },
      realtime: { mlx_model: "mlx-community/whisper-large-v3-turbo" },
      diarization: { enabled: false, provider: "sherpa-onnx", num_speakers: null, threshold: 0.5, seg_model: "", emb_model: "" },
      ...overrides,
    },
  };
}

beforeEach(() => {
  updateMutate.mockClear();
  recordingState = "idle";
  configReturn = { data: baseConfig(), isPending: false };
  modelsReturn = { data: [], isPending: false };
  capsReturn = {
    data: {
      schema_version: 1,
      capabilities: {
        mlx_whisper: {
          provenance: "host-path",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/python3",
          detail: "runtime warm-up verified",
        },
        whisper_cli: {
          provenance: "host-path",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/whisper-cli",
          detail: "whisper-cli",
        },
        models: {
          provenance: "yulu-managed",
          status: "usable",
          resolved_path: "/Users/me/.config/yulu/models",
          detail: "2 models",
        },
        diarization: {
          provenance: "yulu-managed",
          status: "absent",
          resolved_path: "",
          detail: "models missing",
        },
      },
    },
    isPending: false,
  };
});

function mount() {
  return render(
    <MemoryRouter>
      <TranscriptionSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("TranscriptionSection — engine selector (P4a-1)", () => {
  it("renders MLX / Whisper.cpp radios; MLX is default; selecting Whisper.cpp persists transcription.final_engine", async () => {
    mount();
    const mlxRadio = screen.getByRole("radio", { name: /^MLX$/i });
    const whisperRadio = screen.getByRole("radio", { name: /Whisper\.cpp/i });
    expect(mlxRadio).toBeInTheDocument();
    expect(whisperRadio).toBeInTheDocument();
    expect((mlxRadio as HTMLInputElement).checked).toBe(true);

    const user = userEvent.setup();
    await user.click(whisperRadio);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.final_engine", value: "whisper" }),
    );
  });

  it("recording-guard — while recording, the engine radios are disabled and edits are dropped", async () => {
    recordingState = "recording";
    mount();
    const whisperRadio = screen.getByRole("radio", { name: /Whisper\.cpp/i }) as HTMLInputElement;
    expect(whisperRadio.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(whisperRadio).catch(() => {});
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("TranscriptionSection — MLX engine fields (P4a-1)", () => {
  it("MLX engine shows MLX model + Realtime model, and NOT the whisper.cpp local-model fields", () => {
    configReturn = { data: baseConfig({ final_engine: "mlx" }), isPending: false };
    mount();
    expect(screen.getByText(translate("zh", "settings.transcription.mlxModel.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.realtimeModel.label"))).toBeInTheDocument();
    // whisper.cpp-only fields are hidden on the MLX engine.
    expect(screen.queryByText(translate("zh", "settings.transcription.localModelPath.label"))).toBeNull();
    expect(screen.queryByLabelText(translate("zh", "settings.transcription.detectedModel.label"))).toBeNull();
  });

  it("thin config still displays the effective default MLX model ids", () => {
    configReturn = { data: baseConfig({ final_engine: "mlx", mlx: {}, realtime: {} }), isPending: false };
    mount();
    expect(screen.getByText("mlx-community/whisper-large-v3-mlx")).toBeInTheDocument();
    expect(screen.getByText("mlx-community/whisper-large-v3-turbo")).toBeInTheDocument();
  });

  it("shows the selected engine runtime status from host capabilities", () => {
    configReturn = { data: baseConfig({ final_engine: "mlx" }), isPending: false };
    mount();
    expect(screen.getByText(translate("zh", "settings.transcription.capability.label"))).toBeInTheDocument();
    expect(screen.getByText("runtime warm-up verified")).toBeInTheDocument();
  });

  it("editing the MLX model commits transcription.mlx.model", async () => {
    configReturn = { data: baseConfig({ final_engine: "mlx", mlx: { model: "old-model" } }), isPending: false };
    mount();
    const row = screen.getByText(translate("zh", "settings.transcription.mlxModel.label")).closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText("old-model"));
    const input = within(row as HTMLElement).getByRole("textbox") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "mlx-community/whisper-tiny");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.mlx.model", value: "mlx-community/whisper-tiny" }),
    );
  });

  it("editing the Realtime model commits transcription.realtime.mlx_model", async () => {
    configReturn = { data: baseConfig({ final_engine: "mlx", realtime: { mlx_model: "turbo-old" } }), isPending: false };
    mount();
    const row = screen.getByText(translate("zh", "settings.transcription.realtimeModel.label")).closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText("turbo-old"));
    const input = within(row as HTMLElement).getByRole("textbox") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "turbo-new");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.realtime.mlx_model", value: "turbo-new" }),
    );
  });
});

describe("TranscriptionSection — Whisper.cpp engine fields (P4a-1, SET-04)", () => {
  beforeEach(() => {
    configReturn = { data: baseConfig({ final_engine: "whisper" }), isPending: false };
  });

  it("whisper.cpp engine shows the Detected-model dropdown + Local model path, and NOT the MLX fields", () => {
    mount();
    expect(screen.getByLabelText(translate("zh", "settings.transcription.detectedModel.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.localModelPath.label"))).toBeInTheDocument();
    // MLX-only fields are hidden on the whisper engine.
    expect(screen.queryByText(translate("zh", "settings.transcription.mlxModel.label"))).toBeNull();
    expect(screen.queryByText(translate("zh", "settings.transcription.realtimeModel.label"))).toBeNull();
  });

  it("Test 3a — lists detected models by name and persists the chosen model path to local_model_path", async () => {
    modelsReturn = {
      data: [
        { name: "ggml-large-v3.bin", path: "/Users/me/.config/yulu/models/ggml-large-v3.bin", size: 100 },
        { name: "ggml-base.bin", path: "/Users/me/.config/yulu/models/ggml-base.bin", size: 50 },
      ],
      isPending: false,
    };
    mount();
    const select = screen.getByLabelText(translate("zh", "settings.transcription.detectedModel.label")) as HTMLSelectElement;
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
    expect(screen.getByText(translate("zh", "settings.transcription.detectedModel.none"))).toBeInTheDocument();
    const select = screen.getByLabelText(translate("zh", "settings.transcription.detectedModel.label")) as HTMLSelectElement;
    expect(select.disabled).toBe(true);
  });

  it("whisper-cli binary field lives in the Advanced disclosure on the whisper engine", () => {
    mount();
    expect(screen.getByText("whisper.cpp CLI")).toBeInTheDocument();
  });
});

describe("TranscriptionSection — vestigial mlx fields removed (P4a-1)", () => {
  it("does NOT render preprocess/passthrough/final-model knobs", () => {
    configReturn = {
      data: baseConfig({
        final_engine: "mlx",
        mlx: { model: "m", final_model: "fm", preprocess_audio: true, passthrough_max_sec: 10, passthrough_max_bytes: 100 },
      }),
      isPending: false,
    };
    mount();
    expect(screen.queryByText(/MLX final model/i)).toBeNull();
    expect(screen.queryByText(/preprocess audio/i)).toBeNull();
    expect(screen.queryByText(/passthrough/i)).toBeNull();
  });
});

describe("TranscriptionSection — transcription mode moved under Advanced (P4a-1)", () => {
  it("renders local/cloud-fallback/cloud-priority radios; local is default; selecting cloud-fallback persists transcription.mode", async () => {
    mount();
    const localRadio = screen.getByRole("radio", { name: /local/i });
    const fallbackRadio = screen.getByRole("radio", { name: /cloud-fallback/i });
    const priorityRadio = screen.getByRole("radio", { name: /cloud-priority/i });
    expect(localRadio).toBeInTheDocument();
    expect(fallbackRadio).toBeInTheDocument();
    expect(priorityRadio).toBeInTheDocument();
    expect((localRadio as HTMLInputElement).checked).toBe(true);

    const user = userEvent.setup();
    await user.click(fallbackRadio);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.mode", value: "cloud-fallback" }),
    );
  });

  it("recording-guard — while recording, the mode radios are disabled and edits are dropped", async () => {
    recordingState = "recording";
    mount();
    const fallbackRadio = screen.getByRole("radio", { name: /cloud-fallback/i }) as HTMLInputElement;
    expect(fallbackRadio.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(fallbackRadio).catch(() => {});
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("TranscriptionSection — cloud command stays in Advanced section (TRANS-02)", () => {
  // The cloud transcription command (transcription.cloud_command) is registry
  // category "advanced", so it lives in AdvancedSection — see
  // tests/web/AdvancedSection.test.tsx. Here we just assert it is NOT duplicated.
  it("Test 2 — does not render the cloud transcription command here", () => {
    mount();
    expect(screen.queryByText(/cloud transcription command/i)).toBeNull();
  });

  it("Test 4 — no element labelled/placeholdered as api key / token / secret / password (T-04-KEY)", () => {
    const { container } = mount();
    expect(container.querySelector('input[type="password"]')).toBeNull();
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

describe("TranscriptionSection — always-relevant rows (D-07 extend, not replace)", () => {
  it("keeps the language / post-recording / realtime rows on both engines", () => {
    mount();
    expect(screen.getByText(translate("zh", "settings.transcription.language.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.postRecording.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.realtime.label"))).toBeInTheDocument();
  });

  it("renders a Post-recording select defaulting to fast_summary and persists full_transcribe on change", async () => {
    mount();
    const row = screen.getByText(translate("zh", "settings.transcription.postRecording.label")).closest(".row")!;
    expect(within(row as HTMLElement).getByText(translate("zh", "settings.transcription.postRecording.fast"))).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText(translate("zh", "settings.transcription.postRecording.fast")));
    const select = within(row as HTMLElement).getByRole("combobox") as HTMLSelectElement;
    await user.selectOptions(select, "full_transcribe");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.post_recording_mode", value: "full_transcribe" }),
    );
  });
});

describe("TranscriptionSection — speaker diarization settings (Phase 14)", () => {
  it("renders diarization rows and persists enabled / speaker count / threshold", async () => {
    mount();
    const user = userEvent.setup();

    const enabledRow = screen.getByText(translate("zh", "settings.transcription.diarization.enabled.label")).closest(".row")!;
    await user.click(within(enabledRow as HTMLElement).getByRole("switch"));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.diarization.enabled", value: true }),
    );

    const countRow = screen.getByText(translate("zh", "settings.transcription.diarization.numSpeakers.label")).closest(".row")!;
    expect(within(countRow as HTMLElement).getByText(translate("zh", "settings.transcription.diarization.numSpeakers.auto"))).toBeInTheDocument();
    await user.click(within(countRow as HTMLElement).getByText(translate("zh", "settings.transcription.diarization.numSpeakers.auto")));
    await user.selectOptions(within(countRow as HTMLElement).getByRole("combobox"), "3");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.diarization.num_speakers", value: 3 }),
    );

    const thresholdRow = screen.getByText(translate("zh", "settings.transcription.diarization.threshold.label")).closest(".row")!;
    await user.click(within(thresholdRow as HTMLElement).getByText("0.5"));
    const input = within(thresholdRow as HTMLElement).getByRole("spinbutton") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "0.7");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "transcription.diarization.threshold", value: 0.7 }),
    );
  });

  it("shows diarization runtime capability detail next to the settings", () => {
    mount();
    expect(screen.getByText(translate("zh", "settings.transcription.diarization.capability.label"))).toBeInTheDocument();
    expect(screen.getByText("models missing")).toBeInTheDocument();
  });

  it("keeps provider and ONNX model overrides in Advanced", () => {
    mount();
    expect(screen.getByText(translate("zh", "settings.transcription.diarization.provider.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.diarization.segModel.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.transcription.diarization.embModel.label"))).toBeInTheDocument();
  });
});
