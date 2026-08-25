import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const activation = vi.hoisted(() => ({
  data: {
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
  },
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    activation: {
      status: { useQuery: () => ({ data: activation.data, isPending: false }) },
    },
  },
}));

import { Activate } from "../../../web/src/routes/activate.js";

function renderRoute(lang: "zh" | "en") {
  localStorage.setItem("yulu_ui.lang", lang);
  const router = createMemoryRouter(
    [{ path: "/activate", element: <Activate /> }],
    { initialEntries: ["/activate"] },
  );
  return render(
    <LanguageProvider>
      <RouterProvider router={router} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  activation.data.sourceArtifactAvailable = true;
  activation.data.completedNoteAvailable = true;
  activation.data.completedNote = "# Completed note\n\nVisible body";
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
    activation.data.sourceArtifactAvailable = false;
    activation.data.completedNoteAvailable = true;
    renderRoute("zh");

    expect(screen.getByRole("heading", { name: "Yulu 已激活" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("核心激活证据已验证");
    expect(screen.getByText(/原始录音已不存在/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "打开已完成笔记" })).toBeInTheDocument();
  });
});
