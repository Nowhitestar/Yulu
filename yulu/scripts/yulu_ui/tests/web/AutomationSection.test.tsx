// tests/web/AutomationSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["detector"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// All meeting_detection fields are restart-class (detector); useConfigField reads
// this to drive the recording-guard + undo.
const SCHEMA = [
  { path: "meeting_detection.enabled",             category: "automation", label: "Meeting detection",  type: "toggle", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.interval_sec",        category: "automation", label: "Poll interval (s)",  type: "number", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.stable_sec",          category: "automation", label: "Stable window (s)",  type: "number", reload: { kind: "restart", daemons: ["detector"] } },
  { path: "meeting_detection.prompt_cooldown_sec", category: "automation", label: "Prompt cooldown (s)", type: "number", reload: { kind: "restart", daemons: ["detector"] } },
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
  },
}));

import { AutomationSection } from "../../web/src/components/settings/AutomationSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function baseConfig(overrides: Record<string, unknown> = {}) {
  return { meeting_detection: { enabled: true, interval_sec: 10, stable_sec: 15, prompt_cooldown_sec: 1800, ...overrides } };
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
    expect(screen.getByText("Automation")).toBeInTheDocument();
    expect(screen.getByText("Meeting detection")).toBeInTheDocument();
    expect(screen.getByText("Poll interval (s)")).toBeInTheDocument();
    expect(screen.getByText("Stable window (s)")).toBeInTheDocument();
    expect(screen.getByText("Prompt cooldown (s)")).toBeInTheDocument();
  });

  it("toggling Meeting detection commits meeting_detection.enabled", async () => {
    mount();
    const row = screen.getByText("Meeting detection").closest(".row")!;
    const sw = within(row as HTMLElement).getByRole("switch");
    const user = userEvent.setup();
    await user.click(sw);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "meeting_detection.enabled", value: false }),
    );
  });

  it("editing Poll interval commits meeting_detection.interval_sec as a number", async () => {
    mount();
    const row = screen.getByText("Poll interval (s)").closest(".row")!;
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
    const row = screen.getByText("Poll interval (s)").closest(".row")!;
    expect(within(row as HTMLElement).getByText("10")).toBeInTheDocument();
  });

  it("recording-guard — while recording, the restart-class fields lock and edits are dropped", async () => {
    recordingState = "recording";
    mount();
    const row = screen.getByText("Meeting detection").closest(".row")!;
    // The interactive switch is replaced by a read-only display + a 录音中 note.
    expect(within(row as HTMLElement).queryByRole("switch")).toBeNull();
    expect(within(row as HTMLElement).getByText(/录音中/)).toBeInTheDocument();
    expect(updateMutate).not.toHaveBeenCalled();
  });
});
