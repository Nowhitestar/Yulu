import { existsSync, readFileSync } from "node:fs";
import { runAgentCliCommand } from "./agentCliRunner.js";
import type { AgentRuntime } from "./agentRuntime.js";
import {
  appendAgentSessionMessage,
  ensureBackgroundAgentSession,
  updateAgentSessionNativeSession,
} from "./agentSessionStore.js";

const AGENT_ACTION_TIMEOUT_MS = 180_000;
const MAX_SUMMARY_CHARS = 40_000;

export interface AgentShareSummaryArgs {
  configDir: string;
  scriptDir: string;
  runtime: AgentRuntime;
  channel: "notion" | "zulip";
  summaryPath: string;
  title: string;
  destinationHint: string;
}

export interface AgentActionResult {
  stdout: string;
  stderr: string;
  sessionId: string;
}

function channelLabel(channel: "notion" | "zulip"): string {
  return channel === "notion" ? "Notion" : "Zulip";
}

function buildSharePrompt(args: AgentShareSummaryArgs, summary: string): string {
  const label = channelLabel(args.channel);
  const destination =
    args.channel === "notion"
      ? (args.destinationHint || "Yulu Meeting database/page; create it if it does not exist")
      : (args.destinationHint || "the default Zulip stream/topic configured in the current Agent");
  return [
    "You are the selected local Agent for Yulu, a local-first meeting recorder.",
    "",
    `Task: send the following meeting summary to ${label} using your own configured connector/plugin.`,
    `Meeting title: ${args.title}`,
    `Destination: ${destination}`,
    `Summary file: ${args.summaryPath}`,
    "",
    "Rules:",
    "- Use the Agent's configured connector/plugin; do not ask Yulu for remote credentials.",
    "- For Notion, use the destination above. If it is named \"Yulu Meeting\" and does not exist, create it when your connector permits creation.",
    "- For Zulip, use exactly the stream/channel and topic above.",
    "- Return a concise Markdown result with status, destination, and URL or identifier if available.",
    "- If the connector is unavailable, explain the missing capability clearly and do not pretend the send succeeded.",
    "",
    "Meeting summary:",
    summary.slice(0, MAX_SUMMARY_CHARS),
  ].join("\n");
}

export async function runAgentShareSummary(args: AgentShareSummaryArgs): Promise<AgentActionResult> {
  if (args.runtime.disabledReason || args.runtime.command.length === 0) {
    throw new Error(args.runtime.disabledReason ?? "selected Agent runtime is not available");
  }
  if (!existsSync(args.summaryPath)) {
    throw new Error(`summary missing: ${args.summaryPath}`);
  }

  const session = ensureBackgroundAgentSession(args.configDir, {
    agent: args.runtime.provider,
    runtimeLabel: args.runtime.label,
  });
  const label = channelLabel(args.channel);
  appendAgentSessionMessage(args.configDir, session.id, {
    role: "user",
    text: `发送会议纪要到 ${label}: ${args.title}`,
  });

  const summary = readFileSync(args.summaryPath, "utf8");
  const prompt = buildSharePrompt(args, summary);
  const result = await runAgentCliCommand({
    runtime: args.runtime,
    scriptDir: args.scriptDir,
    prompt,
    timeoutMs: AGENT_ACTION_TIMEOUT_MS,
    nativeSessionId: session.nativeSessionId,
    yuluSessionId: session.id,
    configDir: args.configDir,
  });
  if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
    updateAgentSessionNativeSession(args.configDir, session.id, {
      nativeSessionId: result.nativeSessionId,
      runtimeLabel: args.runtime.label,
    });
  }
  const output = result.stdout.trim();
  if (result.code !== 0 || !output) {
    const error = (result.stderr || result.stdout || `Agent action exited ${result.code}`).trim();
    appendAgentSessionMessage(args.configDir, session.id, {
      role: "assistant",
      text: "",
      error,
    });
    throw new Error(error);
  }

  appendAgentSessionMessage(args.configDir, session.id, {
    role: "assistant",
    text: output,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    sessionId: session.id,
  };
}
