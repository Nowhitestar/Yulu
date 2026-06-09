// tests/web/IntegrationsSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["calendar", "scheduler"], daemonsNeedingSighup: [] }));
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

// calendars is restart-class (calendar + scheduler) — drives the recording-guard.
const SCHEMA = [
  { path: "calendars", category: "integrations", label: "日历", type: "text", reload: { kind: "restart", daemons: ["calendar", "scheduler"] } },
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
      test: { useMutation: () => ({ mutateAsync: async () => testResult }) },
      accountList: { useQuery: () => accountListReturn },
      calendarList: { useQuery: () => calendarListReturn },
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

function configWith(calendars: unknown[]) {
  return { data: { calendars }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
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
  it("offers no + Feishu button (Feishu is a dead stub)", () => {
    mount();
    expect(screen.queryByRole("button", { name: /feishu/i })).toBeNull();
    // Only the Google add button remains.
    expect(screen.getByRole("button", { name: "+ Google" })).toBeInTheDocument();
  });

  it("never renders the word Feishu anywhere", () => {
    configReturn = configWith([{ type: "google", enabled: false, gog_account: "me@example.com" }]);
    const { container } = mount();
    expect(container.textContent).not.toMatch(/feishu/i);
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
    await vi.waitFor(() => expect(screen.getByText(translate("zh", "settings.integrations.connection.connected"))).toBeInTheDocument());
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
