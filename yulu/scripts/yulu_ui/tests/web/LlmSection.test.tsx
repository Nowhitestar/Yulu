// tests/web/LlmSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let capsReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

// Prompts subsection (P4a-2) holders.
let promptsReturn: { data: unknown; isPending: boolean; isError?: boolean } = { data: [], isPending: false };
const promptsUpdate = vi.fn(async (_vars: { id: string; isAutoRun?: boolean }) => ({ updated: 1 }));
const promptsListInvalidate = vi.fn();

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
    useUtils: () => ({ prompts: { list: { invalidate: promptsListInvalidate } } }),
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
      host_capabilities: { useQuery: () => capsReturn },
    },
    llm: { test: { useMutation: () => ({ mutateAsync: async () => ({ ok: true, stdout: "", stderr: "" }) }) } },
    prompts: {
      list: { useQuery: () => promptsReturn },
      update: { useMutation: (opts?: { onSuccess?: () => void }) => ({
        isPending: false,
        mutate: (vars: { id: string; isAutoRun?: boolean }) => { promptsUpdate(vars); opts?.onSuccess?.(); },
      }) },
    },
  },
}));

import { LlmSection } from "../../web/src/components/settings/LlmSection.js";
import { translate } from "../../web/src/i18n/LanguageProvider.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function configWith(command: string[] | null) {
  return { data: { llm: { enabled: true, command } }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
  promptsUpdate.mockClear();
  promptsListInvalidate.mockClear();
  recordingState = "idle";
  configReturn = configWith(null);
  capsReturn = {
    data: {
      schema_version: 1,
      capabilities: {
        llm_command: {
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/python3",
          detail: "llm.command=python3",
        },
        claude_cli: {
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/claude",
          detail: "claude 1.2.3",
        },
        codex_cli: {
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/codex",
          detail: "codex 1.2.3",
        },
      },
    },
    isPending: false,
  };
  promptsReturn = { data: [], isPending: false };
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
    const picker = screen.getByLabelText(translate("zh", "settings.llm.backend.aria")) as HTMLSelectElement;
    expect(picker.value).toBe("agent-queue");
    // No raw command editor while a preset is selected.
    expect(screen.queryByRole("button", { name: /\+ 添加参数/ })).toBeNull();
  });

  it("Agent-queue mode explains that no llm.command runtime is required", () => {
    configReturn = configWith(null);
    mount();
    expect(screen.getByText(translate("zh", "settings.llm.capability.label"))).toBeInTheDocument();
    expect(screen.getByText(translate("zh", "settings.llm.capability.agentQueue"))).toBeInTheDocument();
  });

  it("Codex preset shows the resolved llm.command capability", () => {
    configReturn = configWith(["python3", "codex_llm.py"]);
    mount();
    expect(screen.getByText("/opt/homebrew/bin/python3")).toBeInTheDocument();
    expect(screen.getByText("llm.command=python3")).toBeInTheDocument();
  });

  it("selecting Claude commits llm.command = ['claude','--print']", async () => {
    mount();
    const picker = screen.getByLabelText(translate("zh", "settings.llm.backend.aria"));
    const user = userEvent.setup();
    await user.selectOptions(picker, "claude");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: ["claude", "--print"] }),
    );
  });

  it("selecting Codex commits llm.command = ['python3','codex_llm.py']", async () => {
    mount();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(translate("zh", "settings.llm.backend.aria")), "codex");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: ["python3", "codex_llm.py"] }),
    );
  });

  it("selecting Agent-queue commits llm.command = null", async () => {
    configReturn = configWith(["claude", "--print"]);
    mount();
    const picker = screen.getByLabelText(translate("zh", "settings.llm.backend.aria")) as HTMLSelectElement;
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
    const picker = screen.getByLabelText(translate("zh", "settings.llm.backend.aria")) as HTMLSelectElement;
    expect(picker.value).toBe("custom");
    expect(screen.getAllByRole("button", { name: /\+ 添加参数/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("choosing Custom from agent-queue reveals the editor and seeds an empty array", async () => {
    configReturn = configWith(null);
    mount();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText(translate("zh", "settings.llm.backend.aria")), "custom");
    // Seeds [] so the editor has an array to grow.
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "llm.command", value: [] }),
    );
    expect(screen.getAllByRole("button", { name: /\+ 添加参数/ }).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps the Enabled toggle and the Test command button", () => {
    mount();
    expect(screen.getByText(translate("zh", "settings.llm.enabled.label"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: translate("zh", "settings.llm.test.button") })).toBeInTheDocument();
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

describe("LlmSection — auto-run templates subsection (P4a-2)", () => {
  it("lists only is_auto_run prompts with a category badge and a Manage link", () => {
    promptsReturn = {
      data: [
        { id: "p1", name: "Meeting summary", category: "summary", is_auto_run: 1 },
        { id: "p2", name: "Filler cleanup", category: "cleanup", is_auto_run: 1 },
        { id: "p3", name: "Action items (manual)", category: "summary", is_auto_run: 0 },
      ],
      isPending: false,
    };
    mount();
    expect(screen.getByText(translate("zh", "settings.llm.autorun.title"))).toBeInTheDocument();
    expect(screen.getByText("Meeting summary")).toBeInTheDocument();
    expect(screen.getByText("Filler cleanup")).toBeInTheDocument();
    // The non-auto-run prompt is not listed here.
    expect(screen.queryByText("Action items (manual)")).toBeNull();
    // Category badges render.
    const rows = screen.getAllByTestId("autorun-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(translate("zh", "category.summary"))).toBeInTheDocument();
    expect(within(rows[1]!).getByText(translate("zh", "category.cleanup"))).toBeInTheDocument();
    // Manage link points at the Prompts page.
    const link = screen.getByRole("link", { name: translate("zh", "settings.llm.autorun.manage") }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/knowledge/prompts");
  });

  it("toggling a template off flips is_auto_run via the prompts tRPC and invalidates the list", async () => {
    promptsReturn = {
      data: [{ id: "p1", name: "Meeting summary", category: "summary", is_auto_run: 1 }],
      isPending: false,
    };
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch", { name: translate("zh", "settings.llm.autorun.toggleAria", { name: "Meeting summary" }) }));
    expect(promptsUpdate).toHaveBeenCalledWith({ id: "p1", isAutoRun: false });
    // The list is refreshed so the row reflects the new state.
    expect(promptsListInvalidate).toHaveBeenCalled();
  });

  it("shows an empty state when no template is auto-run", () => {
    promptsReturn = {
      data: [{ id: "p3", name: "Action items", category: "summary", is_auto_run: 0 }],
      isPending: false,
    };
    mount();
    expect(screen.getByText(translate("zh", "settings.llm.autorun.empty"))).toBeInTheDocument();
    expect(screen.queryByTestId("autorun-row")).toBeNull();
  });

  it("shows an error state instead of loading forever when prompt templates fail to load", () => {
    promptsReturn = { data: undefined, isPending: false, isError: true };
    mount();
    expect(screen.getByText(translate("zh", "settings.llm.autorun.error"))).toBeInTheDocument();
    expect(screen.queryByText(translate("zh", "common.loading"))).toBeNull();
  });

  it("does NOT rebuild prompt CRUD (no create/edit/delete controls here)", () => {
    promptsReturn = {
      data: [{ id: "p1", name: "Meeting summary", category: "summary", is_auto_run: 1 }],
      isPending: false,
    };
    mount();
    expect(screen.queryByRole("button", { name: /new prompt|add prompt|delete|save/i })).toBeNull();
    expect(screen.queryByRole("textbox", { name: /prompt (name|content)/i })).toBeNull();
  });
});
