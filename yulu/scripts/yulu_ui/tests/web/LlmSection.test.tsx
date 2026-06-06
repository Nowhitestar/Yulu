// tests/web/LlmSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// llm.command is reload:none in the registry (agentqueue re-reads each tick).
const SCHEMA = [
  { path: "llm.enabled", category: "llm", label: "启用 LLM", type: "toggle", reload: { kind: "none" } },
  { path: "llm.command", category: "llm", label: "LLM 后端", type: "preset", reload: { kind: "none" } },
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
    llm: { test: { useMutation: () => ({ mutateAsync: async () => ({ ok: true, stdout: "", stderr: "" }) }) } },
  },
}));

import { LlmSection } from "../../web/src/components/settings/LlmSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function configWith(command: string[] | null) {
  return { data: { llm: { enabled: true, command } }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
  recordingState = "idle";
  configReturn = configWith(null);
});

function mount() {
  return render(
    <MemoryRouter>
      <LlmSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("LlmSection — backend preset picker (P2-2)", () => {
  it("null command selects Agent-queue and hides the CommandEditor", () => {
    configReturn = configWith(null);
    mount();
    const picker = screen.getByLabelText("LLM backend") as HTMLSelectElement;
    expect(picker.value).toBe("agent-queue");
    // No raw command editor while a preset is selected.
    expect(screen.queryByRole("button", { name: /\+ add arg/i })).toBeNull();
  });

  it("selecting Claude commits llm.command = ['claude','--print']", async () => {
    mount();
    const picker = screen.getByLabelText("LLM backend");
    const user = userEvent.setup();
    await user.selectOptions(picker, "claude");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: ["claude", "--print"] }),
    );
  });

  it("selecting Codex commits llm.command = ['python3','codex_llm.py']", async () => {
    mount();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("LLM backend"), "codex");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: ["python3", "codex_llm.py"] }),
    );
  });

  it("selecting Agent-queue commits llm.command = null", async () => {
    configReturn = configWith(["claude", "--print"]);
    mount();
    const picker = screen.getByLabelText("LLM backend") as HTMLSelectElement;
    expect(picker.value).toBe("claude");
    const user = userEvent.setup();
    await user.selectOptions(picker, "agent-queue");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: null }),
    );
  });

  it("a value matching no preset (e.g. ['my-llm']) selects Custom and shows the CommandEditor", () => {
    configReturn = configWith(["my-llm", "--flag"]);
    mount();
    const picker = screen.getByLabelText("LLM backend") as HTMLSelectElement;
    expect(picker.value).toBe("custom");
    expect(screen.getAllByRole("button", { name: /\+ add arg/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("choosing Custom from agent-queue reveals the editor and seeds an empty array", async () => {
    configReturn = configWith(null);
    mount();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("LLM backend"), "custom");
    // Seeds [] so the editor has an array to grow.
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: [] }),
    );
    expect(screen.getAllByRole("button", { name: /\+ add arg/i }).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the Enabled toggle and the Test command button", () => {
    mount();
    expect(screen.getByText("Enabled")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test command" })).toBeInTheDocument();
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
