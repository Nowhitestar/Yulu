import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

interface ActivatedData {
  state: "activated";
  guidedCompletionPending?: boolean;
  guidedCompletion?: { taskId: string; recordingStem: string } | null;
  evidence: {
    recordingStem: string;
    taskId: string;
    transcriptionProvider: string;
    summaryProvider: string;
    summaryModel: string;
    artifacts: {
      audio: { sha256: string; bytes: number };
      transcript: { sha256: string; bytes: number };
      summary: { sha256: string; bytes: number };
    };
    completedAt: string;
  };
  sourceArtifacts: { audio: boolean; transcript: boolean; summary: boolean };
  completedNoteAvailable: boolean;
  completedNote: string | null;
}

interface AttemptData {
  state: "recording" | "processing";
  evidence: null;
  attempt: {
    id: string;
    startedAt: string;
    stopRequestedAt?: string | null;
    handoffError?: string | null;
    taskId: string | null;
    recordingStem: string | null;
  };
  task: {
    id: string;
    state: string;
    phase: string;
    error: string | null;
    summaryProvider?: string;
    summaryModel?: string;
  } | null;
  journey: UnresolvedData["journey"];
  backgroundEvidence?: ActivatedData["evidence"] | null;
  blocker?: {
    capability: "audio" | "transcription" | "credential" | "model" | "provider" | "summary" |
      "recording_pipeline";
    detail: string | null;
    retry: "same_task" | "same_audio" | "start_recording" | "rerecord" | "new_summary_attempt";
    remediation: { href: string };
  } | null;
  summaryRecovery?: {
    selected: { provider: string; model: string };
    state: "ready" | "blocked" | "disclosure_required";
    detail: string | null;
    remediation: { href: string } | null;
    canReplace: boolean;
  } | null;
}

interface UnresolvedData {
  state: "unresolved";
  evidence: null;
  nextStep: "microphone_permission" | "audio_input" | "transcription" | "summary_provider" |
    "recording_pipeline" | null;
  blocker: {
    capability: "microphone_permission" | "audio_input" | "local_transcription" | "xai_transcription" |
      "summary_credentials" | "summary_model" | "summary_provider" | "summary_disclosure" |
      "summary_readiness" | "recording_pipeline";
    reason?: "missing_credentials" | "invalid_model" | "provider_unavailable" | "disclosure_required" |
      "disclosure_declined" | "readiness_failed" | "readiness_required";
    detail: string | null;
    remediation: { href: string };
  } | null;
  readiness: {
    microphonePermission: { state: "ready" | "blocked"; detail: string | null; remediation: { href: string } | null };
    audioInput: {
      state: "ready" | "blocked";
      selectedDeviceUid: string | null;
      detail: string | null;
      remediation: { href: string } | null;
    };
    transcription: {
      selected: "local" | "xai";
      state: "ready" | "blocked" | "disclosure_required";
      local: { available: boolean; ready: boolean; detail: string | null };
      xai: {
        ready: boolean;
        detail: string | null;
        disclosureVersion: string;
        acceptedDisclosureVersion: string | null;
        disclosureRequired: boolean;
      };
      remediation: { href: string } | null;
    };
    summary: {
      selected: { provider: string; model: string };
      state: "ready" | "blocked" | "disclosure_required";
      detail: string | null;
      credentialSource: string | null;
      testedAt: string | null;
      disclosure: {
        provider: string;
        disclosureVersion: string;
        acceptedDisclosureVersion: string | null;
        declined: boolean;
        required: boolean;
        data: "transcript_text";
        destination: string;
        connectionId?: string;
      } | null;
      publicOnboardingSupported: boolean;
      remediation: { href: string } | null;
    };
    recordingPipeline: {
      state: "ready" | "blocked";
      enabled: boolean;
      autoProcessRecordings: boolean;
      detail: string | null;
      remediation: { href: string } | null;
    };
  };
  journey: {
    shouldAutoEnter: boolean;
    automaticEntryAcknowledgedAt: string | null;
    deferredAt: string | null;
  };
}

function unresolvedData(): UnresolvedData {
  return {
    state: "unresolved",
    evidence: null,
    nextStep: null,
    blocker: null,
    readiness: {
      microphonePermission: { state: "ready", detail: null, remediation: null },
      audioInput: { state: "ready", selectedDeviceUid: "BuiltInMic", detail: null, remediation: null },
      transcription: {
        selected: "local",
        state: "ready",
        local: { available: true, ready: true, detail: null },
        xai: {
          ready: false,
          detail: "Connect xAI",
          disclosureVersion: "xai-audio-v1",
          acceptedDisclosureVersion: null,
          disclosureRequired: true,
        },
        remediation: null,
      },
      summary: {
        selected: { provider: "xai", model: "grok-summary-exact" },
        state: "ready",
        detail: "ready",
        credentialSource: "oauth",
        testedAt: "2026-08-25T04:00:00.000Z",
        disclosure: {
          provider: "xai",
          disclosureVersion: "xai-summary-v1",
          acceptedDisclosureVersion: "xai-summary-v1",
          declined: false,
          required: false,
          data: "transcript_text",
          destination: "xAI",
        },
        publicOnboardingSupported: true,
        remediation: null,
      },
      recordingPipeline: {
        state: "ready",
        enabled: true,
        autoProcessRecordings: true,
        detail: null,
        remediation: null,
      },
    },
    journey: {
      shouldAutoEnter: false,
      automaticEntryAcknowledgedAt: "2026-08-25T04:00:00.000Z",
      deferredAt: null,
    },
  };
}

function activatedData(): ActivatedData {
  return {
    state: "activated" as const,
    evidence: {
      recordingStem: "Planning_20260711_120000",
      taskId: "019f0000-0000-7000-8000-000000000127",
      transcriptionProvider: "local",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
      artifacts: {
        audio: { sha256: "a".repeat(64), bytes: 45 },
        transcript: { sha256: "b".repeat(64), bytes: 20 },
        summary: { sha256: "c".repeat(64), bytes: 30 },
      },
      completedAt: "2026-07-11T12:05:00.000Z",
    },
    sourceArtifacts: { audio: true, transcript: true, summary: true },
    completedNoteAvailable: true,
    completedNote: "# Completed note\n\nVisible body",
  };
}

const activation = vi.hoisted(() => ({
  data: activatedData() as ActivatedData | UnresolvedData | AttemptData,
  startAttempt: vi.fn(async () => ({ state: "recording" })),
  stopAttempt: vi.fn(async () => ({ state: "processing" })),
  retryAttempt: vi.fn(async () => ({ state: "processing" })),
  rerecordAttempt: vi.fn(async () => ({ state: "recording" })),
  replaceSummaryProvider: vi.fn(async () => ({ state: "processing" })),
  acknowledgeGuidedCompletion: vi.fn(async () => ({ acknowledged: true })),
  defer: vi.fn(async () => ({ journey: { shouldAutoEnter: false } })),
  acceptXaiDisclosure: vi.fn(async () => ({ disclosureVersion: "xai-audio-v1" })),
  acceptSummaryDisclosure: vi.fn(async () => ({ disclosureVersion: "xai-summary-v1" })),
  declineSummaryDisclosure: vi.fn(async () => ({ disclosureVersion: "xai-summary-v1", decision: "declined" })),
  probeSummaryProvider: vi.fn(async () => ({ status: "ready" })),
  updateConfig: vi.fn(async () => ({})),
  testLocal: vi.fn(async () => ({ ok: true })),
  probeXai: vi.fn(async () => ({ status: "ready" })),
  createSummaryAttemptFromUnknown: vi.fn(async () => ({ state: "transcript_committed" })),
  selectAgentConnection: vi.fn(async () => ({})),
  acceptAgentConnectionDisclosure: vi.fn(async () => ({})),
  declineAgentConnectionDisclosure: vi.fn(async () => ({})),
  agentConnectionView: { connections: [{ id: "direct-xai" }] },
  summaryActivation: {
    directXaiAvailable: true,
    selected: { connectionId: "direct-xai", provider: "xai", label: "xAI", model: "grok-summary-exact" },
    state: "ready",
    options: [
      { connectionId: "direct-xai", provider: "xai", label: "xAI", model: "grok-summary-exact", selected: true },
      { connectionId: "codex", provider: "codex", label: "Codex", model: "gpt-5.6-sol", selected: false },
      { connectionId: "claude-code", provider: "claude-code", label: "Claude Code", model: "claude-sonnet-5", selected: false },
      { connectionId: "cliproxyapi", provider: "cliproxyapi", label: "CLIProxyAPI", model: "gateway-summary", selected: false },
    ],
  },
  summaryRefetch: vi.fn(async () => ({})),
  refetch: vi.fn(async () => ({})),
  renderStatus: undefined as (() => void) | undefined,
  isPending: false,
  isError: false,
  queryOptions: undefined as { retry?: boolean } | undefined,
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    activation: {
      status: { useQuery: (_input: undefined, options?: { retry?: boolean }) => {
        const [, setVersion] = useState(0);
        activation.renderStatus = () => setVersion((version) => version + 1);
        activation.queryOptions = options;
        return {
          data: activation.data,
          isPending: activation.isPending,
          isError: activation.isError,
          refetch: activation.refetch,
        };
      } },
      startAttempt: { useMutation: () => ({ mutateAsync: activation.startAttempt, isPending: false }) },
      stopAttempt: { useMutation: () => ({ mutateAsync: activation.stopAttempt, isPending: false }) },
      retryAttempt: { useMutation: () => ({ mutateAsync: activation.retryAttempt, isPending: false }) },
      rerecordAttempt: { useMutation: () => ({ mutateAsync: activation.rerecordAttempt, isPending: false }) },
      replaceSummaryProvider: {
        useMutation: () => ({ mutateAsync: activation.replaceSummaryProvider, isPending: false }),
      },
      acknowledgeGuidedCompletion: {
        useMutation: () => ({ mutateAsync: activation.acknowledgeGuidedCompletion, isPending: false }),
      },
      defer: { useMutation: () => ({ mutateAsync: activation.defer, isPending: false }) },
      acceptXaiTranscriptionDisclosure: {
        useMutation: () => ({ mutateAsync: activation.acceptXaiDisclosure, isPending: false }),
      },
      acceptSummaryDataPathDisclosure: {
        useMutation: () => ({ mutateAsync: activation.acceptSummaryDisclosure, isPending: false }),
      },
      declineSummaryDataPathDisclosure: {
        useMutation: () => ({ mutateAsync: activation.declineSummaryDisclosure, isPending: false }),
      },
      probeSummaryProvider: {
        useMutation: () => ({ mutateAsync: activation.probeSummaryProvider, isPending: false }),
      },
    },
    config: {
      update: { useMutation: () => ({ mutateAsync: activation.updateConfig, isPending: false }) },
    },
    localCaption: {
      test: { useMutation: () => ({ mutateAsync: activation.testLocal, isPending: false }) },
    },
    providers: {
      probe: { useMutation: () => ({ mutateAsync: activation.probeXai, isPending: false }) },
    },
    agentConnections: {
      summaryActivation: {
        useQuery: () => ({
          data: activation.summaryActivation,
          isPending: false,
          isError: false,
          refetch: activation.summaryRefetch,
        }),
      },
      view: {
        useQuery: () => ({ data: activation.agentConnectionView, isPending: false, isError: false }),
      },
      select: { useMutation: () => ({ mutateAsync: activation.selectAgentConnection, isPending: false }) },
      probe: { useMutation: () => ({ mutateAsync: activation.probeXai, isPending: false }) },
      acceptDisclosure: {
        useMutation: () => ({ mutateAsync: activation.acceptAgentConnectionDisclosure, isPending: false }),
      },
      declineDisclosure: {
        useMutation: () => ({ mutateAsync: activation.declineAgentConnectionDisclosure, isPending: false }),
      },
    },
    agentTasks: {
      createSummaryAttemptFromUnknown: {
        useMutation: () => ({ mutateAsync: activation.createSummaryAttemptFromUnknown, isPending: false }),
      },
    },
    useUtils: () => ({ activation: { status: { invalidate: activation.refetch } } }),
  },
}));

import { Activate } from "../../../web/src/routes/activate.js";

function renderRoute(lang: "zh" | "en") {
  localStorage.setItem("yulu_ui.lang", lang);
  const router = createMemoryRouter(
    [
      { path: "/activate", element: <Activate /> },
      { path: "/agent-console", element: <h1>Agent Console</h1> },
      { path: "/inbox/:stem", element: <h1>Saved note</h1> },
    ],
    { initialEntries: ["/activate"] },
  );
  const result = render(
    <LanguageProvider>
      <RouterProvider router={router} />
    </LanguageProvider>,
  );
  return { ...result, router };
}

afterEach(() => {
  localStorage.clear();
  activation.data = activatedData();
  activation.defer.mockClear();
  activation.startAttempt.mockClear();
  activation.stopAttempt.mockClear();
  activation.retryAttempt.mockClear();
  activation.rerecordAttempt.mockClear();
  activation.replaceSummaryProvider.mockClear();
  activation.acknowledgeGuidedCompletion.mockClear();
  activation.acceptXaiDisclosure.mockClear();
  activation.acceptSummaryDisclosure.mockClear();
  activation.declineSummaryDisclosure.mockClear();
  activation.probeSummaryProvider.mockClear();
  activation.updateConfig.mockClear();
  activation.testLocal.mockClear();
  activation.probeXai.mockClear();
  activation.createSummaryAttemptFromUnknown.mockClear();
  activation.selectAgentConnection.mockClear();
  activation.acceptAgentConnectionDisclosure.mockClear();
  activation.declineAgentConnectionDisclosure.mockClear();
  activation.refetch.mockClear();
  activation.summaryRefetch.mockClear();
  activation.renderStatus = undefined;
  activation.isPending = false;
  activation.isError = false;
  activation.queryOptions = undefined;
  activation.summaryActivation.selected = {
    connectionId: "direct-xai",
    provider: "xai",
    label: "xAI",
    model: "grok-summary-exact",
  };
});

describe("/activate", () => {
  it("renders localized accessible activation evidence and actions", () => {
    renderRoute("en");

    expect(screen.getByRole("heading", { name: "Yulu is activated" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Core Activation verified");
    expect(screen.getByText("hermes · runtime-managed")).toBeInTheDocument();
    expect(screen.getByText("local")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open completed note" }));
    expect(screen.getByRole("heading", { name: "Completed note" })).toBeInTheDocument();
    expect(screen.getByText("Visible body")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Transcription settings" })).toHaveAttribute(
      "href",
      "/settings/transcription",
    );
    expect(screen.getByRole("link", { name: "AI Provider settings" })).toHaveAttribute(
      "href",
      "/settings/llm",
    );
  });

  it.each([
    ["audio", /原始录音已不存在/],
    ["transcript", /转写文本已不存在/],
    ["summary", /摘要笔记已不存在/],
  ] as const)("explains a missing %s artifact without revoking activated state", (kind, message) => {
    (activation.data as ActivatedData).sourceArtifacts[kind] = false;
    if (kind === "summary") {
      (activation.data as ActivatedData).completedNoteAvailable = false;
      (activation.data as ActivatedData).completedNote = null;
    }
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "Yulu 已激活" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("核心激活证据已验证");
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("shows a named retryable blocker when activation status fails directly", async () => {
    activation.data = undefined as unknown as ActivatedData;
    activation.isError = true;
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "无法检查激活状态" })).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("10 秒");
    expect(activation.queryOptions).toMatchObject({ retry: false });
    await userEvent.click(screen.getByRole("button", { name: "重新检查" }));
    expect(activation.refetch).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "继续使用 Yulu" })).toHaveAttribute("href", "/agent-console");
  });

  it("defers the unresolved journey and exits to the normal product", async () => {
    activation.data = unresolvedData();
    const { router } = renderRoute("en");
    const user = userEvent.setup();

    const heading = screen.getByRole("heading", { name: "Start your Activation Journey" });
    await waitFor(() => expect(heading).toHaveFocus());
    await user.click(screen.getByRole("button", { name: "Do this later" }));

    expect(await screen.findByRole("heading", { name: "Agent Console" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(activation.defer).toHaveBeenCalledOnce();
  });

  it("localizes unresolved direct re-entry in Chinese", () => {
    activation.data = unresolvedData();
    activation.data.journey.automaticEntryAcknowledgedAt = null;
    activation.data.journey.deferredAt = "2026-08-25T04:00:00.000Z";
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "开始激活 Yulu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "稍后再做" })).toBeInTheDocument();
  });

  it("skips every proven readiness step without a terminal spinner", () => {
    activation.data = unresolvedData();
    renderRoute("en");

    expect(screen.getByText("Microphone permission ready")).toBeInTheDocument();
    expect(screen.getByText("Audio input ready")).toBeInTheDocument();
    expect(screen.queryByText(/System Settings.*Microphone/)).not.toBeInTheDocument();
    expect(screen.getByText("Selected transcription ready")).toBeInTheDocument();
    expect(screen.getByText("Selected Summary Provider ready")).toBeInTheDocument();
    expect(screen.getAllByText("xAI").length).toBeGreaterThan(0);
    expect(screen.getByText("grok-summary-exact")).toBeInTheDocument();
    expect(screen.queryByText(/automatic|fallback/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Local transcription" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "xAI cloud transcription" })).not.toBeInTheDocument();
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
    expect(screen.getByText(/10–20 seconds/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start recording" })).toBeInTheDocument();
  });

  it("starts and stops the production Activation Attempt without a synthetic duration gate", async () => {
    activation.data = unresolvedData();
    const user = userEvent.setup();
    let view = renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(activation.startAttempt).toHaveBeenCalledOnce();

    activation.data = {
      state: "recording",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: null,
        recordingStem: null,
      },
      task: null,
      journey: unresolvedData().journey,
    };
    view.unmount();
    view = renderRoute("en");
    expect(screen.getByRole("status")).toHaveTextContent("Recording in progress");
    expect(screen.getByText(/10–20 seconds/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop recording" }));
    expect(activation.stopAttempt).toHaveBeenCalledOnce();
  });

  it("opens the exact guided saved note after a UI reload", async () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "019f0000-0000-7000-8000-000000000131",
        recordingStem: "Activation_20260825_141500",
      },
      task: {
        id: "019f0000-0000-7000-8000-000000000131",
        state: "running",
        phase: "transcribing",
        error: null,
      },
      journey: unresolvedData().journey,
    };
    let view = renderRoute("en");
    expect(screen.getByRole("status")).toHaveTextContent("Transcribing your recording");

    view.unmount();
    activation.data = {
      ...activatedData(),
      guidedCompletionPending: true,
      guidedCompletion: {
        taskId: "019f0000-0000-7000-8000-000000000131",
        recordingStem: "Activation_20260825_141500",
      },
    };
    view = renderRoute("en");
    expect(await screen.findByRole("heading", { name: "Saved note" })).toBeInTheDocument();
    expect(activation.acknowledgeGuidedCompletion).not.toHaveBeenCalled();
    expect(view.router.state.location.pathname).toBe("/inbox/Activation_20260825_141500");
    expect(view.router.state.location.search).toBe(
      "?activation=complete&activationTaskId=019f0000-0000-7000-8000-000000000131",
    );
  });

  it("names paused recording policy before offering Start and links to its controls", () => {
    const data = unresolvedData();
    data.nextStep = "recording_pipeline";
    data.blocker = {
      capability: "recording_pipeline",
      detail: "Automatic recording processing is paused",
      remediation: { href: "/settings/automation" },
    };
    data.readiness.recordingPipeline = {
      state: "blocked",
      enabled: true,
      autoProcessRecordings: false,
      detail: "Automatic recording processing is paused",
      remediation: { href: "/settings/automation" },
    };
    activation.data = data;

    renderRoute("en");

    expect(screen.getByText("Recording processing needs attention")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Automation Settings" })).toHaveAttribute(
      "href",
      "/settings/automation",
    );
    expect(screen.queryByRole("button", { name: "Start recording" })).not.toBeInTheDocument();
  });

  it("announces unrelated evidence without replacing an active guided attempt", () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "guided-task",
        recordingStem: "Guided_20260825_141500",
      },
      task: {
        id: "guided-task",
        state: "running",
        phase: "transcribing",
        error: null,
      },
      journey: unresolvedData().journey,
      backgroundEvidence: activatedData().evidence,
    };
    const view = renderRoute("en");

    expect(screen.getByText("Transcribing your recording")).toBeInTheDocument();
    expect(screen.getByText("Core Activation is complete.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open saved note" })).toHaveAttribute(
      "href",
      "/inbox/Planning_20260711_120000",
    );
    expect(view.router.state.location.pathname).toBe("/activate");
    expect(activation.acknowledgeGuidedCompletion).not.toHaveBeenCalled();
  });

  it("retries the original snapshot or explicitly starts a ready replacement summary attempt", async () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "019f0000-0000-7000-8000-000000000131",
        recordingStem: "Activation_20260825_141500",
      },
      task: {
        id: "019f0000-0000-7000-8000-000000000131",
        state: "awaiting_provider",
        phase: "failed",
        error: "Pinned Summary Provider is unavailable",
      },
      journey: unresolvedData().journey,
      blocker: {
        capability: "provider",
        detail: "Pinned Summary Provider is unavailable",
        retry: "same_task",
        remediation: { href: "/settings/llm?capability=summary" },
      },
      summaryRecovery: {
        selected: { provider: "xai", model: "grok-new-explicit" },
        state: "ready",
        detail: "ready",
        remediation: null,
        canReplace: true,
      },
    };
    renderRoute("en");
    const user = userEvent.setup();

    expect(screen.getByRole("alert")).toHaveTextContent("Summary Provider blocked activation");
    expect(screen.getByText("Pinned Summary Provider is unavailable")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open AI Provider Settings" })).toHaveAttribute("href", "/settings/llm?capability=summary");
    await user.click(screen.getByRole("button", { name: "Retry saved work" }));
    expect(activation.retryAttempt).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Use xai · grok-new-explicit" }));
    expect(activation.replaceSummaryProvider).toHaveBeenCalledOnce();
  });

  it("labels a pre-transcript credential remediation by its transcription destination", () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-transcription-credential",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "task-transcription-credential",
        recordingStem: "Activation_20260825_141500",
      },
      task: {
        id: "task-transcription-credential",
        state: "failed",
        phase: "failed",
        error: "xAI transcription failed (HTTP 401)",
      },
      journey: unresolvedData().journey,
      blocker: {
        capability: "credential",
        detail: "xAI transcription failed (HTTP 401)",
        retry: "same_task",
        remediation: { href: "/settings/llm?connection=direct-xai&capability=transcription" },
      },
    };
    renderRoute("en");

    expect(screen.getByRole("link", { name: "Open Transcription Settings" }))
      .toHaveAttribute("href", "/settings/llm?connection=direct-xai&capability=transcription");
    expect(screen.queryByRole("link", { name: "Open AI Provider Settings" })).not.toBeInTheDocument();
  });

  it("offers an explicit new Summary attempt for Unknown Outcome without ordinary retry", async () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-unknown-summary",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "019f0000-0000-7000-8000-000000000142",
        recordingStem: "Activation_20260825_141501",
      },
      task: {
        id: "019f0000-0000-7000-8000-000000000142",
        state: "execution_unverified",
        phase: "failed",
        error: "Claude Code Summary outcome is unknown",
        summaryProvider: "claude-code",
        summaryModel: "claude-sonnet-5",
      },
      journey: unresolvedData().journey,
      blocker: {
        capability: "summary",
        detail: "Claude Code Summary outcome is unknown",
        retry: "new_summary_attempt",
        remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
      },
    } as AttemptData;
    renderRoute("en");
    const user = userEvent.setup();

    expect(screen.getByRole("alert")).toHaveTextContent("Claude Code Summary outcome is unknown");
    expect(screen.getByText(/claude-code · claude-sonnet-5/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Retry saved work" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open AI Provider Settings" })).toHaveAttribute(
      "href",
      "/settings/llm?connection=claude-code&capability=summary",
    );
    await user.click(screen.getByRole("button", { name: "Start a new Summary attempt" }));
    expect(activation.createSummaryAttemptFromUnknown).toHaveBeenCalledWith({
      id: "019f0000-0000-7000-8000-000000000142",
    });
    await user.click(screen.getByRole("button", { name: "Keep waiting" }));
    expect(screen.getByRole("status")).toHaveTextContent("Kept waiting");
  });

  it("displays a durable stopped-recording handoff failure after restart", () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        stopRequestedAt: "2026-08-25T06:15:12.000Z",
        handoffError: "Automatic Agent recording processing is paused by policy",
        taskId: null,
        recordingStem: "Guided_20260825_141500",
      },
      task: null,
      journey: unresolvedData().journey,
      blocker: {
        capability: "recording_pipeline",
        detail: "Automatic Agent recording processing is paused by policy",
        retry: "same_audio",
        remediation: { href: "/settings/automation" },
      },
    };
    renderRoute("en");

    expect(screen.getByRole("alert")).toHaveTextContent("Recording processing policy blocked activation");
    expect(screen.getByText("Automatic Agent recording processing is paused by policy")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open Automation Settings" }))
      .toHaveAttribute("href", "/settings/automation");
    expect(screen.getByRole("button", { name: "Retry saved work" })).toBeInTheDocument();
  });

  it("offers re-recording only for an invalid saved-audio blocker", async () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-invalid-audio",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "task-invalid-audio",
        recordingStem: "Broken_20260825_141500",
      },
      task: {
        id: "task-invalid-audio",
        state: "failed",
        phase: "failed",
        error: "Recording contains no audio frames",
      },
      journey: unresolvedData().journey,
      blocker: {
        capability: "audio",
        detail: "The saved recording does not contain valid audio",
        retry: "rerecord",
        remediation: { href: "/settings/general" },
      },
    };
    renderRoute("en");
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Retry saved work" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Record again" }));
    expect(activation.rerecordAttempt).toHaveBeenCalledOnce();
  });

  it("labels capture-start recovery without claiming saved work", async () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-start-failed",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: null,
        recordingStem: null,
        handoffError: "audio daemon unavailable",
      },
      task: null,
      journey: unresolvedData().journey,
      blocker: {
        capability: "audio",
        detail: "audio daemon unavailable",
        retry: "start_recording",
        remediation: { href: "/settings/general" },
      },
    };
    renderRoute("en");
    const user = userEvent.setup();

    expect(screen.queryByRole("button", { name: "Retry saved work" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start recording" }));
    expect(activation.retryAttempt).toHaveBeenCalledOnce();
  });

  it("does not move keyboard focus on each durable progress poll", () => {
    activation.data = {
      state: "processing",
      evidence: null,
      attempt: {
        id: "attempt-1",
        startedAt: "2026-08-25T06:15:00.000Z",
        taskId: "019f0000-0000-7000-8000-000000000131",
        recordingStem: "Activation_20260825_141500",
      },
      task: {
        id: "019f0000-0000-7000-8000-000000000131",
        state: "running",
        phase: "transcribing",
        error: null,
      },
      journey: unresolvedData().journey,
    };
    renderRoute("en");
    const leave = screen.getByRole("link", { name: "Continue using Yulu" });
    leave.focus();

    activation.data = { ...activation.data };
    act(() => activation.renderStatus?.());

    expect(leave).toHaveFocus();
  });

  it("localizes the xAI transcript disclosure and records it independently from credentials", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_disclosure",
      reason: "disclosure_required",
      detail: "disclosure required",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.state = "disclosure_required";
    activation.data.readiness.summary.disclosure!.acceptedDisclosureVersion = null;
    activation.data.readiness.summary.disclosure!.required = true;
    renderRoute("zh");
    const user = userEvent.setup();

    const disclosure = screen.getByRole("dialog", { name: "xAI 摘要数据路径披露" });
    expect(disclosure).toHaveTextContent("转写文本会发送给 xAI");
    expect(disclosure).not.toHaveTextContent(/OAuth.*同意|API Key.*同意/);
    await user.click(screen.getByRole("button", { name: "接受数据路径披露" }));
    expect(activation.acceptAgentConnectionDisclosure).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "summary",
    });
    expect(activation.acceptSummaryDisclosure).not.toHaveBeenCalled();
    expect(activation.updateConfig).not.toHaveBeenCalled();
  });

  it("turns declined summary disclosure into a named blocker without fallback", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_disclosure",
      reason: "disclosure_required",
      detail: "disclosure required",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.state = "disclosure_required";
    activation.data.readiness.summary.disclosure!.required = true;
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(activation.declineAgentConnectionDisclosure).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "summary",
    });
    expect(activation.declineSummaryDisclosure).not.toHaveBeenCalled();
    const blocker = screen.getByRole("alert");
    expect(blocker).toHaveTextContent("xAI remains selected");
    expect(blocker).toHaveTextContent("transcript text was not sent");
    expect(screen.getByRole("link", { name: "Open AI Provider Settings" })).toHaveAttribute("href", "/settings/llm?capability=summary");
    expect(activation.updateConfig).not.toHaveBeenCalled();
    expect(activation.probeXai).not.toHaveBeenCalled();
  });

  it("records Codex Summary disclosure against its selected connection", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_disclosure",
      reason: "disclosure_required",
      detail: "Codex disclosure required",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.selected = { provider: "codex", model: "gpt-5.6-sol" };
    activation.data.readiness.summary.state = "disclosure_required";
    activation.data.readiness.summary.disclosure = {
      provider: "codex",
      connectionId: "codex",
      disclosureVersion: "codex-summary-v1",
      acceptedDisclosureVersion: null,
      declined: false,
      required: true,
      data: "transcript_text",
      destination: "Codex runtime and its configured model provider",
    };
    renderRoute("en");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Accept Data Path Disclosure" }));
    expect(activation.acceptAgentConnectionDisclosure).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "summary",
    });
  });

  it("records Claude Code Summary disclosure independently against its selected connection", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_disclosure",
      reason: "disclosure_required",
      detail: "Claude Code Summary disclosure required",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.selected = {
      provider: "claude-code",
      model: "claude-sonnet-5",
    };
    activation.data.readiness.summary.state = "disclosure_required";
    activation.data.readiness.summary.disclosure = {
      provider: "claude-code",
      connectionId: "claude-code",
      disclosureVersion: "claude-code-summary-v1",
      acceptedDisclosureVersion: null,
      declined: false,
      required: true,
      data: "transcript_text",
      destination: "Claude Code runtime and its configured model provider",
    };
    renderRoute("en");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Accept Data Path Disclosure" }));
    expect(activation.acceptAgentConnectionDisclosure).toHaveBeenCalledWith({
      connectionId: "claude-code",
      capability: "summary",
    });
    expect(activation.acceptSummaryDisclosure).not.toHaveBeenCalled();
  });

  it("retries the selected Supported Agent capability instead of only refetching stale state", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_readiness",
      reason: "readiness_failed",
      detail: "Claude Code cannot currently prove policy-managed hooks are disabled; Summary remains unavailable",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.selected = { provider: "claude-code", model: "claude-sonnet-5" };
    activation.data.readiness.summary.state = "blocked";
    activation.data.readiness.summary.disclosure = null;
    activation.summaryActivation.selected = {
      connectionId: "claude-code",
      provider: "claude-code",
      label: "Claude Code",
      model: "claude-sonnet-5",
    };
    const user = userEvent.setup();
    renderRoute("en");

    expect(screen.getByText(/policy-managed hooks.*Summary remains unavailable/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry Summary Provider check" }));
    expect(activation.probeXai).toHaveBeenCalledWith({
      connectionId: "claude-code",
      capability: "summary",
      model: "claude-sonnet-5",
    });
    expect(activation.probeSummaryProvider).not.toHaveBeenCalled();
    expect(activation.updateConfig).not.toHaveBeenCalled();
  });

  it.each([
    ["en", "The activation action failed: Claude runtime denied the exact model"],
    ["zh", "激活操作失败：Claude runtime denied the exact model"],
  ] as const)("keeps the exact localized Summary mutation failure in %s", async (lang, expected) => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_readiness",
      reason: "readiness_failed",
      detail: "Claude Code Summary is not ready",
      remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
    };
    activation.summaryActivation.selected = {
      connectionId: "claude-code",
      provider: "claude-code",
      label: "Claude Code",
      model: "claude-sonnet-5",
    };
    activation.probeXai.mockRejectedValueOnce(new Error("Claude runtime denied the exact model"));
    renderRoute(lang);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", {
      name: lang === "en" ? "Retry Summary Provider check" : "重试摘要提供商检查",
    }));
    expect(await screen.findByText(expected)).toHaveAttribute("role", "alert");
  });

  it("does not offer a no-op Summary retry when no explicit connection is selected", () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_readiness",
      reason: "provider_unavailable",
      detail: "Choose a ready Summary Provider connection",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    (activation.summaryActivation as unknown as { selected: null }).selected = null;

    renderRoute("en");

    expect(screen.getByRole("link", { name: "Open AI Provider Settings" })).toHaveAttribute(
      "href",
      "/settings/llm?capability=summary",
    );
    expect(screen.queryByRole("button", { name: "Retry Summary Provider check" })).not.toBeInTheDocument();
  });

  it("retries only the selected xAI summary capability with exact remediation", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_readiness",
      reason: "readiness_failed",
      detail: "probe failed",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.state = "blocked";
    activation.data.readiness.summary.remediation = { href: "/settings/llm?capability=summary" };
    const user = userEvent.setup();
    renderRoute("en");

    expect(screen.getByRole("alert")).toHaveTextContent("readiness check failed");
    await user.click(screen.getByRole("button", { name: "Retry Summary Provider check" }));
    expect(activation.probeXai).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-exact",
    });
    expect(activation.updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
  });

  it("lists only shared-contract eligible Summary Providers and selects the exact connection", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "summary_provider";
    activation.data.blocker = {
      capability: "summary_readiness",
      reason: "readiness_required",
      detail: "probe required",
      remediation: { href: "/settings/llm?capability=summary" },
    };
    activation.data.readiness.summary.state = "blocked";
    activation.data.readiness.summary.selected = { provider: "agent", model: "runtime-managed" };
    const user = userEvent.setup();
    renderRoute("en");

    expect(screen.getByRole("radio", { name: "xAI" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "CLIProxyAPI" })).toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "Hermes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "OpenClaw" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("radio", { name: "Codex" }));
    expect(activation.selectAgentConnection).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "summary",
      model: "gpt-5.6-sol",
    });
    expect(activation.summaryRefetch).toHaveBeenCalledOnce();
    expect(activation.updateConfig).not.toHaveBeenCalled();
    expect(activation.probeXai).not.toHaveBeenCalled();
  });

  it("keeps every eligible Summary Provider selectable when the current choice is ready", () => {
    activation.data = unresolvedData();
    renderRoute("en");

    expect(screen.getByRole("radio", { name: "xAI" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Codex" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Claude Code" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "CLIProxyAPI" })).toBeInTheDocument();
  });

  it("exits microphone blocking with exact macOS guidance and bounded retry", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "microphone_permission";
    activation.data.blocker = {
      capability: "microphone_permission",
      detail: "TCC denied",
      remediation: { href: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone" },
    };
    activation.data.readiness.microphonePermission = {
      state: "blocked",
      detail: "TCC denied",
      remediation: activation.data.blocker.remediation,
    };
    renderRoute("en");
    const user = userEvent.setup();

    expect(screen.getByRole("alert")).toHaveTextContent(
      "System Settings → Privacy & Security → Microphone → allow Yulu",
    );
    expect(screen.getByRole("link", { name: "Open Microphone settings" })).toHaveAttribute(
      "href",
      "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
    );
    await user.click(screen.getByRole("button", { name: "Retry microphone check" }));
    expect(activation.refetch).toHaveBeenCalledOnce();
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
  });

  it("routes a missing audio input to General Settings", () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "audio_input";
    activation.data.blocker = {
      capability: "audio_input",
      detail: "Selected input missing",
      remediation: { href: "/settings/general" },
    };
    activation.data.readiness.audioInput.state = "blocked";
    activation.data.readiness.audioInput.detail = "Selected input missing";
    activation.data.readiness.audioInput.remediation = { href: "/settings/general" };
    renderRoute("en");

    expect(screen.getByRole("link", { name: "Open General Settings" })).toHaveAttribute(
      "href",
      "/settings/general",
    );
  });

  it("shows localized privacy and cost disclosure before selecting xAI", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "transcription";
    activation.data.readiness.transcription.state = "blocked";
    activation.data.readiness.transcription.local.ready = false;
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("radio", { name: "xAI cloud transcription" }));
    const disclosure = screen.getByRole("dialog", { name: "xAI cloud transcription disclosure" });
    expect(disclosure).toHaveTextContent("recording audio leaves this computer");
    expect(disclosure).toHaveTextContent("may incur xAI provider costs");
    expect(activation.updateConfig).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Accept and select xAI" }));
    expect(activation.acceptAgentConnectionDisclosure).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "transcription",
    });
    expect(activation.acceptXaiDisclosure).not.toHaveBeenCalled();
    expect(activation.selectAgentConnection).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "transcription",
    });
    expect(activation.updateConfig).not.toHaveBeenCalled();
  });

  it("localizes the xAI audio disclosure in Chinese", () => {
    activation.data = unresolvedData();
    activation.data.readiness.transcription.selected = "xai";
    activation.data.readiness.transcription.state = "disclosure_required";
    activation.data.nextStep = "transcription";
    renderRoute("zh");

    const disclosure = screen.getByRole("dialog", { name: "xAI 云端转写披露" });
    expect(disclosure).toHaveTextContent("录音音频会离开这台电脑");
    expect(disclosure).toHaveTextContent("可能会在你的 xAI 账号下产生提供商费用");
  });

  it("keeps the selected provider when disclosure is declined and offers a genuine local choice", async () => {
    activation.data = unresolvedData();
    activation.data.readiness.transcription.selected = "xai";
    activation.data.readiness.transcription.state = "disclosure_required";
    activation.data.nextStep = "transcription";
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(activation.updateConfig).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Choose local transcription" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do this later" })).toBeInTheDocument();
  });

  it("offers only Activation Deferral after decline when local transcription is unavailable", async () => {
    activation.data = unresolvedData();
    activation.data.readiness.transcription.selected = "xai";
    activation.data.readiness.transcription.state = "disclosure_required";
    activation.data.readiness.transcription.local.available = false;
    activation.data.nextStep = "transcription";
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Decline" }));
    expect(activation.updateConfig).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Choose local transcription" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Do this later" })).toBeInTheDocument();
  });

  it("retries the selected transcription probe and links to transcription settings", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "transcription";
    activation.data.blocker = {
      capability: "local_transcription",
      detail: "Local model probe failed",
      remediation: { href: "/settings/transcription" },
    };
    activation.data.readiness.transcription.state = "blocked";
    activation.data.readiness.transcription.local.ready = false;
    activation.data.readiness.transcription.local.detail = "Local model probe failed";
    activation.data.readiness.transcription.remediation = { href: "/settings/transcription" };
    const user = userEvent.setup();
    renderRoute("en");

    expect(screen.getByRole("link", { name: "Open Transcription Settings" })).toHaveAttribute(
      "href",
      "/settings/transcription",
    );
    await user.click(screen.getByRole("button", { name: "Retry transcription check" }));
    expect(activation.testLocal).toHaveBeenCalledOnce();
    expect(activation.refetch).toHaveBeenCalled();
  });

  it("retries the selected xAI transcription probe without changing provider", async () => {
    activation.data = unresolvedData();
    activation.data.nextStep = "transcription";
    activation.data.blocker = {
      capability: "xai_transcription",
      detail: "xAI probe failed",
      remediation: { href: "/settings/llm?connection=direct-xai&capability=transcription" },
    };
    activation.data.readiness.transcription.selected = "xai";
    activation.data.readiness.transcription.state = "blocked";
    activation.data.readiness.transcription.xai.disclosureRequired = false;
    activation.data.readiness.transcription.xai.acceptedDisclosureVersion = "xai-audio-v1";
    activation.data.readiness.transcription.remediation = { href: "/settings/llm?connection=direct-xai&capability=transcription" };
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Retry transcription check" }));
    expect(activation.probeXai).toHaveBeenCalledWith({ capability: "transcription" });
    expect(activation.updateConfig).not.toHaveBeenCalled();
  });
});
