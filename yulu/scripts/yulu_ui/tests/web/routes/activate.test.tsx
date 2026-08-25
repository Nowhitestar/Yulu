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
  journey: {
    shouldAutoEnter: boolean;
    automaticEntryAcknowledgedAt: string | null;
    deferredAt: string | null;
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
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    activation: {
      status: { useQuery: () => ({ data: activation.data, isPending: false }) },
      defer: { useMutation: () => ({ mutateAsync: activation.defer, isPending: false }) },
    },
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
    activation.data = {
      state: "unresolved",
      evidence: null,
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: "2026-08-25T04:00:00.000Z",
        deferredAt: null,
      },
    };
    const { router } = renderRoute("en");
    const user = userEvent.setup();

    const heading = screen.getByRole("heading", { name: "Start your Activation Journey" });
    await waitFor(() => expect(heading).toHaveFocus());
    await user.tab();
    expect(screen.getByRole("link", { name: "Transcription settings" })).toHaveFocus();
    await user.tab();
    await user.tab();
    expect(screen.getByRole("button", { name: "Do this later" })).toHaveFocus();
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("heading", { name: "Agent Console" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(activation.defer).toHaveBeenCalledOnce();
  });

  it("localizes unresolved direct re-entry in Chinese", () => {
    activation.data = {
      state: "unresolved",
      evidence: null,
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: "2026-08-25T04:00:00.000Z",
      },
    };
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "开始激活 Yulu" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "稍后再做" })).toBeInTheDocument();
  });
});
