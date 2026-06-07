// tests/web/AdvancedSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// transcription.cloud_command is restart-class; useConfigField looks it up here.
const SCHEMA = [
  { path: "transcription.cloud_command", category: "advanced", label: "云转写命令", type: "command", reload: { kind: "restart", daemons: ["sttdaemon"] } },
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
  },
}));

import { AdvancedSection } from "../../web/src/components/settings/AdvancedSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

beforeEach(() => {
  updateMutate.mockClear();
  recordingState = "idle";
  configReturn = { data: { transcription: { cloud_command: [] } }, isPending: false };
});

function mount() {
  return render(
    <MemoryRouter>
      <AdvancedSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("AdvancedSection — cloud transcription command (TRANS-02, re-homed)", () => {
  it("renders the cloud transcription command as a CommandEditor (array, not a key)", () => {
    mount();
    // Exact match for the label (the help text also contains the phrase).
    expect(screen.getByText("云转写命令")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /\+ 添加参数/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("wraps the knobs in a collapsed-by-default Advanced disclosure (P3-2)", () => {
    mount();
    const disclosure = document.querySelector("details.adv-disclosure") as HTMLDetailsElement;
    expect(disclosure).not.toBeNull();
    expect(disclosure.open).toBe(false);
    expect(screen.getByText(/谨慎更改/i)).toBeInTheDocument();
  });

  it("editing the command persists transcription.cloud_command", async () => {
    mount();
    const addArg = screen.getAllByRole("button", { name: /\+ 添加参数/i });
    const user = userEvent.setup();
    await user.click(addArg[addArg.length - 1]!);
    await vi.waitFor(() =>
      expect(updateMutate.mock.calls.some((c) => c[0]?.key === "transcription.cloud_command")).toBe(true),
    );
  });

  it("locks the restart-class command while recording (no CommandEditor, shows a note)", () => {
    recordingState = "recording";
    render(
      <MemoryRouter>
        <AdvancedSection tracker={tracker} />
      </MemoryRouter>,
    );
    // The editable CommandEditor ("+ add arg") is gone; a 录音中 note is shown.
    expect(screen.queryByRole("button", { name: /\+ 添加参数/i })).toBeNull();
    expect(screen.getByText(/录音中/)).toBeInTheDocument();
  });

  it("exposes no api key / token / secret / password field (T-04-KEY)", () => {
    const { container } = mount();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    const offenders = Array.from(container.querySelectorAll("*")).filter((el) => {
      const ph = el.getAttribute("placeholder") ?? "";
      const aria = el.getAttribute("aria-label") ?? "";
      return /api[\s_-]?key|token|secret|password/i.test(`${ph} ${aria}`);
    });
    expect(offenders).toEqual([]);
  });
});
