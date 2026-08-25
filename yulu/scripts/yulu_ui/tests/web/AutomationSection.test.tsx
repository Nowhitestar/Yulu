// tests/web/AutomationSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["detector"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// All meeting_detection fields are restart-class (detector); useConfigField reads
// this to drive the recording-guard + undo. The 5 array fields are advanced.
const SCHEMA = [
  { path: "agent_pipeline.enabled", category: "automation", label: "Agent recording pipeline", type: "toggle", reload: { kind: "none" } },
  { path: "agent_pipeline.auto_process_recordings", category: "automation", label: "Automatic recording processing", type: "toggle", reload: { kind: "none" } },
  { path: "meeting_detection.enabled",             category: "automation", label: "Meeting detection",  type: "toggle", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.interval_sec",        category: "automation", label: "Poll interval (s)",  type: "number", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.stable_sec",          category: "automation", label: "Stable window (s)",  type: "number", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.prompt_cooldown_sec", category: "automation", label: "Prompt cooldown (s)", type: "number", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.window_keywords",        category: "automation", label: "窗口标题关键词",  type: "command", reload: { kind: "restart", daemons: ["detector"] }, advanced: true },
  { path: "meeting_detection.app_name_hints",         category: "automation", label: "应用名提示",        type: "command", reload: { kind: "restart", daemons: ["detector"] }, advanced: true },
  { path: "meeting_detection.target_app_names",       category: "automation", label: "目标应用名",      type: "command", reload: { kind: "restart", daemons: ["detector"] }, advanced: true },
  { path: "meeting_detection.dedicated_meeting_apps", category: "automation", label: "专用会议应用", type: "command", reload: { kind: "restart", daemons: ["detector"] }, advanced: true },
  { path: "meeting_detection.ignore_window_keywords", category: "automation", label: "忽略的窗口关键词", type: "command", reload: { kind: "restart", daemons: ["detector"] }, advanced: true },
];

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
    useUtils: () => ({
      config: { get: { setData: vi.fn(), invalidate: vi.fn() } },
    }),
  },
}));

import { AutomationSection } from "../../web/src/components/settings/AutomationSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return { agent_pipeline: { enabled: true, auto_process_recordings: true }, meeting_detection: {
    enabled: true, interval_sec: 10, stable_sec: 15, prompt_cooldown_sec: 1800,
    window_keywords: ["Zoom Meeting"], app_name_hints: ["Zoom"], target_app_names: ["Zoom"],
    dedicated_meeting_apps: ["Zoom"], ignore_window_keywords: ["Calendar"],
    ...overrides } };
}

beforeEach(() => {
  updateMutate.mockClear();
  recordingState = "idle";
  configReturn = { data: baseConfig(), isPending: false };
});

function mount() {
  return render(
    <MemoryRouter>
      <AutomationSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("AutomationSection — meeting detection (P2-3)", () => {
  it("renders all four meeting_detection fields with their current values", () => {
    mount();
    expect(screen.getByText("自动化")).toBeInTheDocument();
    expect(screen.getByText("录音处理管线")).toBeInTheDocument();
    expect(screen.getByText("自动处理录音")).toBeInTheDocument();
    expect(screen.getByText("会议检测")).toBeInTheDocument();
    expect(screen.getByText("轮询间隔（秒）")).toBeInTheDocument();
    expect(screen.getByText("稳定窗口（秒）")).toBeInTheDocument();
    expect(screen.getByText("提示冷却（秒）")).toBeInTheDocument();
  });

  it("resumes automatic recording processing through the production config seam", async () => {
    configReturn = {
      data: {
        ...baseConfig(),
        agent_pipeline: { enabled: true, auto_process_recordings: false },
      },
      isPending: false,
    };
    mount();
    const row = screen.getByText("自动处理录音").closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByRole("switch"));
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({
      key: "agent_pipeline.auto_process_recordings",
      value: true,
    }));
  });

  it("toggling Meeting detection commits meeting_detection.enabled", async () => {
    mount();
    const row = screen.getByText("会议检测").closest(".row")!;
    const sw = within(row as HTMLElement).getByRole("switch");
    const user = userEvent.setup();
    await user.click(sw);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "meeting_detection.enabled", value: false }),
    );
  });

  it("editing Poll interval commits meeting_detection.interval_sec as a number", async () => {
    mount();
    const row = screen.getByText("轮询间隔（秒）").closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText("10"));
    const input = within(row as HTMLElement).getByRole("spinbutton") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "30");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "meeting_detection.interval_sec", value: 30 }),
    );
  });

  it("falls back to defaults when meeting_detection is absent (no crash)", () => {
    configReturn = { data: {}, isPending: false };
    expect(() => mount()).not.toThrow();
    const row = screen.getByText("轮询间隔（秒）").closest(".row")!;
    expect(within(row as HTMLElement).getByText("10")).toBeInTheDocument();
  });

  it("recording-guard — while recording, the restart-class fields lock and edits are dropped", async () => {
    recordingState = "recording";
    mount();
    const row = screen.getByText("会议检测").closest(".row")!;
    // The interactive switch is replaced by a read-only display + a 录音中 note.
    expect(within(row as HTMLElement).queryByRole("switch")).toBeNull();
    expect(within(row as HTMLElement).getByText(/录音中/)).toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});

describe("AutomationSection — advanced match arrays disclosure (P3-2)", () => {
  it("hides the array editors behind a collapsed-by-default Advanced disclosure", () => {
    mount();
    const disclosure = document.querySelector("details.adv-disclosure") as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();
    // Collapsed by default.
    expect(disclosure.open).toBe(false);
    // The "change with care" note is on the summary.
    expect(screen.getByText(/谨慎更改/i)).toBeInTheDocument();
    // The array field labels are in the DOM (details keeps children mounted) but
    // the summary itself is the only thing visible until expanded.
    expect(screen.getByText("窗口标题关键词")).toBeInTheDocument();
  });

  it("expands to reveal the five array editors", async () => {
    mount();
    const disclosure = document.querySelector("details.adv-disclosure") as HTMLDetailsElement;
    const user = userEvent.setup();
    await user.click(screen.getByText(/高级/));
    expect(disclosure.open).toBe(true);
    for (const label of ["窗口标题关键词", "应用名提示", "目标应用名", "专用会议应用", "忽略的窗口关键词"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Each array renders as a CommandEditor (its "+ Add arg" affordance).
    expect(screen.getAllByRole("button", { name: /\+ 添加参数/i }).length).toBe(5);
  });

  it("editing an array commits the full new array for that key", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText(/高级/));
    // The window_keywords editor: find its add-arg button (first array block).
    const kwLabel = screen.getByText("窗口标题关键词");
    const block = kwLabel.closest(".array-field")!;
    const addArg = within(block as HTMLElement).getByRole("button", { name: /\+ 添加参数/i });
    await user.click(addArg);
    const inputs = within(block as HTMLElement).getAllByRole("textbox");
    await user.type(inputs[inputs.length - 1]!, "Google Meet");
    await user.tab();
    await vi.waitFor(() =>
      expect(updateMutate.mock.calls.some((c) => c[0]?.key === "meeting_detection.window_keywords")).toBe(true),
    );
    const call = updateMutate.mock.calls.find((c) => c[0]?.key === "meeting_detection.window_keywords")!;
    expect(call[0]!.value).toEqual(["Zoom Meeting", "Google Meet"]);
  });

  it("locks the array editors while recording (no + Add arg, shows a note)", () => {
    recordingState = "recording";
    mount();
    // The arrays are restart-class — while recording they render read-only.
    expect(screen.queryByRole("button", { name: /\+ 添加参数/i })).toBeNull();
    // At least one 录音中 note is shown for the locked arrays.
    expect(screen.getAllByText(/录音中/).length).toBeGreaterThan(0);
  });
});
