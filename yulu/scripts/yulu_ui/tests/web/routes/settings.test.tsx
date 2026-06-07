import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, waitFor, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Navigate, Outlet } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// config.schema metadata used by the category list + detail. Shape mirrors the
// server's SettingMeta (registry entry minus the Zod validate field).
const SCHEMA = [
  { path: "audio.mic_device",         category: "audio",         label: "麦克风设备", type: "select", reload: { kind: "restart", daemons: ["audiodaemon"] } },
  { path: "audio.output_dir",         category: "audio",         label: "录音输出目录", type: "path", reload: { kind: "restart", daemons: ["audiodaemon"] } },
  { path: "transcription.language",   category: "transcription", label: "语言",      type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "llm.enabled",              category: "llm",           label: "启用 LLM",  type: "toggle", reload: { kind: "none" } },
  { path: "status_agent.enabled",     category: "general",       label: "菜单栏 Agent", type: "toggle", reload: { kind: "restart", daemons: ["statusagent"] } },
];

// Shared spy so tests can assert config.update was called on a field edit.
// vi.hoisted keeps it available inside the hoisted vi.mock factory below.
const { configUpdateSpy, recording } = vi.hoisted(() => ({
  configUpdateSpy: vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] })),
  recording: { state: "idle" as string },
}));

// useConfigField → useIsRecording subscribes to the recording WS channel. Stub
// ws.js to a passthrough provider + no-op channel (we drive recording state via
// the trpc.recording.state mock below).
vi.mock("../../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

// Stub trpc so each query returns minimal data and mutations no-op.
vi.mock("../../../web/src/trpc.js", () => {
  const cfg = {
    audio: { mic_device: ":0", system_audio_device: ":1", output_dir: "/tmp", silence_threshold: 0.01, silence_duration_sec: 300, backend: "daemon" },
    transcription: { realtime_enabled: true, final_engine: "mlx", language: "auto", local_model_path: "", mlx: { model: "", final_model: "", preprocess_audio: false, passthrough_max_sec: 0, passthrough_max_bytes: 0 } },
    llm: { enabled: false, command: [] },
    status_agent: { enabled: false },
    calendars: [],
  };
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }),
    isPending: false,
  });
  const utils = {
    system: { cloud: { detect: { fetch: async () => ({ is_cloud: false, engine: "", reason: "", dataless: false }) } } },
    prompts: { list: { invalidate: () => {} } },
  };
  return {
    trpc: {
      useUtils: () => utils,
      config: {
        get: { useQuery: () => ({ data: cfg, isPending: false }) },
        schema: { useQuery: () => ({ data: SCHEMA, isPending: false }) },
        envPresent: { useQuery: () => ({ data: { present: false }, isPending: false }) },
        update: { useMutation: (opts?: { onSuccess?: (res: unknown, vars: unknown) => void }) => ({
          mutate: () => {},
          mutateAsync: async (vars: { key: string; value: unknown }) => {
            const res = await configUpdateSpy(vars);
            opts?.onSuccess?.(res, vars);
            return res;
          },
          isPending: false,
        }) },
      },
      daemons: { restart: { useMutation: noopMutation } },
      recording: { state: { useQuery: () => ({ data: { state: recording.state } }) } },
      system: {
        audioDevices: { useQuery: () => ({ data: { input: [], output: [] }, isPending: false }) },
        dbStats: { useQuery: () => ({ data: [], isPending: false }) },
        logPaths: { useQuery: () => ({ data: [], isPending: false }) },
        yuluVersion: { useQuery: () => ({ data: { version: "0.8.0", installSource: "release v0.8.0" }, isPending: false }) },
        pickFile: { useMutation: noopMutation },
        openInFinder: { useMutation: noopMutation },
      },
      integrations: { test: { useMutation: noopMutation } },
      llm: { test: { useMutation: noopMutation } },
      prompts: {
        list: { useQuery: () => ({ data: [], isPending: false }) },
        update: { useMutation: noopMutation },
      },
      search: { reindex: { useMutation: noopMutation } },
      capabilities: {
        host_capabilities: { useQuery: () => ({ data: { schema_version: 1, capabilities: {} }, refetch: () => {}, isError: false }) },
        detected_models: { useQuery: () => ({ data: [], isPending: false }) },
      },
    },
    makeTrpcClient: () => ({}),
  };
});

import { useMatches } from "react-router";
import { SettingsLayout, handle as settingsHandle } from "../../../web/src/routes/settings.js";
import { SettingsCategory } from "../../../web/src/routes/settings.$category.js";
import { categoryLabel } from "../../../web/src/components/settings/categories.js";
import { CATEGORIES } from "../../../web/src/components/settings/categories.js";
import { ThemeProvider } from "../../../web/src/theme.js";

// Minimal breadcrumb probe that mirrors TopBar's breadcrumb computation (read
// each match's handle.breadcrumb, resolve string|fn, join with " / "). This
// exercises the route-handle wiring without pulling in TopBar's GlobalSearch.
function BreadcrumbProbe() {
  const matches = useMatches();
  const segments: string[] = [];
  for (const m of matches) {
    const bc = (m.handle as { breadcrumb?: unknown } | undefined)?.breadcrumb;
    if (bc == null) continue;
    if (typeof bc === "string") segments.push(bc);
    else if (typeof bc === "function") {
      const v = (bc as (p: Record<string, string | undefined>) => string | null)(m.params as Record<string, string | undefined>);
      if (v) segments.push(v);
    }
  }
  return <div className="topbar-breadcrumb">{segments.join(" / ")}</div>;
}

// A layout that renders the breadcrumb above the settings subtree.
function Shell() {
  return (
    <>
      <BreadcrumbProbe />
      <Outlet />
    </>
  );
}

function routesTree() {
  return [
    {
      path: "/",
      Component: Shell,
      handle: { breadcrumb: null },
      children: [
        {
          path: "settings",
          Component: SettingsLayout,
          handle: settingsHandle,
          children: [
            { index: true, element: <Navigate to="/settings/general" replace /> },
            {
              path: ":category",
              Component: SettingsCategory,
              handle: { breadcrumb: (p: Record<string, string | undefined>) => categoryLabel(p.category ?? ""), filters: null },
            },
          ],
        },
      ],
    },
  ];
}

function wrap(initial = "/settings/general") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(routesTree(), { initialEntries: [initial] });
  const result = render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
  return { ...result, router };
}

describe("Settings (3-column MasterDetail)", () => {
  it("renders the MasterDetail shell", () => {
    const { container } = wrap();
    expect(container.querySelector(".masterdetail")).not.toBeNull();
    expect(container.querySelector(".masterdetail-list")).not.toBeNull();
    expect(container.querySelector(".masterdetail-detail")).not.toBeNull();
  });

  it("renders one category nav per registered category, with no emoji", () => {
    const { getAllByTestId } = wrap();
    const navs = getAllByTestId("settings-category");
    expect(navs.length).toBe(CATEGORIES.length);
    // Locked by brainstorm: category rows carry no emoji.
    const emoji = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
    for (const nav of navs) {
      expect(nav.textContent ?? "").not.toMatch(emoji);
    }
  });

  it("shows the Chinese category labels in the nav list", () => {
    const { container } = wrap();
    const list = container.querySelector(".masterdetail-list")!;
    const scoped = within(list as HTMLElement);
    expect(scoped.getByText("通用")).toBeInTheDocument();
    expect(scoped.getByText("音频与存储")).toBeInTheDocument();
    expect(scoped.getByText("转写")).toBeInTheDocument();
    expect(scoped.getByText("集成")).toBeInTheDocument();
  });

  it("renders the breadcrumb as 'Settings / <category>'", () => {
    const { container } = wrap("/settings/audio");
    expect(container.querySelector(".topbar-breadcrumb")?.textContent).toBe("Settings / 音频与存储");
  });

  it("marks the active category nav for the current route", () => {
    const { getAllByTestId } = wrap("/settings/audio");
    const active = getAllByTestId("settings-category").filter((n) => n.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute("href")).toBe("/settings/audio");
  });

  it("wires the settings index to redirect to /settings/general", () => {
    // The index child is an element-based <Navigate> redirect (same pattern as
    // the app's other index routes). createMemoryRouter doesn't pump a
    // render-phase <Navigate> on initial load in jsdom, so we assert the
    // configured redirect target rather than the post-redirect location.
    const tree = routesTree();
    const settingsRoute = tree[0]!.children!.find((c) => c.path === "settings")!;
    const indexRoute = settingsRoute.children!.find((c) => "index" in c && c.index)!;
    const el = indexRoute.element as React.ReactElement<{ to: string }>;
    expect(el.props.to).toBe("/settings/general");
  });

  it("renders the automation (meeting detection) section", () => {
    const { container } = wrap("/settings/automation");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("Automation")).toBeInTheDocument();
    expect(detail.getByText("Meeting detection")).toBeInTheDocument();
  });
});

describe("Settings category detail content (re-homed widgets)", () => {
  it("general: capabilities (read-only) + theme + status agent + about", () => {
    const { container, getByText } = wrap("/settings/general");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("Host capabilities")).toBeInTheDocument();
    // ThemeToggle (UI theme control) is re-homed here.
    expect(container.querySelector('[role="group"][aria-label="Theme"]')).not.toBeNull();
    expect(getByText("Status agent enabled")).toBeInTheDocument();
    // P3-1: the read-only About block (version + install source) lives in general.
    expect(detail.getByText("About")).toBeInTheDocument();
    expect(detail.getByText("0.8.0")).toBeInTheDocument();
  });

  it("audio: audio rows + storage dbStats/logs", () => {
    const { container } = wrap("/settings/audio");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("Audio")).toBeInTheDocument();
    expect(detail.getByText("Microphone device")).toBeInTheDocument();
    // StorageSection is re-homed under audio (its "Storage" heading + Databases group).
    expect(detail.getByText("Storage")).toBeInTheDocument();
    expect(detail.getByText("Databases")).toBeInTheDocument();
  });

  it("transcription: the full transcription section", () => {
    const { container } = wrap("/settings/transcription");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("Transcription")).toBeInTheDocument();
    expect(detail.getByText("Transcription mode")).toBeInTheDocument();
  });

  it("llm: enabled toggle + a Test command button", () => {
    const { container, getByRole } = wrap("/settings/llm");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("LLM")).toBeInTheDocument();
    expect(getByRole("button", { name: "Test command" })).toBeInTheDocument();
  });

  it("integrations: the integrations section", () => {
    const { container } = wrap("/settings/integrations");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText("Integrations")).toBeInTheDocument();
  });

  it("advanced: the advanced-flagged cloud transcription command", () => {
    const { container } = wrap("/settings/advanced");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    // Exact match to hit the label, not the longer help paragraph that also
    // mentions "cloud transcription command".
    expect(detail.getByText("Cloud transcription command")).toBeInTheDocument();
  });

  it("commits a field edit through trpc.config.update", async () => {
    configUpdateSpy.mockClear();
    const { getByText } = wrap("/settings/llm");
    // The LLM "Enabled" toggle commits llm.enabled on click.
    const enabledLabel = getByText("Enabled");
    const row = enabledLabel.closest(".row")!;
    const sw = within(row as HTMLElement).getByRole("switch");
    sw.click();
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalled());
    expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "llm.enabled" }));
  });
});

describe("Settings — recording-guard + undo (Task 5)", () => {
  beforeEach(() => {
    recording.state = "idle";
    configUpdateSpy.mockClear();
  });

  it("while recording, a restart-class field is locked (disabled, not editable)", () => {
    recording.state = "recording";
    // status_agent.enabled is restart-class (statusagent) and lives in general.
    const { getByText, queryByRole } = wrap("/settings/general");
    const row = getByText("Status agent enabled").closest(".row")!;
    // The interactive switch is replaced by a read-only display + a 录音中 note.
    expect(within(row as HTMLElement).queryByRole("switch")).toBeNull();
    expect(within(row as HTMLElement).getByText(/录音中/)).toBeInTheDocument();
    // No restart-class commit can be made from this row.
    expect(queryByRole("switch", { name: /status agent/i })).toBeNull();
  });

  it("a non-restart field stays editable while recording", () => {
    recording.state = "recording";
    const { getByText } = wrap("/settings/llm");
    // llm.enabled is reload:none → not guarded.
    const row = getByText("Enabled").closest(".row")!;
    expect(within(row as HTMLElement).getByRole("switch")).toBeInTheDocument();
  });

  it("a successful save shows an undo toast whose 撤销 re-commits the previous value", async () => {
    const { getByText, getByTestId } = wrap("/settings/llm");
    // cfg.llm.enabled starts false; toggling commits true.
    const row = getByText("Enabled").closest(".row")!;
    within(row as HTMLElement).getByRole("switch").click();
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "llm.enabled", value: true })));
    // The undo toast appears; clicking 撤销 re-commits the OLD value (false).
    const toast = await waitFor(() => getByTestId("undo-toast"));
    configUpdateSpy.mockClear();
    fireEvent.click(within(toast).getByText("撤销"));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "llm.enabled", value: false })));
  });
});
