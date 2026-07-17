import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

let audioAvailable = true;
let statusAgentRunning = true;
let pipelinePaused = false;
let pipelineDisabled = false;

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
      history: { useQuery: () => ({ data: [] }) },
    },
  },
}));

import { VoiceInput } from "../../web/src/routes/voice-input.js";
import { translate } from "../../web/src/i18n/LanguageProvider.js";

beforeEach(() => {
  audioAvailable = true;
  statusAgentRunning = true;
  pipelinePaused = false;
  pipelineDisabled = false;
});

describe("VoiceInput readiness", () => {
  it("is ready when both StatusAgent and the selected audio engine are available", () => {
    render(<VoiceInput />);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });

  it("does not report ready when the selected audio engine is unavailable", () => {
    audioAvailable = false;
    render(<VoiceInput />);
    expect(screen.getByText(translate("zh", "voiceInput.status.check"))).toBeInTheDocument();
    expect(screen.queryByText(translate("zh", "voiceInput.status.ready"))).toBeNull();
  });

  it("keeps on-demand dictation ready when only automatic recording processing is paused", () => {
    pipelinePaused = true;
    render(<VoiceInput />);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });

  it("keeps dictation ready when the summary pipeline is disabled", () => {
    pipelineDisabled = true;
    render(<VoiceInput />);
    expect(screen.getByText(translate("zh", "voiceInput.status.ready"))).toBeInTheDocument();
  });
});
