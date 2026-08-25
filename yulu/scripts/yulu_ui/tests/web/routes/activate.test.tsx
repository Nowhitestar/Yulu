import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

interface ActivatedData {
  state: "activated";
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
  sourceArtifactAvailable: boolean;
  completedNoteAvailable: boolean;
  completedNote: string | null;
}

interface UnresolvedData {
  state: "unresolved";
  evidence: null;
  nextStep: "microphone_permission" | "audio_input" | "transcription" | null;
  blocker: {
    capability: "microphone_permission" | "audio_input" | "local_transcription" | "xai_transcription";
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
    sourceArtifactAvailable: true,
    completedNoteAvailable: true,
    completedNote: "# Completed note\n\nVisible body",
  };
}

const activation = vi.hoisted(() => ({
  data: activatedData() as ActivatedData | UnresolvedData,
  defer: vi.fn(async () => ({ journey: { shouldAutoEnter: false } })),
  acceptXaiDisclosure: vi.fn(async () => ({ disclosureVersion: "xai-audio-v1" })),
  updateConfig: vi.fn(async () => ({})),
  testLocal: vi.fn(async () => ({ ok: true })),
  probeXai: vi.fn(async () => ({ status: "ready" })),
  refetch: vi.fn(async () => ({})),
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    activation: {
      status: { useQuery: () => ({ data: activation.data, isPending: false, refetch: activation.refetch }) },
      defer: { useMutation: () => ({ mutateAsync: activation.defer, isPending: false }) },
      acceptXaiTranscriptionDisclosure: {
        useMutation: () => ({ mutateAsync: activation.acceptXaiDisclosure, isPending: false }),
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
  activation.acceptXaiDisclosure.mockClear();
  activation.updateConfig.mockClear();
  activation.testLocal.mockClear();
  activation.probeXai.mockClear();
  activation.refetch.mockClear();
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

  it("explains a missing source artifact without revoking activated state", () => {
    (activation.data as ActivatedData).sourceArtifactAvailable = false;
    (activation.data as ActivatedData).completedNoteAvailable = true;
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "Yulu 已激活" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("核心激活证据已验证");
    expect(screen.getByText(/原始录音已不存在/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开已完成笔记" })).toBeInTheDocument();
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
    expect(screen.queryByRole("radio", { name: "Local transcription" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radio", { name: "xAI cloud transcription" })).not.toBeInTheDocument();
    expect(screen.queryByText("Checking activation…")).not.toBeInTheDocument();
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
    expect(activation.acceptXaiDisclosure).toHaveBeenCalledOnce();
    expect(activation.updateConfig).toHaveBeenCalledWith({ key: "transcription.engine", value: "xai" });
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
      remediation: { href: "/settings/transcription" },
    };
    activation.data.readiness.transcription.selected = "xai";
    activation.data.readiness.transcription.state = "blocked";
    activation.data.readiness.transcription.xai.disclosureRequired = false;
    activation.data.readiness.transcription.xai.acceptedDisclosureVersion = "xai-audio-v1";
    activation.data.readiness.transcription.remediation = { href: "/settings/transcription" };
    const user = userEvent.setup();
    renderRoute("en");

    await user.click(screen.getByRole("button", { name: "Retry transcription check" }));
    expect(activation.probeXai).toHaveBeenCalledWith({ capability: "transcription" });
    expect(activation.updateConfig).not.toHaveBeenCalled();
  });
});
