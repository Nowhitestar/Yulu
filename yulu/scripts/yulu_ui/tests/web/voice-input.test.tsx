vi.mock("../../web/src/hooks/usePermissions.js", () => ({ usePermissions: () => ({ data: { input: "ready", microphone: "ready" }, refetch: vi.fn() }) }));
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

let audioAvailable = true;
let statusAgentRunning = true;
let pipelinePaused = false;
let pipelineDisabled = false;
let historyItems: Array<Record<string, unknown>> = [];

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    useUtils: () => ({ recording: { history: { invalidate: vi.fn() } } }),
    config: {
      get: { useQuery: () => ({
        data: {
          status_agent: {
            enabled: true,
            hotkeys: {
              dictate: { key: "Space", modifiers: ["ctrl", "alt"] },
              translate: { key: "T", modifiers: ["ctrl", "alt"] },
              voice_chat: { key: "A", modifiers: ["ctrl", "alt"] },
            },
          },
          transcription: {
            dictation: {
              prompt_slug: "dictation-cleanup",
              translate_prompt_slug: "dictation-translate",
              target_language: "English",
            },
          },
        },
      }) },
    },
    daemons: {
      health: { useQuery: () => ({
        data: [{ name: "com.yulu.statusagent", status: statusAgentRunning ? "running" : "stopped" }],
      }) },
    },
    agentTasks: {
      transcriptionHealth: { useQuery: () => ({
        data: {
          available: audioAvailable,
          provider: "local",
          reason: audioAvailable ? null : "selected audio engine is unavailable",
          paused: pipelinePaused || pipelineDisabled,
          policyReason: pipelineDisabled
            ? "Agent recording pipeline is disabled by policy"
            : pipelinePaused ? "Automatic recording processing is paused" : null,
        },
      }) },
    },
    recording: {
      state: { useQuery: () => ({ data: { state: "idle", dictationActive: false } }) },
      history: { useQuery: () => ({ data: historyItems }) },
    },
  },
}));

import { VoiceInput } from "../../web/src/routes/voice-input.js";
import { LanguageProvider, translate } from "../../web/src/i18n/LanguageProvider.js";

beforeEach(() => {
  audioAvailable = true;
  statusAgentRunning = true;
  pipelinePaused = false;
  pipelineDisabled = false;
  historyItems = [];
});

describe("VoiceInput readiness", () => {
  it("lets users view and copy the original without replacing the cleaned result", async () => {
    historyItems = [{ id: "one", createdAt: "", action: "dictate", text: "明天四点开会", rawText: "嗯，明天三点，不对四点，开会。" }];
    const user = userEvent.setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    await user.click(screen.getByText("查看识别原文"));
    await user.click(screen.getByRole("button", { name: "复制原文" }));
    expect(write).toHaveBeenLastCalledWith("嗯，明天三点，不对四点，开会。");
    expect(screen.getByText("明天四点开会")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "复制" }));
    expect(write).toHaveBeenLastCalledWith("明天四点开会");
    write.mockRestore();
  });

  it("shows cleanup failures in history without inventing an original for old entries", () => {
    historyItems = [{ id: "old", action: "dictate", text: "旧记录", createdAt: "", cleanupWarning: "request failed" }];
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    expect(screen.getByText("本次整理未完成，已保留原文。")).toBeVisible();
    expect(screen.queryByText("查看识别原文")).toBeNull();
  });
  it("is ready when both StatusAgent and the selected audio engine are available", () => {
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });

  it("does not report ready when the selected audio engine is unavailable", () => {
    audioAvailable = false;
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    expect(screen.getByText(translate("zh", "voiceInput.status.check"))).toBeInTheDocument();
    expect(screen.queryByText(translate("zh", "voiceInput.status.ready"))).toBeNull();
  });

  it("keeps on-demand dictation ready when only automatic recording processing is paused", () => {
    pipelinePaused = true;
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });

  it("keeps dictation ready when the summary pipeline is disabled", () => {
    pipelineDisabled = true;
    render(<LanguageProvider><VoiceInput /></LanguageProvider>);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });
});
