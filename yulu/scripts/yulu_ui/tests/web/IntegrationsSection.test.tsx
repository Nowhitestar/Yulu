// tests/web/IntegrationsSection.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const updateMutate = vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: ["calendar", "scheduler"], daemonsNeedingSighup: [] }));
let configReturn: { data: unknown; isPending: boolean } = { data: undefined, isPending: false };
let recordingState: string = "idle";

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
      update: { useMutation: (opts?: { onSuccess?: (r: unknown, v: unknown) => void }) => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => {
          const res = await updateMutate(vars);
          opts?.onSuccess?.(res, vars);
          return res;
        },
      }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    integrations: { test: { useMutation: () => ({ mutateAsync: async () => ({ ok: true, stdout: "", stderr: "" }) }) } },
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

const tracker = { record: vi.fn(), statusFor: () => null, clear: vi.fn(), pending: {} } as never;

function configWith(calendars: unknown[]) {
  return { data: { calendars }, isPending: false };
}

beforeEach(() => {
  updateMutate.mockClear();
  recordingState = "idle";
  configReturn = configWith([]);
});

function mount() {
  return render(
    <MemoryRouter>
      <IntegrationsSection tracker={tracker} />
    </MemoryRouter>,
  );
}

describe("IntegrationsSection — calendar add/remove (P2-5)", () => {
  it("empty: shows Add Feishu / Add Google and the empty state", () => {
    mount();
    expect(screen.getByText("No calendar providers configured.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Feishu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "+ Google" })).toBeInTheDocument();
  });

  it("adding Feishu appends {type:'feishu', enabled:false} via config.update('calendars', …)", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Feishu" }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars", value: [{ type: "feishu", enabled: false }] }),
    );
  });

  it("adding Google to an existing Feishu appends without dropping Feishu", async () => {
    configReturn = configWith([{ type: "feishu", enabled: true, app_id_env: "FEISHU_APP_ID" }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "+ Google" }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "calendars",
        value: [
          { type: "feishu", enabled: true, app_id_env: "FEISHU_APP_ID" },
          { type: "google", enabled: false },
        ],
      }),
    );
  });

  it("an already-present provider's Add button is disabled (no duplicates)", () => {
    configReturn = configWith([{ type: "feishu", enabled: false }]);
    mount();
    expect((screen.getByRole("button", { name: "+ Feishu" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "+ Google" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("removing an entry commits the array without that entry", async () => {
    configReturn = configWith([
      { type: "feishu", enabled: true },
      { type: "google", enabled: false, gog_account: "me@example.com" },
    ]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove feishu calendar" }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({
        key: "calendars",
        value: [{ type: "google", enabled: false, gog_account: "me@example.com" }],
      }),
    );
  });

  it("removing the only entry commits an empty array", async () => {
    configReturn = configWith([{ type: "google", enabled: false }]);
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Remove google calendar" }));
    await vi.waitFor(() =>
      expect(updateMutate).toHaveBeenCalledWith({ key: "calendars", value: [] }),
    );
  });

  it("recording-guard: while recording, Add/Remove are disabled and commit no array edit", async () => {
    recordingState = "recording";
    configReturn = configWith([{ type: "feishu", enabled: true }]);
    mount();
    const add = screen.getByRole("button", { name: "+ Google" }) as HTMLButtonElement;
    const remove = screen.getByRole("button", { name: "Remove feishu calendar" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    expect(remove.disabled).toBe(true);
    const user = userEvent.setup();
    await user.click(add).catch(() => {});
    await user.click(remove).catch(() => {});
    expect(updateMutate).not.toHaveBeenCalledWith(expect.objectContaining({ key: "calendars" }));
  });
});
