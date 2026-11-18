vi.mock("../../../web/src/components/PermissionsPanel.js", () => ({ PermissionsPanel: () => null, PermissionReminder: () => null }));
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, within, waitFor, fireEvent } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Navigate, Outlet } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// config.schema metadata used by the category list + detail. Shape mirrors the
// server's SettingMeta (registry entry minus the Zod validate field).
const shortcutEditingMock = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

const SCHEMA = [
  { path: "ui.show_dock_icon", category: "general", label: "Show Dock icon", type: "toggle", reload: { kind: "none" } },
  { path: "ui.show_menu_bar_icon", category: "general", label: "Show menu bar icon", type: "toggle", reload: { kind: "none" } },
  { path: "audio.mic_device",         category: "audio",         label: "麦克风设备", type: "select", reload: { kind: "none" } },
  { path: "audio.output_dir",         category: "audio",         label: "录音输出目录", type: "path", reload: { kind: "none" } },
  { path: "transcription.engine",     category: "transcription", label: "音频引擎",  type: "select", reload: { kind: "none" } },
  { path: "transcription.language",   category: "transcription", label: "语言",      type: "select", reload: { kind: "none" } },
  { path: "llm.enabled",              category: "llm",           label: "启用 LLM",  type: "toggle", reload: { kind: "none" } },
  { path: "status_agent.enabled",     category: "general",       label: "菜单栏 Agent", type: "toggle", reload: { kind: "none" } },
  { path: "status_agent.feedback_sounds", category: "voice",     label: "听写提示音", type: "toggle", reload: { kind: "none" } },
  { path: "status_agent.voice_input_mode", category: "voice", label: "快捷键操作", type: "select", reload: { kind: "sighup", daemons: ["statusagent"] } },
  { path: "status_agent.hotkeys",     category: "voice",         label: "语音输入快捷键", type: "text", reload: { kind: "sighup", daemons: ["statusagent"] } },
  { path: "transcription.dictation",  category: "voice",         label: "语音输入模板", type: "text", reload: { kind: "none" } },
  { path: "meeting_detection.enabled", category: "automation", label: "会议检测", type: "toggle", reload: { kind: "restart", daemons: ["detector"] } },
];

interface ConfigUpdateResult {
  daemonsNeedingRestart: string[];
  daemonsNeedingSighup: string[];
  applyErrors?: string[];
}

// Shared spy so tests can assert config.update was called on a field edit.
// vi.hoisted keeps it available inside the hoisted vi.mock factory below.
const { configUpdateSpy, promptsListSpy, previewSoundSpy, restartSpy, recording, statusAgent, mcp, dictationText } = vi.hoisted(() => ({
  // What the Host reports for the explicit dictation text selection (ADR-010).
  dictationText: {
    status: {
      provider: "none" as "none" | "xai",
      model: "grok-4.6",
      audioEngine: "local" as "local" | "xai",
      credentialSource: null as "oauth" | "api-key" | null,
      disclosure: { accepted: false, disclosureVersion: "xai-dictation-text-v1" },
      active: false,
    },
    acceptDisclosure: vi.fn(async () => ({ accepted: true, disclosureVersion: "xai-dictation-text-v1" })),
    invalidate: vi.fn(async () => undefined),
  },
  mcp: {
    status: {
      available: true,
      agents: [
        { id: "claude", detected: true, configured: null as boolean | null },
        { id: "codex", detected: true, configured: false as boolean | null },
        { id: "hermes", detected: false, configured: false as boolean | null },
      ],
    },
    install: vi.fn((_vars: { agent: string }, opts?: { onSuccess?: (result: { ok: boolean }) => void }) => opts?.onSuccess?.({ ok: true })),
    test: vi.fn(),
  },
  configUpdateSpy: vi.fn(async (_vars: { key: string; value: unknown }): Promise<ConfigUpdateResult> => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] })),
  promptsListSpy: vi.fn(),
  previewSoundSpy: vi.fn(),
  restartSpy: vi.fn(async (_vars: { name: string }) => ({ ok: true })),
  recording: { state: "idle" as string },
  statusAgent: { state: "running" as string },
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
      engine: "local",
      language: "auto",
      dictation: { prompt_slug: "dictation-cleanup", translate_prompt_slug: "dictation-translate", target_language: "English" },
    },
    intelligence: {
      summary: { provider: "agent", model: "runtime-managed" },
    },
    llm: { enabled: false, command: [] },
    status_agent: {
      enabled: false,
      feedback_sounds: true,
      hotkeys: {
        dictate: { key: "Space", modifiers: ["ctrl", "alt"] },
        translate: { key: "T", modifiers: ["ctrl", "alt"] },
        // A config written before the ask-the-assistant shortcut was retired.
        voice_chat: { key: "A", modifiers: ["ctrl", "alt"] },
      },
    },
    calendars: [],
    agent_pipeline: { auto_send_notion: false },
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
    localCaption: { status: { invalidate: () => {} } },
    xaiAudio: { status: { invalidate: () => {} } },
    agentConnections: { view: { invalidate: () => Promise.resolve() } },
    integrations: { calendarSources: { invalidate: () => Promise.resolve() } },
    dictationText: { status: { invalidate: dictationText.invalidate } },
    onboarding: { status: { invalidate: () => Promise.resolve() } },
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
      daemons: {
        health: { useQuery: () => ({ data: [
          { name: "com.yulu.statusagent", status: statusAgent.state, pid: statusAgent.state === "running" ? 123 : 0, exitStatus: 0, lastLog: "Ready" },
        ] }) },
        restart: { useMutation: (opts?: { onSuccess?: (res: unknown, vars: { name: string }) => void }) => ({
          mutateAsync: async (vars: { name: string }) => {
            const result = await restartSpy(vars);
            opts?.onSuccess?.(result, vars);
            return result;
          },
          isPending: false,
        }) },
      },
      scheduler: { overview: { useQuery: () => ({ data: { updatedAt: "", schedulerStatus: null, calendarStatus: null } }) } },
      recording: {
        shortcutEditing: { useMutation: () => ({ mutateAsync: shortcutEditingMock, isPending: false }) },
        state: { useQuery: () => ({ data: { state: recording.state } }) },
        history: { useQuery: () => ({ data: [
          { id: "h1", action: "dictate", text: "把评审挪到周四下午", createdAt: "2026-11-17T15:02:00+08:00" },
          { id: "h2", action: "translate", targetLanguage: "English", text: "Move the review to Thursday.", rawText: "把评审挪到周四。", createdAt: "2026-11-17T11:40:00+08:00" },
        ] }) },
        previewSound: { useMutation: (opts?: { onError?: (error: Error) => void }) => ({
          mutate: () => {
            try { previewSoundSpy(); }
            catch (error) { opts?.onError?.(error as Error); }
          },
          isPending: false,
        }) },
      },
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
        test: { useMutation: noopMutation },
        accountList: { useQuery: () => ({ data: { ok: true, accounts: [] }, isPending: false }) },
        calendarList: { useQuery: () => ({ data: { ok: true, calendars: [] }, isPending: false }) },
        calendarSources: { useQuery: () => ({
          data: {
            selectedSource: null,
            sources: [
              { id: "macos", label: "macOS Calendar", recommended: true, advanced: false, externalRuntime: false },
              { id: "gog", label: "Google Calendar via gog", recommended: false, advanced: true, externalRuntime: true },
            ],
            readiness: { status: "untested", source: null, reason: null, detail: "Not tested", remediation: "Select a source", evidence: null },
          },
          isPending: false,
          isError: false,
        }) },
        selectCalendarSource: { useMutation: noopMutation },
        probeCalendarSource: { useMutation: noopMutation },
      },
      onboarding: {
        status: { useQuery: () => ({ data: { optionalCapabilities: [
          { id: "calendar-source", outcome: null },
          { id: "agent-calendar-connector", outcome: null },
        ] } }) },
        adoptCalendarSource: { useMutation: noopMutation },
        deferOptionalCapability: { useMutation: noopMutation },
      },
      dictationText: {
        status: { useQuery: () => ({ data: dictationText.status, isPending: false }) },
        acceptDisclosure: { useMutation: () => ({ mutateAsync: dictationText.acceptDisclosure, isPending: false }) },
      },
      mcpAgents: {
        status: { useQuery: () => ({ data: mcp.status, isPending: false }) },
        install: { useMutation: () => ({ mutate: mcp.install, isPending: false, variables: undefined }) },
        test: { useMutation: () => ({ mutate: mcp.test, isPending: false, data: undefined }) },
      },
      agentConnections: {
        view: { useQuery: () => ({
          data: {
            connections: [],
            candidates: [],
            legacyConnections: [],
            selections: {
              transcription: { connectionId: null, model: "local" },
              summary: { connectionId: null, model: "grok-4.6" },
            },
          },
          isPending: false,
          isError: false,
          refetch: async () => ({ data: undefined }),
        }) },
        saveGateway: { useMutation: noopMutation },
        refreshCandidates: { useMutation: noopMutation },
        startNativeAuthorization: { useMutation: noopMutation },
        refreshNativeAuthorizationStatus: { useMutation: noopMutation },
        confirmCandidate: { useMutation: noopMutation },
        select: { useMutation: noopMutation },
        selectCredentialSource: { useMutation: noopMutation },
        probe: { useMutation: noopMutation },
        acceptDisclosure: { useMutation: noopMutation },
        restoreDirectXai: { useMutation: noopMutation },
        authorize: { useMutation: noopMutation },
        cancelAuthorization: { useMutation: noopMutation },
        logoutOAuth: { useMutation: noopMutation },
        setApiKey: { useMutation: noopMutation },
        clearApiKey: { useMutation: noopMutation },
        deletionImpact: { useMutation: noopMutation },
        remove: { useMutation: noopMutation },
      },
      sharing: {
        view: { useQuery: () => ({
          data: {
            connections: [],
            selection: null,
            connectorDiscovery: { status: "untested", detail: "Not tested", remediation: "", options: [] },
            connectorReadiness: { status: "untested", detail: "Not tested", remediation: "" },
            destination: { configured: false, value: "", savedAt: null },
            sharingReadiness: {
              status: "untested",
              detail: "Not tested",
              remediation: "",
              receipt: null,
              actionId: null,
              action: null,
              duplicateWarningRequired: false,
            },
          },
          isPending: false,
          isError: false,
        }) },
        select: { useMutation: noopMutation },
        discover: { useMutation: noopMutation },
        probe: { useMutation: noopMutation },
        saveDestination: { useMutation: noopMutation },
        testShare: { useMutation: noopMutation },
        reconcileUnknown: { useMutation: noopMutation },
        abandonUnknown: { useMutation: noopMutation },
      },
      localCaption: {
        status: { useQuery: () => ({ data: {
          installed: false,
          ready: false,
          operation: "idle",
          runtimeBytes: 0,
          modelBytes: 0,
          sessionActive: false,
          message: null,
          error: null,
        } }) },
        install: { useMutation: noopMutation },
        uninstall: { useMutation: noopMutation },
        test: { useMutation: noopMutation },
      },
      xaiAudio: {
        status: { useQuery: () => ({ data: {
          connected: false,
          detail: "需要在 Yulu 中授权 xAI",
          authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
        }, error: null }) },
        authorize: { useMutation: noopMutation },
        cancelAuthorization: { useMutation: noopMutation },
        logout: { useMutation: noopMutation },
        test: { useMutation: noopMutation },
      },
      providers: {
        status: { useQuery: () => ({ data: {
          connection: {
            connected: false,
            source: null,
            oauthConnected: false,
            apiKeyConfigured: false,
            detail: "需要在 Yulu 中连接 xAI",
            authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
          },
          readiness: {
            transcription: { capability: "transcription", status: "untested", model: "speech-to-text", testedAt: null, detail: "尚未测试", credentialSource: null },
            summary: { capability: "summary", status: "untested", model: "grok-4.6", testedAt: null, detail: "尚未测试", credentialSource: null },
          },
        }, error: null }) },
        authorize: { useMutation: noopMutation },
        cancelAuthorization: { useMutation: noopMutation },
        logoutOAuth: { useMutation: noopMutation },
        setApiKey: { useMutation: noopMutation },
        clearApiKey: { useMutation: noopMutation },
        probe: { useMutation: noopMutation },
        acceptDataPathDisclosure: { useMutation: noopMutation },
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
      },
    },
    makeTrpcClient: () => ({}),
  };
});

import { SettingsLayout, SettingsIndex } from "../../../web/src/routes/settings.js";
import { SettingsCategory } from "../../../web/src/routes/settings.$category.js";
import { SettingsNav } from "../../../web/src/components/SettingsNav.js";
import { CATEGORIES } from "../../../web/src/components/settings/categories.js";
import { translate, LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";
import { UndoToastProvider } from "../../../web/src/components/UndoToast.js";
import { ThemeProvider } from "../../../web/src/theme.js";

// The shell as Settings sees it: its list in the left pane, the page beside it.
function Shell() {
  return (
    <>
      <aside className="root-pane"><SettingsNav returnTo="/inbox/Standup_20260102_090000" /></aside>
      <main className="root-body"><Outlet /></main>
    </>
  );
}

function routesTree() {
  return [
    {
      path: "/",
      Component: Shell,
      children: [
        {
          path: "settings",
          Component: SettingsLayout,
          children: [
            { index: true, Component: SettingsIndex },
            { path: ":category", Component: SettingsCategory },
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
        <UndoToastProvider>
          <QueryClientProvider client={qc}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </UndoToastProvider>
      </LanguageProvider>
    </ThemeProvider>
  );
  return { ...result, router };
}

describe("Settings navigation", () => {
  it("renders the settings list beside one reading column", () => {
    const { container } = wrap();
    expect(container.querySelector(".root-pane .settings-nav")).not.toBeNull();
    expect(container.querySelector(".root-body > .settings-page.page")).not.toBeNull();
    // The page itself carries no second navigation.
    expect(container.querySelector(".settings-page nav")).toBeNull();
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

  it("lists every settings page in three quiet groups, and a way back", () => {
    const { container } = wrap();
    const nav = container.querySelector(".settings-nav") as HTMLElement;
    expect([...nav.querySelectorAll(".settings-nav-group")].map((group) =>
      [...group.querySelectorAll("a")].map((link) => link.textContent))).toEqual([
      ["通用", "录音与摘要", "会议提醒", "语音输入", "连接"],
      ["模板", "术语表"],
      ["运行状态"],
    ]);
    expect(within(nav).getByRole("link", { name: "返回录音" })).toHaveAttribute("href", "/inbox/Standup_20260102_090000");
    expect(within(nav).queryByText(/助手|Agent Console/)).toBeNull();
  });

  it("titles the page with its category", () => {
    const { container } = wrap("/settings/audio");
    expect(within(container.querySelector(".settings-page") as HTMLElement).getByRole("heading", { level: 1 }))
      .toHaveTextContent("录音与摘要");
  });

  it("marks the active category nav for the current route", () => {
    const { getAllByTestId } = wrap("/settings/audio");
    const active = getAllByTestId("settings-category").filter((n) => n.classList.contains("active"));
    expect(active.length).toBe(1);
    expect(active[0]!.getAttribute("href")).toBe("/settings/recording");
  });

  it("uses the responsive settings index", () => {
    const settingsRoute = routesTree()[0]!.children!.find((route) => route.path === "settings")!;
    expect(settingsRoute.children![0]!.Component).toBe(SettingsIndex);
  });

  it("renders the automation (meeting detection) section", () => {
    const { container } = wrap("/settings/automation");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    // The section <h2> heading (distinct from the detail's <h1> title, which the
    // category label also renders as "自动化").
    expect(container.querySelector("#automation h2")?.textContent).toBe(translate("zh", "settings.automation.heading"));
    expect(detail.getByText(translate("zh", "settings.automation.enabled.label"))).toBeInTheDocument();
  });
});

describe("Settings category detail content (re-homed widgets)", () => {
  beforeEach(() => {
    statusAgent.state = "running";
    previewSoundSpy.mockReset();
  });

  it("general: one appearance control, about, and collapsed diagnostics", () => {
    const { container } = wrap("/settings/general");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    expect(detail.getByText(translate("zh", "settings.capabilities.heading"))).toBeInTheDocument();
    // Theme controls are re-homed here.
    expect(container.querySelector('[role="group"][aria-label="主题"]')).toBeNull();
    expect(detail.getByText(translate("zh", "settings.capabilities.heading")).closest("details")).not.toHaveAttribute("open");
    expect(container.querySelector('[role="group"][aria-label="主题明暗模式"]')).not.toBeNull();
    expect(container.querySelector('[role="group"][aria-label="主题家族"]')).not.toBeNull();
    expect(detail.queryByText(translate("zh", "settings.hotkey.statusAgent.label"))).toBeNull();
    // P3-1: the read-only About block (version + install source) lives in general.
    expect(detail.getByText(translate("zh", "settings.about.heading"))).toBeInTheDocument();
    expect(detail.getByText("0.8.0")).toBeInTheDocument();
  });

  it("general: exposes persistent Onboarding Home re-entry", () => {
    const { container } = wrap("/settings/general");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    expect(detail.getByRole("link", { name: "打开新手引导" })).toHaveAttribute("href", "/onboarding");
  });

  it("audio: audio rows + storage dbStats/logs", () => {
    const { container } = wrap("/settings/audio");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
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

  it("transcription: shows explicit local/xAI engine selection", () => {
    const { container } = wrap("/settings/transcription");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    // Section <h2> heading is distinct from the detail <h1> title (the category
    // label also renders "转写").
    expect(container.querySelector("#transcription h2")?.textContent).toBe(translate("zh", "settings.transcription.heading"));
    expect(detail.getByText(translate("zh", "settings.transcription.engine.label"))).toBeInTheDocument();
    expect(detail.getByText(translate("zh", "settings.transcription.language.label"))).toBeInTheDocument();
    expect(detail.queryByText(translate("zh", "settings.providers.connection.title"))).toBeNull();
    expect(detail.queryByText(/MLX|说话人分离/)).toBeNull();
  });

  it.each([
    ["快捷键操作", "按一下开始，再按一下结束", "hold", "status_agent.voice_input_mode"],
  ])("voice: saves %s through the existing config controls", async (label, initial, value, key) => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.getByRole("button", { name: label })).toHaveTextContent(initial);
    fireEvent.click(voice.getByRole("button", { name: label }));
    fireEvent.change(voice.getByRole("combobox", { name: label }), { target: { value } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith({ key, value }));
  });

  it("voice: hotkey capture commits key and modifiers from the pressed shortcut", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    fireEvent.click(voice.getByLabelText("听写快捷键 更改"));
    await waitFor(() => expect(voice.getByText(translate("zh", "settings.voice.hotkey.capture"))).toBeInTheDocument());
    fireEvent.keyDown(window, { key: "F1", ctrlKey: true, altKey: true });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith({
      key: "status_agent.hotkeys.dictate",
      value: { key: "F1", modifiers: ["alt", "ctrl"] },
    }));
    expect(configUpdateSpy).toHaveBeenCalledOnce();
  });

  it("voice: Escape cancels shortcut capture without changing the saved key", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    const change = voice.getByLabelText("听写快捷键 更改");
    fireEvent.click(change);
    await waitFor(() => expect(change).toHaveAttribute("aria-pressed", "true"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(change).toHaveAttribute("aria-pressed", "false");
    expect(change).toHaveFocus();
    expect(configUpdateSpy).not.toHaveBeenCalled();
  });

  it("voice: offers dictation and translation shortcuts, and nothing for asking an assistant", () => {
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.getByLabelText("听写快捷键 更改")).toBeInTheDocument();
    expect(voice.getByLabelText("翻译快捷键 更改")).toBeInTheDocument();
    expect(container.querySelectorAll(".voice-hotkey-capture")).toHaveLength(2);
    expect(voice.queryByText(/问 Agent|提问/)).toBeNull();
  });

  it("voice: keeps recent dictation on the same page, with the original one step away", () => {
    const { container } = wrap("/settings/voice");
    const history = within(container.querySelector("#voice-history") as HTMLElement);
    expect(history.getByRole("heading", { name: "最近的输入" })).toBeInTheDocument();
    expect(history.getByText("把评审挪到周四下午")).toBeInTheDocument();
    expect(history.getByText("Move the review to Thursday.")).toBeInTheDocument();
    expect(history.getByText("把评审挪到周四。").closest("details")).not.toHaveAttribute("open");
    expect(history.getAllByRole("button", { name: "复制" })).toHaveLength(2);
  });

  it("voice: shows configured state separately from the live StatusAgent state", () => {
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.getByText(translate("zh", "settings.voice.statusAgent.disabledRunning"))).toBeInTheDocument();
  });

  it("voice: feedback sound toggle and preview are wired", async () => {
    configUpdateSpy.mockClear();
    previewSoundSpy.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    fireEvent.click(voice.getByRole("switch", { name: "听写提示音" }));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "status_agent.feedback_sounds",
      value: false,
    })));
    fireEvent.click(voice.getByRole("button", { name: "试听" }));
    expect(previewSoundSpy).toHaveBeenCalledTimes(1);
  });

  it("voice: disables preview while StatusAgent is stopped", () => {
    statusAgent.state = "stopped";
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.getByRole("button", { name: "试听" })).toBeDisabled();
  });

  it("voice: surfaces preview IPC failures", async () => {
    previewSoundSpy.mockImplementationOnce(() => { throw new Error("status agent offline"); });
    const { container, getByTestId } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    fireEvent.click(voice.getByRole("button", { name: "试听" }));
    await waitFor(() => expect(getByTestId("settings-error-toast")).toHaveTextContent("status agent offline"));
  });

  it("voice: replaces the legacy dictation template selector with cleanup settings", () => {
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.queryByText("听写模板")).not.toBeInTheDocument();
    expect(voice.queryByText("Dictation Cleanup")).not.toBeInTheDocument();
    expect(voice.getByRole("switch", { name: translate("zh", "settings.voice.cleanupEnabled") })).toBeInTheDocument();
  });

  it("voice: sends dictated text to xAI only after its disclosure is accepted on this page", async () => {
    configUpdateSpy.mockClear();
    dictationText.acceptDisclosure.mockClear();
    dictationText.invalidate.mockClear();
    const { container } = wrap("/settings/voice");
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    const cleanup = voice.getByRole("switch", { name: translate("zh", "settings.voice.textProvider") });
    expect(cleanup).not.toBeChecked();
    expect(voice.getByText(translate("zh", "settings.voice.textOff"))).toBeInTheDocument();

    fireEvent.click(cleanup);
    expect(voice.getByText(translate("zh", "settings.voice.textDisclosure.body"))).toBeInTheDocument();
    expect(dictationText.acceptDisclosure).not.toHaveBeenCalled();
    expect(configUpdateSpy).not.toHaveBeenCalled();

    fireEvent.click(voice.getByRole("button", { name: translate("zh", "settings.voice.textDisclosure.accept") }));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith({
      key: "transcription.dictation.text_provider",
      value: "xai",
    }));
    expect(dictationText.acceptDisclosure).toHaveBeenCalledOnce();
    expect(dictationText.acceptDisclosure.mock.invocationCallOrder[0]!)
      .toBeLessThan(configUpdateSpy.mock.invocationCallOrder[0]!);
    await waitFor(() => expect(dictationText.invalidate).toHaveBeenCalled());
  });

  it("voice: translation only requires a target language and does not load templates", () => {
    promptsListSpy.mockClear();
    const { container } = wrap("/settings/voice");
    expect(promptsListSpy).not.toHaveBeenCalledWith({ category: "voice" });
    const voice = within(container.querySelector("#voice-input") as HTMLElement);
    expect(voice.queryByText("翻译偏好")).not.toBeInTheDocument();
    expect(voice.queryByText("翻译模板")).not.toBeInTheDocument();
    expect(voice.queryByRole("link", { name: "管理模板" })).not.toBeInTheDocument();
    expect(voice.getByRole("button", { name: "翻译目标语言" })).toBeInTheDocument();
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

  it("connections: registers Yulu with the Agents found on this Mac", () => {
    mcp.install.mockClear();
    const { container } = wrap("/settings/connections");
    const section = within(container.querySelector("#mcp-agents") as HTMLElement);
    expect(section.getByRole("heading", { name: "接入 Agent" })).toBeInTheDocument();
    // Only detected Agents are offered; Hermes is not installed here.
    expect([...container.querySelectorAll("#mcp-agents .row-label")].map((label) => label.textContent))
      .toEqual(["Claude Code", "Codex"]);
    expect(container.querySelector('#mcp-agents [data-agent="codex"] .mcp-agent-state')).toHaveTextContent("未接入");

    fireEvent.click(section.getByRole("button", { name: "接入 Codex" }));
    expect(mcp.install).toHaveBeenCalledWith({ agent: "codex" }, expect.any(Object));
    expect(container.querySelector('#mcp-agents [data-agent="codex"] .mcp-agent-state')).toHaveTextContent("已接入");
    expect(section.getByRole("button", { name: "测试 Codex" })).toBeInTheDocument();
  });

  it("connections: says so when the Agent list cannot be read", () => {
    const saved = mcp.status.available;
    mcp.status.available = false;
    const { container } = wrap("/settings/connections");
    expect(within(container.querySelector("#mcp-agents") as HTMLElement).getByRole("alert")).toBeInTheDocument();
    expect(container.querySelector("#mcp-agents .row")).toBeNull();
    mcp.status.available = saved;
  });

  it("llm: hosts AI services for transcription and summary only", () => {
    const { container } = wrap("/settings/llm");
    const detail = within(container.querySelector("#ai-connections") as HTMLElement);
    expect(detail.getByRole("heading", { name: translate("zh", "agentConnections.title") }))
      .toBeInTheDocument();
    expect([...container.querySelectorAll("#ai-connections .agent-usage-row strong")].map((item) => item.textContent))
      .toEqual(["转写", "摘要"]);
  });

  it("sharing: reaches the reusable Sharing configuration surface from Settings", () => {
    const { container } = wrap("/settings/sharing");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    expect(detail.getByRole("heading", { name: translate("zh", "sharing.title") }))
      .toBeInTheDocument();
    expect(detail.getByText(translate("zh", "sharing.noConnections"))).toBeInTheDocument();
    expect(container.querySelector("#sharing details")).toHaveAttribute("open");
  });

  it("integrations: hosts authoritative Calendar Sources without an Agent calendar connector", () => {
    const { container } = wrap("/settings/integrations");
    const detail = within(container.querySelector(".settings-page") as HTMLElement);
    expect(detail.getByRole("heading", { name: translate("zh", "settings.calendarSource.heading") }))
      .toBeInTheDocument();
    expect(container.querySelector('a[href*="agent-calendar-connector"]')).toBeNull();
  });

  it("does not list the retired local transcription Advanced category", () => {
    expect(CATEGORIES.map((category) => String(category.id))).not.toContain("advanced");
  });

  it("commits a field edit through trpc.config.update", async () => {
    configUpdateSpy.mockClear();
    const { container } = wrap("/settings/transcription");
    const row = within(container.querySelector("#transcription") as HTMLElement)
      .getByText(translate("zh", "settings.transcription.language.label"))
      .closest(".row")!;
    fireEvent.click(within(row as HTMLElement).getByText("自动识别"));
    fireEvent.change(within(row as HTMLElement).getByRole("combobox"), { target: { value: "zh" } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({
      key: "transcription.language",
      value: "zh",
    })));
  });
});

describe("Settings — recording-guard + undo (Task 5)", () => {
  beforeEach(() => {
    recording.state = "idle";
    configUpdateSpy.mockClear();
    restartSpy.mockClear();
  });

  it("both icon toggles stay editable during recording and explain how to reopen", async () => {
    recording.state = "recording";
    const { getByRole, getByText } = wrap("/settings/general");
    const dock = getByRole("switch", { name: "显示 Dock 图标" });
    const menu = getByRole("switch", { name: "显示菜单栏图标" });
    expect(dock).toHaveAttribute("aria-checked", "true");
    expect(menu).toHaveAttribute("aria-checked", "true");
    fireEvent.click(dock);
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith({ key: "ui.show_dock_icon", value: false }));
    fireEvent.click(menu);
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith({ key: "ui.show_menu_bar_icon", value: false }));
    expect(configUpdateSpy).toHaveBeenCalledTimes(2);
    expect(restartSpy).not.toHaveBeenCalled();
    expect(getByText(/即使两个图标都隐藏/)).toBeVisible();
  });

  it("while recording, a restart-class field is locked (disabled, not editable)", () => {
    recording.state = "recording";
    const { container } = wrap("/settings/automation");
    const automation = container.querySelector("#automation") as HTMLElement;
    const row = within(automation).getByText(translate("zh", "settings.automation.enabled.label")).closest(".row")!;
    expect(within(row as HTMLElement).queryByRole("switch")).toBeNull();
    expect(within(row as HTMLElement).getByText(/录音中/)).toBeInTheDocument();
  });

  it("a non-restart field stays editable while recording", () => {
    recording.state = "recording";
    const { getByText } = wrap("/settings/transcription");
    const row = getByText(translate("zh", "settings.transcription.language.label")).closest(".row")!;
    expect(within(row as HTMLElement).getByText("自动识别")).toBeInTheDocument();
    expect(within(row as HTMLElement).queryByText(/录音中不可改/)).toBeNull();
  });

  it("a successful save shows an undo toast whose 撤销 re-commits the previous value", async () => {
    const { getByText, getByTestId } = wrap("/settings/transcription");
    const row = getByText(translate("zh", "settings.transcription.language.label")).closest(".row")!;
    fireEvent.click(within(row as HTMLElement).getByText("自动识别"));
    fireEvent.change(within(row as HTMLElement).getByRole("combobox"), { target: { value: "zh" } });
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "transcription.language", value: "zh" })));
    const toast = await waitFor(() => getByTestId("undo-toast"));
    configUpdateSpy.mockClear();
    fireEvent.click(within(toast).getByText("撤销"));
    await waitFor(() => expect(configUpdateSpy).toHaveBeenCalledWith(expect.objectContaining({ key: "transcription.language", value: "auto" })));
  });

  it("shows a visible error when a requested daemon restart fails", async () => {
    configUpdateSpy.mockResolvedValueOnce({ daemonsNeedingRestart: ["detector"], daemonsNeedingSighup: [] });
    restartSpy.mockRejectedValueOnce(new Error("launchctl load failed"));
    const { container, getByText, getByTestId } = wrap("/settings/automation");
    const automation = within(container.querySelector("#automation") as HTMLElement);
    fireEvent.click(automation.getByRole("switch", { name: translate("zh", "settings.automation.enabled.label") }));
    await waitFor(() => getByText(translate("zh", "restartBanner.restartNow")));
    fireEvent.click(getByText(translate("zh", "restartBanner.restartNow")));
    await waitFor(() => expect(getByTestId("settings-error-toast")).toHaveTextContent("launchctl load failed"));
  });
});
