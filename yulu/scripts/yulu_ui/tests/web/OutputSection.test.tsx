// tests/web/OutputSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";
let envPresentReturn: { data: { present: boolean } } = { data: { present: false } };
const envPresentSpy = vi.fn();

// output.* fields are reload:none in the registry (agentqueue re-reads each tick).
const SCHEMA = [
  { path: "output.channel",            category: "integrations", label: "Output channel",         type: "select",   reload: { kind: "none" } },
  { path: "output.zulip.stream",       category: "integrations", label: "Zulip stream",           type: "text",     reload: { kind: "none" } },
  { path: "output.zulip.topic",        category: "integrations", label: "Zulip topic",            type: "text",     reload: { kind: "none" } },
  { path: "output.notion.database_id", category: "integrations", label: "Notion database",        type: "text",     reload: { kind: "none" } },
  { path: "output.notion.api_key_env", category: "integrations", label: "Notion API key env var", type: "env-name", reload: { kind: "none" } },
  { path: "output.telegram.chat_id",   category: "integrations", label: "Telegram chat ID",       type: "text",     reload: { kind: "none" } },
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
      envPresent: { useQuery: (input: { name: string }, opts?: { enabled?: boolean }) => { envPresentSpy(input, opts); return envPresentReturn; } },
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

import { OutputSection } from "../../web/src/components/settings/OutputSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function configWith(output: Record<string, unknown>) {
  return { data: { output }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
  envPresentSpy.mockClear();
  recordingState = "idle";
  envPresentReturn = { data: { present: false } };
  configReturn = configWith({ channel: "file" });
});

function mount() {
  return render(
    <MemoryRouter>
      <OutputSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("OutputSection — channel selector (P2-4)", () => {
  it("renders the Output section with a channel selector defaulting to file", () => {
    mount();
    expect(screen.getByText("Output")).toBeInTheDocument();
    const row = screen.getByText("Output channel").closest(".row")!;
    expect(within(row as HTMLElement).getByText("file")).toBeInTheDocument();
  });

  it("selecting zulip commits output.channel and reveals zulip stream/topic", async () => {
    mount();
    const row = screen.getByText("Output channel").closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText("file"));
    await user.selectOptions(within(row as HTMLElement).getByRole("combobox"), "zulip");
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "output.channel", value: "zulip" }),
    );
  });

  it("zulip channel shows stream + topic text rows and commits them", async () => {
    configReturn = configWith({ channel: "zulip", zulip: { stream: "meetings", topic: "纪要" } });
    mount();
    expect(screen.getByText("Zulip stream")).toBeInTheDocument();
    expect(screen.getByText("Zulip topic")).toBeInTheDocument();
    const row = screen.getByText("Zulip stream").closest(".row")!;
    const user = userEvent.setup();
    await user.click(within(row as HTMLElement).getByText("meetings"));
    const input = within(row as HTMLElement).getByRole("textbox") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "standup");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "output.zulip.stream", value: "standup" }),
    );
  });

  it("telegram channel shows the chat ID row", () => {
    configReturn = configWith({ channel: "telegram", telegram: { chat_id: "123" } });
    mount();
    expect(screen.getByText("Telegram chat ID")).toBeInTheDocument();
  });
});

describe("OutputSection — notion api_key_env is NAME-only, never a secret (P2-4)", () => {
  beforeEach(() => {
    configReturn = configWith({ channel: "notion", notion: { database_id: "db-1", api_key_env: "NOTION_API_KEY" } });
  });

  it("renders the env-var NAME in a text input (not a password field) and a database row", () => {
    mount();
    expect(screen.getByText("Notion database")).toBeInTheDocument();
    expect(screen.getByText("Notion API key env var")).toBeInTheDocument();
    const input = screen.getByLabelText("Environment variable name") as HTMLInputElement;
    expect(input.type).toBe("text");
    expect(input.value).toBe("NOTION_API_KEY");
  });

  it("never renders a password input or an api-key/secret/token VALUE field (T-04-KEY)", () => {
    const { container } = mount();
    expect(container.querySelector('input[type="password"]')).toBeNull();
    // No input is labelled/placeholdered as a credential VALUE. The env-var name
    // input is labelled "Environment variable name", which is allowed.
    const inputs = Array.from(container.querySelectorAll("input"));
    for (const el of inputs) {
      const ph = el.getAttribute("placeholder") ?? "";
      const aria = el.getAttribute("aria-label") ?? "";
      expect(/api[\s_-]?key\b|secret|password|\btoken\b/i.test(`${ph} ${aria}`)).toBe(false);
    }
  });

  it("shows a read-only 'set' presence hint when the env var is present (value never shown)", () => {
    envPresentReturn = { data: { present: true } };
    mount();
    expect(screen.getByTestId("env-presence")).toHaveTextContent("set");
    // Only the boolean-derived label — no secret value anywhere in the DOM.
    expect(screen.queryByText(/super-secret|sk-|secret-value/i)).toBeNull();
  });

  it("shows 'not set' when the env var is absent", () => {
    envPresentReturn = { data: { present: false } };
    mount();
    expect(screen.getByTestId("env-presence")).toHaveTextContent("not set");
  });

  it("commits the env-var NAME (trimmed) on edit", async () => {
    mount();
    const input = screen.getByLabelText("Environment variable name") as HTMLInputElement;
    const user = userEvent.setup();
    await user.clear(input);
    await user.type(input, "MY_NOTION_KEY");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "output.notion.api_key_env", value: "MY_NOTION_KEY" }),
    );
  });

  it("does not query env presence when the name is empty", () => {
    configReturn = configWith({ channel: "notion", notion: { database_id: "", api_key_env: "" } });
    mount();
    // The presence query is mounted but disabled (enabled:false) for an empty name.
    const lastCall = envPresentSpy.mock.calls.at(-1);
    expect(lastCall?.[1]).toEqual(expect.objectContaining({ enabled: false }));
    expect(screen.queryByTestId("env-presence")).toBeNull();
  });
});

describe("OutputSection — file channel needs no extra setup", () => {
  it("file channel shows no zulip/notion/telegram fields", () => {
    configReturn = configWith({ channel: "file" });
    mount();
    expect(screen.queryByText("Zulip stream")).toBeNull();
    expect(screen.queryByText("Notion database")).toBeNull();
    expect(screen.queryByText("Telegram chat ID")).toBeNull();
  });
});
