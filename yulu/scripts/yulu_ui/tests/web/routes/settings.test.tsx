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
  { path: "status_agent.enabled",     category: "general",       label: "菜单栏 Agent", type: "toggle", reload: { kind: "none" } },
  { path: "status_agent.hotkeys",     category: "voice",         label: "语音输入快捷键", type: "text", reload: { kind: "sighup", daemons: ["statusagent"] } },
  { path: "transcription.dictation",  category: "voice",         label: "语音输入模板", type: "text", reload: { kind: "none" } },
];

// Shared spy so tests can assert config.update was called on a field edit.
// vi.hoisted keeps it available inside the hoisted vi.mock factory below.
const { configUpdateSpy, promptsListSpy, recording } = vi.hoisted(() => ({
  configUpdateSpy: vi.fn(async (_vars: { key: string; value: unknown }) => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] })),
  promptsListSpy: vi.fn(),
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
    audio: { mic_device: "BuiltInMic", system_audio_device: ":1", output_dir: "/tmp", silence_threshold: 0.01, silence_duration_sec: 300, backend: "daemon" },
    transcription: {
      realtime_enabled: true,
      final_engine: "mlx",
      language: "auto",
      local_model_path: "",
      mlx: { model: "", final_model: "", preprocess_audio: false, passthrough_max_sec: 0, passthrough_max_bytes: 0 },
      dictation: { engine: "auto", prompt_slug: "dictation-cleanup", translate_prompt_slug: "dictation-translate", target_language: "English" },
    },
    llm: { enabled: false, command: [] },
    status_agent: {
      enabled: false,
      hotkeys: {
        dictate: { key: "Space", modifiers: ["ctrl", "alt"] },
        translate: { key: "T", modifiers: ["ctrl", "alt"] },
        voice_chat: { key: "A", modifiers: ["ctrl", "alt"] },
      },
    },
    calendars: [],
    connectors: { notion: { send_summary: false }, zulip: { send_summary: false } },
    output: { notion: { database_id: "", api_key_env: "NOTION_API_KEY" }, zulip: { stream: "", topic: "" } },
  };
  const noopMutation = () => ({
    mutate: () => {},
    mutateAsync: async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }),
    isPending: false,
  });
  const utils = {
    config: { get: { setData: () => {}, invalidate: () => {} } },
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
        audioDevices: { useQuery: () => ({ data: {
          input: [
            { uid: "BuiltInMic", name: "MacBook Pro Microphone" },
            { uid: "StudioMic", name: "Studio Mic" },
          ],
          output: [],
        }, isPending: false }) },
        dbStats: { useQuery: () => ({ data: [], isPending: false }) },
        logPaths: { useQuery: () => ({ data: [], isPending: false }) },
        yuluVersion: { useQuery: () => ({ data: { version: "0.8.0", installSource: "release v0.8.0" }, isPending: false }) },
        pickFile: { useMutation: noopMutation },
        openInFinder: { useMutation: noopMutation },
      },
      integrations: {
        connectorStatus: { useQuery: () => ({ data: { schema_version: 1, connectors: {} }, isPending: false }) },
        notionMcpStartAuth: { useMutation: noopMutation },
        test: { useMutation: noopMutation },
        accountList: { useQuery: () => ({ data: { ok: true, accounts: [] }, isPending: false }) },
        calendarList: { useQuery: () => ({ data: { ok: true, calendars: [] }, isPending: false }) },
        outputDestinations: {
          useQuery: (input: { channel: string }) => ({
            data: { ok: false, channel: input.channel, identity: null, destinations: [], error: "not connected" },
            isPending: false,
          }),
        },
      },
      agentConsole: {
        overview: {
          useQuery: () => ({
            data: {
              agents: [{ name: "Codex CLI", connected: true }],
              plugins: {
                current: [
                  { id: "calendar", label: "日历", added: true, status: "configured", statusLabel: "已配置", detail: "/agent/plugins/calendar", resolvedPath: "/agent/plugins/calendar" },
                ],
              },
            },
            isPending: false,
          }),
        },
      },
      llm: { test: { useMutation: noopMutation } },
      prompts: {
        list: { useQuery: (input: unknown) => {
          promptsListSpy(input);
          return { data: [
            { slug: "dictation-cleanup", name: "Dictation Cleanup" },
            { slug: "dictation-tight", name: "Tight Dictation" },
            { slug: "dictation-translate", name: "Dictation Translate" },
          ], isPending: false };
        } },
        update: { useMutation: noopMutation },
      },
      search: { reindex: { useMutation: noopMutation } },
      capabilities: {
        host_capabilities: { useQuery: () => ({ data: { schema_version: 1, capabilities: {} }, refetch: () => {}, isError: false }) },
        detected_models: { useQuery: () => ({ data: [], isPending: false }) },
        verify: { useMutation: noopMutation },
        provision: { useMutation: noopMutation },
      },
    },
    makeTrpcClient: () => ({}),
  };
});

import { useMatches } from "react-router";
import { SettingsLayout, handle as settingsHandle } from "../../../web/src/routes/settings.js";
import { SettingsCategory } from "../../../web/src/routes/settings.$category.js";
import { categoryLabelKey } from "../../../web/src/components/settings/categories.js";
import { CATEGORIES } from "../../../web/src/components/settings/categories.js";
import { translate, LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";
import { ThemeProvider } from "../../../web/src/theme.js";

// Minimal breadcrumb probe that mirrors TopBar's breadcrumb computation (read
// each match's handle.breadcrumb, resolve string|fn to an i18n key, run it
// through translate(), join with " / "). Breadcrumb values are now i18n keys
// (or functions returning a key), so we resolve them at the default language
// (zh) just like TopBar resolves them via t(). This exercises the route-handle
// wiring without pulling in TopBar's GlobalSearch.
function BreadcrumbProbe() {
  const matches = useMatches();
  const segments: string[] = [];
  for (const m of matches) {
    const bc = (m.handle as { breadcrumb?: unknown } | undefined)?.breadcrumb;
    if (bc == null) continue;
    if (typeof bc === "string") segments.push(translate("zh", bc));
    else if (typeof bc === "function") {
      const key = (bc as (p: Record<string, string | undefined>) => string | null)(m.params as Record<string, string | undefined>);
      if (key) segments.push(translate("zh", key));
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
            { path: "llm", element: <Navigate to="/agent-console" replace /> },
            { path: "integrations", element: <Navigate to="/agent-console" replace /> },
            {
              path: ":category",
              Component: SettingsCategory,
              handle: { breadcrumb: (p: Record<string, string | undefined>) => categoryLabelKey(p.category ?? ""), filters: null },
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
      <LanguageProvider>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </LanguageProvider>
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
    expect(scoped.queryByText("AI 集成")).toBeNull();
    expect(scoped.queryByText("Agent Console")).toBeNull();
  });

  it("renders the breadcrumb as '设置 / <category>'", () => {
    const { container } = wrap("/settings/audio");
    expect(container.querySelector(".topbar-breadcrumb")?.textContent).toBe("设置 / 音频与存储");
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
    // The section <h2> heading (distinct from the detail's <h1> title, which the
    // category label also renders as "自动化").
    expect(container.querySelector("h2.settings-section-h")?.textContent).toBe(translate("zh", "settings.automation.heading"));
    expect(detail.getByText(translate("zh", "settings.automation.enabled.label"))).toBeInTheDocument();
  });
});

describe("Settings category detail content (re-homed widgets)", () => {
  it("general: capabilities (read-only) + theme + status agent + about", () => {
    const { container, getByText } = wrap("/settings/general");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText(translate("zh", "settings.capabilities.heading"))).toBeInTheDocument();
    // Theme controls are re-homed here.
    expect(container.querySelector('[role="group"][aria-label="主题"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="主题明暗模式"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="主题家族"]')).not.toBeNull();
    expect(getByText(translate("zh", "settings.hotkey.statusAgent.label"))).toBeInTheDocument();
    // P3-1: the read-only About block (version + install source) lives in general.
    expect(detail.getByText(translate("zh", "settings.about.heading"))).toBeInTheDocument();
    expect(detail.getByText("0.8.0")).toBeInTheDocument();
  });

  it("audio: audio rows + storage dbStats/logs", () => {
    const { container } = wrap("/settings/audio");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    expect(detail.getByText(translate("zh", "settings.audio.heading"))).toBeInTheDocument();
    expect(detail.getByText(translate("zh", "settings.audio.micDevice.label"))).toBeInTheDocument();
    // StorageSection is re-homed under audio (its "Storage" heading + Databases group).
    expect(detail.getByText(translate("zh", "settings.storage.heading"))).toBeInTheDocument();
    expect(detail.getByText(translate("zh", "settings.storage.databases"))).toBeInTheDocument();
  });

  it("audio: mic device selection commits audio.mic_device", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/audio");
    const audio = within(container.querySelector("#audio") as HTMLElement);
    const row = audio.getByText(translate("zh", "settings.audio.micDevice.label")).closest(".row") as HTMLElement;
    fireEvent.click(within(row).getByText("MacBook Pro Microphone"));
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "StudioMic" } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "audio.mic_device",
      value: "StudioMic",
    })));
  });

  it("transcription: the full transcription section", () => {
    const { container } = wrap("/settings/transcription");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    // Section <h2> heading is distinct from the detail <h1> title (the category
    // label also renders "转写").
    expect(container.querySelector("h2.settings-section-h")?.textContent).toBe(translate("zh", "settings.transcription.heading"));
    expect(detail.getByText(translate("zh", "settings.transcription.mode.label"))).toBeInTheDocument();
  });

  it("voice: hotkey capture commits key and modifiers from the pressed shortcut", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    fireEvent.click(voice.getByLabelText("听写快捷键 重新配置"));
    await waitFor(() => expect(voice.getByText("请按下新的快捷键")).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "F1", ctrlKey: true, altKey: true });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "status_agent.hotkeys.dictate.key",
      value: "F1",
    })));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "status_agent.hotkeys.dictate.modifiers",
      value: ["ctrl", "alt"],
    })));
  });

  it("voice: dictation template selector commits the selected prompt slug", async () => {
    configUpdateSpy.mockClear();
    promptsListSpy.mockClear();
    const { container } = wrap("/settings/voice");
    expect(promptsListSpy).toHaveBeenCalledWith({ category: "voice" });
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    const row = voice.getByText(translate("zh", "settings.voice.prompt.dictate")).closest(".row") as HTMLElement;
    fireEvent.click(within(row).getByText("Dictation Cleanup"));
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "dictation-tight" } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "transcription.dictation.prompt_slug",
      value: "dictation-tight",
    })));
  });

  it("voice: translation template selector commits the selected prompt slug", async () => {
    configUpdateSpy.mockClear();
    promptsListSpy.mockClear();
    const { container } = wrap("/settings/voice");
    expect(promptsListSpy).toHaveBeenCalledWith({ category: "voice" });
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    const row = voice.getByText(translate("zh", "settings.voice.prompt.translate")).closest(".row") as HTMLElement;
    fireEvent.click(within(row).getByText("Dictation Translate"));
    fireEvent.change(within(row).getByRole("combobox"), { target: { value: "dictation-tight" } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "transcription.dictation.translate_prompt_slug",
      value: "dictation-tight",
    })));
  });

  it("voice: translation target language commits the dotted config path", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    const row = voice.getByText(translate("zh", "settings.voice.targetLanguage")).closest(".row") as HTMLElement;
    fireEvent.click(within(row).getByText("English"));
    const input = within(row).getByLabelText(translate("zh", "settings.voice.targetLanguage"));
    fireEvent.change(input, { target: { value: "Japanese" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "transcription.dictation.target_language",
      value: "Japanese",
    })));
  });

  it("llm: legacy settings route redirects to Agent Console instead of rendering settings UI", () => {
    const tree = routesTree();
    const settingsRoute = tree[0]!.children!.find((c) => c.path === "settings")!;
    const llmRoute = settingsRoute.children!.find((c) => c.path === "llm")!;
    const el = llmRoute.element as React.ReactElement<{ to: string }>;
    expect(el.props.to).toBe("/agent-console");
  });

  it("integrations: legacy settings route redirects to Agent Console instead of rendering AI integration UI", () => {
    const tree = routesTree();
    const settingsRoute = tree[0]!.children!.find((c) => c.path === "settings")!;
    const integrationsRoute = settingsRoute.children!.find((c) => c.path === "integrations")!;
    const el = integrationsRoute.element as React.ReactElement<{ to: string }>;
    expect(el.props.to).toBe("/agent-console");
  });

  it("advanced: the advanced-flagged cloud transcription command", () => {
    const { container } = wrap("/settings/advanced");
    const detail = within(container.querySelector(".masterdetail-detail") as HTMLElement);
    // Exact match to hit the label, not the longer help paragraph that also
    // mentions "cloud transcription command".
    expect(detail.getByText(translate("zh", "settings.advanced.cloudCommand.label"))).toBeInTheDocument();
  });

  it("commits a field edit through trpc.config.update", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/transcription");
    const row = within(container.querySelector("#transcription") as HTMLElement)
      .getByText(translate("zh", "settings.transcription.realtime.label"))
      .closest(".row")!;
    within(row as HTMLElement).getByRole("switch").click();
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "transcription.realtime_enabled",
      value: false,
    })));
  });
});

describe("Settings — recording-guard + undo (Task 5)", () => {
  beforeEach(() => {
    recording.state = "idle";
    configUpdateSpy.mockClear();
  });

  it("while recording, a restart-class field is locked (disabled, not editable)", () => {
    recording.state = "recording";
    const { container } = wrap("/settings/audio");
    const audio = container.querySelector("#audio") as HTMLElement;
    const row = within(audio).getByText(translate("zh", "settings.audio.outputDir.label")).closest(".row")!;
    // The path picker is replaced by read-only display + a 录音中 note.
    expect(within(row as HTMLElement).queryByRole("button", { name: translate("zh", "path.choose") })).toBeNull();
    expect(within(row as HTMLElement).getByText(/录音中/)).toBeInTheDocument();
  });

  it("a non-restart field stays editable while recording", () => {
    recording.state = "recording";
    const { getByText } = wrap("/settings/transcription");
    const row = getByText(translate("zh", "settings.transcription.realtime.label")).closest(".row")!;
    expect(within(row as HTMLElement).getByRole("switch")).toBeInTheDocument();
  });

  it("a successful save shows an undo toast whose 撤销 re-commits the previous value", async () => {
    const { getByText, getByTestId } = wrap("/settings/transcription");
    const row = getByText(translate("zh", "settings.transcription.realtime.label")).closest(".row")!;
    within(row as HTMLElement).getByRole("switch").click();
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "transcription.realtime_enabled", value: false })));
    const toast = await waitFor(() => getByTestId("undo-toast"));
    configUpdateSpy.mockClear();
    fireEvent.click(within(toast).getByText("撤销"));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "transcription.realtime_enabled", value: true })));
  });
});
