// tests/web/IntegrationsSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["calendar", "scheduler"], daemonsNeedingSighup: [] }));
const notionMcpStartAuthMutate = vi.fn(async () => ({ authUrl: "https://auth.notion.test/authorize", state: "state", expiresAt: 1, redirectUri: "http://127.0.0.1/callback" }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";
let testResult: { ok: boolean; stdout: string; stderr: string } = { ok: true, stdout: "[]", stderr: "" };
let calendarListReturn: {
  data: { ok: boolean; calendars: Array<{ id: string; summary: string; primary: boolean }>; stderr?: string };
  isPending: boolean;
} = { data: { ok: true, calendars: [] }, isPending: false };
let accountListReturn: {
  data: { ok: boolean; accounts: Array<{ email: string; services: string[] }>; stderr?: string };
  isPending: boolean;
} = { data: { ok: true, accounts: [] }, isPending: false };
let connectorStatusReturn: {
  data: {
    schema_version: number;
    connectors: Record<string, {
      connector_id: string;
      display_name: string;
      provenance: string;
      status: string;
      resolved_path: string;
      detail: string;
      actions: string[];
      config_prefix: string;
    }>;
  };
  isPending: boolean;
} = { data: { schema_version: 1, connectors: {} }, isPending: false };
let outputDestinationReturns: Record<string, {
  data: {
    ok: boolean;
    channel: string;
    identity: { label: string; detail?: string } | null;
    destinations: Array<{ id: string; type: string; label: string; detail?: string }>;
    error?: string;
  };
  isPending: boolean;
}> = {};

// calendars is restart-class (calendar + scheduler) — drives the recording-guard.
const SCHEMA = [
  { path: "calendars", category: "integrations", label: "日历", type: "text", reload: { kind: "restart", daemons: ["calendar", "scheduler"] } },
  { path: "connectors.notion.send_summary", category: "integrations", label: "Send summaries to Notion", type: "toggle", reload: { kind: "none" } },
  { path: "connectors.zulip.send_summary", category: "integrations", label: "Send summaries to Zulip", type: "toggle", reload: { kind: "none" } },
  { path: "output.notion.destination_id", category: "integrations", label: "Notion destination", type: "text", reload: { kind: "none" } },
  { path: "output.notion.destination_type", category: "integrations", label: "Notion destination type", type: "text", reload: { kind: "none" } },
  { path: "output.notion.destination_label", category: "integrations", label: "Notion destination label", type: "text", reload: { kind: "none" } },
  { path: "output.zulip.stream", category: "integrations", label: "Zulip stream", type: "text", reload: { kind: "none" } },
  { path: "output.zulip.stream_id", category: "integrations", label: "Zulip stream id", type: "text", reload: { kind: "none" } },
  { path: "output.zulip.topic", category: "integrations", label: "Zulip topic", type: "text", reload: { kind: "none" } },
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
      update: { useMutation: () => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => updateMutate(vars),
      }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    integrations: {
      connectorStatus: { useQuery: () => connectorStatusReturn },
      notionMcpStartAuth: { useMutation: () => ({ mutateAsync: notionMcpStartAuthMutate, isPending: false }) },
      test: { useMutation: () => ({ mutateAsync: async () => testResult }) },
      accountList: { useQuery: () => accountListReturn },
      calendarList: { useQuery: () => calendarListReturn },
      outputDestinations: {
        useQuery: (input: { channel: string }) =>
          outputDestinationReturns[input.channel] ?? {
            data: { ok: false, channel: input.channel, identity: null, destinations: [], error: "not connected" },
            isPending: false,
          },
      },
    },
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: "" }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    useUtils: () => ({
      system: { cloud: { detect: { fetch: async () => ({ is_cloud: false, engine: "", reason: "", dataless: false }) } } },
    }),
  },
}));

import { IntegrationsSection } from "../../web/src/components/settings/IntegrationsSection.js";
import { translate } from "../../web/src/i18n/LanguageProvider.js";

// A tracker whose record spy lets us assert whether a commit tripped the restart
// banner (record called) or was suppressed (record NOT called) — P4a-4.
const record = vi.fn();
const tracker = { record, statusFor: () => null, clearAll: vi.fn(), daemons: new Map() } as never;

function configWith(
  calendars: unknown[],
  connectors: Record<string, unknown> = {},
  output: Record<string, unknown> = {},
) {
  return { data: { calendars, connectors, output }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
  notionMcpStartAuthMutate.mockClear();
  record.mockClear();
  recordingState = "idle";
  testResult = { ok: true, stdout: "[]", stderr: "" };
  calendarListReturn = {
    data: {
      ok: true,
      calendars: [
        { id: "primary", summary: "Primary", primary: true },
        { id: "work@example.com", summary: "Work", primary: false },
      ],
    },
    isPending: false,
  };
  accountListReturn = { data: { ok: true, accounts: [] }, isPending: false };
  outputDestinationReturns = {
    notion: {
      data: {
        ok: true,
        channel: "notion",
        identity: { label: "Ada Lovelace", detail: "ada@example.com" },
        destinations: [
          { id: "db-1", type: "database", label: "Team Notes", detail: "Database" },
          { id: "page-1", type: "page", label: "Weekly Memo", detail: "Page" },
        ],
      },
      isPending: false,
    },
    zulip: {
      data: {
        ok: true,
        channel: "zulip",
        identity: { label: "Yulu Bot", detail: "bot@example.com" },
        destinations: [
          { id: "1", type: "channel", label: "meetings", detail: "Meeting notes" },
          { id: "2", type: "channel", label: "team", detail: "" },
        ],
      },
      isPending: false,
    },
  };
  connectorStatusReturn = {
    data: {
      schema_version: 1,
      connectors: {
        gog: {
          connector_id: "gog",
          display_name: "Google Calendar (gog)",
          provenance: "host-path",
          status: "usable",
          resolved_path: "/opt/homebrew/bin/gog",
          detail: "gog v1",
          actions: ["calendar.read"],
          config_prefix: "calendars",
        },
        feishu: {
          connector_id: "feishu",
          display_name: "Feishu",
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/agent/plugins/feishu",
          detail: "agent plugin detected",
          actions: ["calendar.read"],
          config_prefix: "connectors.feishu",
        },
        notion: {
          connector_id: "notion",
          display_name: "Notion",
          provenance: "agent-config",
          status: "usable",
          resolved_path: "/agent/plugins/notion",
          detail: "agent plugin detected",
          actions: ["summary.send"],
          config_prefix: "connectors.notion",
        },
        zulip: {
          connector_id: "zulip",
          display_name: "Zulip",
          provenance: "absent",
          status: "absent",
          resolved_path: "",
          detail: "zulip connector not found",
          actions: ["summary.send"],
          config_prefix: "connectors.zulip",
        },
      },
    },
    isPending: false,
  };
  configReturn = configWith([]);
});

function mount() {
  return render(
    <MemoryRouter>
      <IntegrationsSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("IntegrationsSection — Feishu removed (P4a-4)", () => {
  it("offers no legacy + Feishu calendar button", () => {
    mount();
    expect(screen.queryByRole("button", { name: /feishu/i })).toBeNull();
    // Only the Google add button remains.
    expect(screen.getByRole("button", { name: "+ Google" })).toBeInTheDocument();
  });

  it("renders Feishu as an AI connector instead of a legacy calendar stub", () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    mount();
    expect(screen.getByText("Feishu")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "+ Feishu" })).toBeNull();
  });
});

describe("IntegrationsSection — AI integration layout", () => {
  it("renders AI integration with calendar and output sections, not a separate connector hub", () => {
    configReturn = configWith(
      [{ type: "google", enabled: true, gog_account: "me@example.com", watch_calendars: ["primary"] }],
      { notion: { send_summary: true } },
      { notion: { destination_id: "db-1", destination_type: "database", destination_label: "Team Notes" } },
    );
    const { container } = mount();

    expect(screen.getByRole("heading", { name: translate("zh", "settings.integrations.heading") })).toBeInTheDocument();
    const calendarSection = container.querySelector('[data-section="calendar"]') as HTMLElement;
    const outputSection = container.querySelector('[data-section="output"]') as HTMLElement;
    expect(calendarSection).toBeTruthy();
    expect(outputSection).toBeTruthy();
    expect(container.querySelector(".connector-hub")).toBeNull();
    expect(within(calendarSection).getByText(translate("zh", "settings.integrations.calendar.heading"))).toBeInTheDocument();
    expect(within(outputSection).getByText(translate("zh", "settings.integrations.output.heading"))).toBeInTheDocument();
  });

  it("does not render Telegram as an output integration", () => {
    mount();
    const outputSection = screen.getByText(translate("zh", "settings.integrations.output.heading")).closest('[data-section="output"]') as HTMLElement;

    expect(within(outputSection).queryByText("Telegram")).toBeNull();
    expect(within(outputSection).queryByRole("switch", { name: /telegram/i })).toBeNull();
  });

  it("Google calendar enable switch reflects calendars.<idx>.enabled and commits that field", async () => {
    configReturn = configWith([
      { type: "google", enabled: true, gog_account: "me@example.com", watch_calendars: ["primary"] },
    ]);
    mount();
    const user = userEvent.setup();

    const card = screen.getByText(translate("zh", "settings.integrations.google.title")).closest(".calendar-provider-card") as HTMLElement;
    expect(within(card).getByText(translate("zh", "settings.integrations.connection.connected"))).toBeInTheDocument();
    const enabledSwitch = within(card).getByRole("switch", { name: translate("zh", "settings.integrations.enabled.label") });
    expect(enabledSwitch).toHaveAttribute("aria-checked", "true");

    await user.click(enabledSwitch);
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.enabled", value: false }),
    );
    expect(updateMutate).not.toHaveBeenCalledWith(expect.objectContaining({ key: "connectors.gog.read_calendar" }));
  });

  it("Notion output shows connected account and selectable destinations instead of manual ids", async () => {
    configReturn = configWith([], {
      notion: { send_summary: false },
    }, {
      notion: { destination_id: "db-1", destination_type: "database", destination_label: "Team Notes" },
    });
    mount();
    const user = userEvent.setup();

    const card = screen.getByText("Notion").closest(".output-provider-card") as HTMLElement;
    expect(within(card).getByText("Ada Lovelace")).toBeInTheDocument();
    expect(within(card).getByText("ada@example.com")).toBeInTheDocument();
    expect(within(card).queryByText(translate("zh", "settings.output.notion.database"))).toBeNull();
    expect(within(card).queryByText(translate("zh", "settings.output.notion.apiKey"))).toBeNull();

    await user.click(within(card).getByRole("switch", { name: translate("zh", "settings.integrations.output.enable.notion") }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "connectors.notion.send_summary", value: true }),
    );

    await user.selectOptions(
      within(card).getByRole("combobox", { name: translate("zh", "settings.integrations.output.destination.notion") }),
      "page-1",
    );
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "output.notion.destination_id", value: "page-1" }),
    );
    expect(updateMutate).toHaveBeenCalledWith({ key: "output.notion.destination_type", value: "page" });
    expect(updateMutate).toHaveBeenCalledWith({ key: "output.notion.destination_label", value: "Weekly Memo" });
  });

  it("Zulip output shows connected account and selectable channels", async () => {
    connectorStatusReturn.data.connectors.zulip = {
      connector_id: "zulip",
      display_name: "Zulip",
      provenance: "agent-config",
      status: "usable",
      resolved_path: "/agent/plugins/zulip",
      detail: "agent plugin detected",
      actions: ["summary.send"],
      config_prefix: "connectors.zulip",
    };
    configReturn = configWith([], {
      zulip: { send_summary: true },
    }, {
      zulip: { stream_id: "1", stream: "meetings", topic: "纪要" },
    });
    mount();
    const user = userEvent.setup();

    const card = screen.getByText("Zulip").closest(".output-provider-card") as HTMLElement;
    expect(within(card).getByText("Yulu Bot")).toBeInTheDocument();
    expect(within(card).getByText("bot@example.com")).toBeInTheDocument();

    await user.selectOptions(
      within(card).getByRole("combobox", { name: translate("zh", "settings.integrations.output.destination.zulip") }),
      "2",
    );
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "output.zulip.stream_id", value: "2" }),
    );
    expect(updateMutate).toHaveBeenCalledWith({ key: "output.zulip.stream", value: "team" });
  });

  it("Zulip output shows installation guidance when the connector is absent", () => {
    configReturn = configWith([], { zulip: { send_summary: false } }, { zulip: { stream: "meetings", topic: "纪要" } });
    mount();
    const card = screen.getByText("Zulip").closest(".output-provider-card") as HTMLElement;
    expect(within(card).getByText(translate("zh", "settings.integrations.connector.status.absent"))).toBeInTheDocument();
    expect(within(card).getByText(translate("zh", "settings.integrations.output.installHint"))).toBeInTheDocument();
    expect(within(card).getByRole("switch", { name: translate("zh", "settings.integrations.output.enable.zulip") })).toBeDisabled();
  });

  it("Notion output does not load destinations for app-backed connectors without a local bridge", () => {
    connectorStatusReturn.data.connectors.notion = {
      connector_id: "notion",
      display_name: "Notion",
      provenance: "agent-config",
      status: "present-but-unverified",
      resolved_path: "/agent/plugins/notion",
      detail: "agent plugin detected; host app bridge not available",
      actions: ["summary.send"],
      config_prefix: "connectors.notion",
    };
    configReturn = configWith([], { notion: { send_summary: false } }, {});
    mount();
    const card = screen.getByText("Notion").closest(".output-provider-card") as HTMLElement;
    expect(within(card).getByText(translate("zh", "settings.integrations.connector.status.unverified"))).toBeInTheDocument();
    expect(within(card).getByText(translate("zh", "settings.integrations.output.unavailableHint"))).toBeInTheDocument();
    expect(within(card).getByRole("switch", { name: translate("zh", "settings.integrations.output.enable.notion") })).toBeDisabled();
    expect(within(card).getByRole("button", { name: translate("zh", "settings.integrations.output.connect.notion") })).toBeInTheDocument();
    expect(within(card).queryByText("Ada Lovelace")).toBeNull();
  });

  it("Connect Notion starts MCP OAuth and opens the authorization URL", async () => {
    connectorStatusReturn.data.connectors.notion = {
      connector_id: "notion",
      display_name: "Notion",
      provenance: "agent-config",
      status: "present-but-unverified",
      resolved_path: "/agent/plugins/notion",
      detail: "agent plugin detected; host app bridge not available",
      actions: ["summary.send"],
      config_prefix: "connectors.notion",
    };
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    const card = screen.getByText("Notion").closest(".output-provider-card") as HTMLElement;
    const user = userEvent.setup();

    await user.click(within(card).getByRole("button", { name: translate("zh", "settings.integrations.output.connect.notion") }));

    await vi.waitFor(() => expect(notionMcpStartAuthMutate).toHaveBeenCalled());
    expect(openSpy).toHaveBeenCalledWith("https://auth.notion.test/authorize", "_blank", "noopener,noreferrer");
    openSpy.mockRestore();
  });

  it("Connect Notion shows a visible error when OAuth cannot start", async () => {
    connectorStatusReturn.data.connectors.notion = {
      connector_id: "notion",
      display_name: "Notion",
      provenance: "agent-config",
      status: "present-but-unverified",
      resolved_path: "/agent/plugins/notion",
      detail: "agent plugin detected; host app bridge not available",
      actions: ["summary.send"],
      config_prefix: "connectors.notion",
    };
    notionMcpStartAuthMutate.mockRejectedValueOnce(new Error("Notion discovery failed"));
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    mount();
    const card = screen.getByText("Notion").closest(".output-provider-card") as HTMLElement;
    const user = userEvent.setup();

    await user.click(within(card).getByRole("button", { name: translate("zh", "settings.integrations.output.connect.notion") }));

    await vi.waitFor(() => {
      expect(within(card).getByText("无法启动 Notion 连接：Notion discovery failed")).toBeInTheDocument();
    });
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});

describe("IntegrationsSection — Google calendar via gog (P4a-4)", () => {
  it("empty: shows a 'No calendar connected.' state and the + Google button", () => {
    mount();
    expect(screen.getByText(translate("zh", "settings.integrations.empty"))).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Google" })).toBeInTheDocument();
  });

  it("reframes the entry header as 'Google Calendar (via gog)' with an account + watch list", () => {
    configReturn = configWith([{ type: "google", enabled: true, gog_account: "me@example.com", watch_calendars: ["primary", "work"] }]);
    const { container } = mount();
    const card = container.querySelector(".integration-card") as HTMLElement;
    // The header inside the card reads "Google Calendar (via gog)" (the section
    // subtitle uses the same words, so scope to the card).
    expect(within(card).getByText(translate("zh", "settings.integrations.google.title"))).toBeInTheDocument();
    expect(within(card).getByText(translate("zh", "settings.integrations.account.label"))).toBeInTheDocument();
    expect(within(card).getByText(translate("zh", "settings.integrations.watch.label"))).toBeInTheDocument();
    // watch_calendars renders from the discovered calendar list, not free-text chips.
    expect(within(card).getByRole("checkbox", { name: "Primary primary" })).toBeChecked();
    expect(within(card).getByRole("checkbox", { name: "Work work@example.com" })).not.toBeChecked();
  });

  it("watch_calendars defaults to ['primary'] when unset", () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    mount();
    expect(screen.getByRole("checkbox", { name: "Primary primary" })).toBeChecked();
  });

  it("loads calendars automatically and commits selected checkbox ids", async () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com", watch_calendars: ["primary"] }]);
    mount();
    const user = userEvent.setup();

    await user.click(screen.getByRole("checkbox", { name: "Work work@example.com" }));

    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "calendars.0.watch_calendars",
        value: ["primary", "work@example.com"],
      }),
    );
  });

  it("shows a calendar-list error instead of a free-text watch editor when gog cannot list calendars", () => {
    calendarListReturn = { data: { ok: false, calendars: [], stderr: "not authenticated" }, isPending: false };
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com", watch_calendars: ["primary"] }]);
    mount();

    expect(screen.getByText("not authenticated")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "" })).toBeNull();
  });

  it("editing the gog_account commits calendars.<idx>.gog_account", async () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    mount();
    const row = screen.getByText(translate("zh", "settings.integrations.account.label")).closest(".row")! as HTMLElement;
    const user = userEvent.setup();
    // Click the value display (InlineEditRow text shows a display span until clicked).
    await user.click(within(row).getByText("me@example.com"));
    const input = within(row).getByRole("textbox") as HTMLInputElement;
    await user.clear(input);
    await user.type(input, "new@example.com");
    input.blur();
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.gog_account", value: "new@example.com" }),
    );
  });

  it("auto-fills gog_account when exactly one gog account is discovered", async () => {
    accountListReturn = {
      data: { ok: true, accounts: [{ email: "me@example.com", services: ["calendar"] }] },
      isPending: false,
    };
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "" }]);
    mount();

    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.gog_account", value: "me@example.com" }),
    );
    expect(screen.queryByText(translate("zh", "settings.integrations.watch.accountRequired"))).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Primary primary" })).toBeChecked();
    expect(record).not.toHaveBeenCalled();
  });

  it("lets the user choose gog_account when multiple gog accounts are discovered", async () => {
    accountListReturn = {
      data: {
        ok: true,
        accounts: [
          { email: "me@example.com", services: ["calendar"] },
          { email: "other@example.com", services: ["calendar"] },
        ],
      },
      isPending: false,
    };
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "" }]);
    mount();
    const user = userEvent.setup();

    await user.selectOptions(
      screen.getByRole("combobox", { name: translate("zh", "settings.integrations.account.label") }),
      "other@example.com",
    );

    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.gog_account", value: "other@example.com" }),
    );
  });

  it("Check connection → Connected when the gog test passes", async () => {
    testResult = { ok: true, stdout: "[]", stderr: "" };
    configReturn = configWith([{ type: "google", enabled: true, gog_account: "me@example.com" }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: translate("zh", "settings.integrations.connection.check") }));
    await vi.waitFor(() => expect(screen.getAllByText(translate("zh", "settings.integrations.connection.connected")).length).toBeGreaterThan(0));
  });

  it("Check connection → Not authenticated when the gog test fails", async () => {
    testResult = { ok: false, stdout: "", stderr: "未配置 gog_account" };
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "" }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: translate("zh", "settings.integrations.connection.check") }));
    await vi.waitFor(() => expect(screen.getByText(translate("zh", "settings.integrations.connection.notAuth"))).toBeInTheDocument());
  });
});

describe("IntegrationsSection — add/remove + restart suppression (P4a-4)", () => {
  it("adding Google appends a DISABLED entry with watch_calendars:['primary'] and does NOT trip the restart banner", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Google" }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "calendars",
        value: [{ type: "google", enabled: false, watch_calendars: ["primary"] }],
      }),
    );
    // Appending a disabled entry needs no restart → tracker.record NOT called.
    expect(record).not.toHaveBeenCalled();
  });

  it("an already-present Google provider's Add button is disabled (no duplicates)", () => {
    configReturn = configWith([{ type: "google", enabled: false }]);
    mount();
    expect((screen.getByRole("button", { name: "+ Google" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enabling a calendar trips the restart banner (record called with the daemons)", async () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    mount();
    const user = userEvent.setup();
    const row = screen.getByText(translate("zh", "settings.integrations.enabled.label")).closest(".row")!;
    await user.click(within(row as HTMLElement).getByRole("switch"));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.enabled", value: true }),
    );
    await vi.waitFor(() =>
      expect(record).toHaveBeenCalledWith("calendars.0.enabled", ["calendar", "scheduler"]),
    );
  });

  it("disabling an enabled calendar does NOT trip the restart banner", async () => {
    configReturn = configWith([{ type: "google", enabled: true, gog_account: "me@example.com" }]);
    mount();
    const user = userEvent.setup();
    const row = screen.getByText(translate("zh", "settings.integrations.enabled.label")).closest(".row")!;
    await user.click(within(row as HTMLElement).getByRole("switch"));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars.0.enabled", value: false }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("removing a DISABLED entry commits the array and does NOT trip restart", async () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: translate("zh", "settings.integrations.removeAria") }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars", value: [] }),
    );
    expect(record).not.toHaveBeenCalled();
  });

  it("removing an ENABLED entry trips restart (the daemon must stop watching it)", async () => {
    configReturn = configWith([{ type: "google", enabled: true, gog_account: "me@example.com" }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: translate("zh", "settings.integrations.removeAria") }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars", value: [] }),
    );
    await vi.waitFor(() =>
      expect(record).toHaveBeenCalledWith("calendars", ["calendar", "scheduler"]),
    );
  });

  it("recording-guard: while recording, Add/Remove are disabled and commit no array edit", async () => {
    recordingState = "recording";
    configReturn = configWith([{ type: "google", enabled: true }]);
    mount();
    const add = screen.getByRole("button", { name: "+ Google" }) as HTMLButtonElement;
    const remove = screen.getByRole("button", { name: translate("zh", "settings.integrations.removeAria") }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(add).catch(() => {});
    await user.click(remove).catch(() => {});
    expect(updateMutate).not.toHaveBeenCalledWith(expect.objectContaining({ key: "calendars" }));
  });
});
