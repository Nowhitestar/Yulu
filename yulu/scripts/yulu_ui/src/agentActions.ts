import { existsSync, readFileSync } from "node:fs";
import { runAgentCliCommand } from "./agentCliRunner.js";
import type { AgentRuntime } from "./agentRuntime.js";
import {
  appendAgentSessionMessage,
  createAgentSession,
  updateAgentSessionNativeSession,
} from "./agentSessionStore.js";

const AGENT_ACTION_TIMEOUT_MS = 3 * 60_000;

export interface AgentActionResult {
  stdout: string;
  stderr: string;
  sessionId: string;
}

export interface AgentShareSummaryResult extends AgentActionResult {
  delivery: {
    status: "sent";
    channel: string;
    destination: string;
    url: string;
    id: string;
  };
}

interface AgentActionBase {
  configDir: string;
  scriptDir: string;
  runtime: AgentRuntime;
  title: string;
}

export interface AgentSummarizeArgs extends AgentActionBase {
  transcriptPath: string;
  instructions: string;
}

export interface AgentShareSummaryArgs extends AgentActionBase {
  channel: string;
  channelLabel: string;
  summaryPath: string;
  destinationHint: string;
}

function requireRuntime(runtime: AgentRuntime): void {
  if (runtime.disabledReason || runtime.command.length === 0) {
    throw new Error(runtime.disabledReason ?? "selected Agent runtime is not available");
  }
}

function parseShareDelivery(output: string, expectedChannel: string): AgentShareSummaryResult["delivery"] {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  let value: unknown;
  try {
    value = JSON.parse(fenced);
  } catch {
    throw new Error("Agent did not return a verifiable JSON delivery receipt");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Agent returned an invalid delivery receipt");
  }
  const receipt = value as Record<string, unknown>;
  const status = String(receipt.status ?? "").trim().toLowerCase();
  const channel = String(receipt.channel ?? "").trim().toLowerCase();
  const destination = String(receipt.destination ?? "").trim();
  const url = String(receipt.url ?? "").trim();
  const id = String(receipt.id ?? "").trim();
  if (!["sent", "success"].includes(status) || channel !== expectedChannel || !(destination || url || id)) {
    throw new Error("Agent delivery receipt did not verify the requested channel and destination");
  }
  return { status: "sent", channel, destination, url, id };
}

async function runIsolatedAction(args: AgentActionBase & {
  sessionTitle: string;
  userMessage: string;
  prompt: string;
  hermesToolsets?: readonly string[];
}): Promise<AgentActionResult> {
  requireRuntime(args.runtime);
  const session = createAgentSession(args.configDir, {
    agent: args.runtime.provider,
    purpose: "background",
    title: args.sessionTitle,
    runtimeLabel: args.runtime.label,
  });
  appendAgentSessionMessage(args.configDir, session.id, {
    role: "user",
    text: args.userMessage,
  });

  const result = await runAgentCliCommand({
    runtime: args.runtime,
    scriptDir: args.scriptDir,
    prompt: args.prompt,
    timeoutMs: AGENT_ACTION_TIMEOUT_MS,
    yuluSessionId: session.id,
    configDir: args.configDir,
    hermesToolsets: args.runtime.provider === "hermes" ? args.hermesToolsets : undefined,
  });
  if (result.nativeSessionId) {
    updateAgentSessionNativeSession(args.configDir, session.id, {
      nativeSessionId: result.nativeSessionId,
      runtimeLabel: args.runtime.label,
    });
  }
  const output = result.stdout.trim();
  if (result.code !== 0 || !output) {
    const error = (result.stderr || result.stdout || `Agent action exited ${result.code}`).trim();
    appendAgentSessionMessage(args.configDir, session.id, { role: "assistant", text: "", error });
    throw new Error(error);
  }
  appendAgentSessionMessage(args.configDir, session.id, { role: "assistant", text: output });
  return { stdout: result.stdout, stderr: result.stderr, sessionId: session.id };
}

export async function runAgentSummarize(args: AgentSummarizeArgs): Promise<AgentActionResult> {
  if (!existsSync(args.transcriptPath)) throw new Error(`transcript missing: ${args.transcriptPath}`);
  const transcript = readFileSync(args.transcriptPath, "utf8").trim();
  if (!transcript) throw new Error("transcript is empty");
  return runIsolatedAction({
    ...args,
    sessionTitle: `总结 · ${args.title}`,
    userMessage: `重新生成会议摘要: ${args.title}`,
    hermesToolsets: ["yulu_artifact"],
    prompt: [
      "Generate only a factual Markdown meeting summary from the supplied transcript.",
      "This is a summary-only action: do not transcribe audio, contact external services, or call tools.",
      `Meeting title: ${args.title}`,
      "",
      "Summary instructions:",
      args.instructions,
      "",
      "Transcript:",
      transcript,
    ].join("\n"),
  });
}

export async function runAgentShareSummary(args: AgentShareSummaryArgs): Promise<AgentShareSummaryResult> {
  if (!existsSync(args.summaryPath)) throw new Error(`summary missing: ${args.summaryPath}`);
  const summary = readFileSync(args.summaryPath, "utf8").trim();
  if (!summary) throw new Error("summary is empty");
  const result = await runIsolatedAction({
    ...args,
    sessionTitle: `分享 · ${args.title} · ${args.channelLabel}`,
    userMessage: `分享会议摘要到 ${args.channelLabel}: ${args.title}`,
    hermesToolsets: [args.channel],
    prompt: [
      `Send the meeting summary to ${args.channelLabel} using the selected Agent's configured connector/toolset.`,
      `Meeting title: ${args.title}`,
      `Destination: ${args.destinationHint || "use the Agent's configured default"}`,
      "",
      "Rules:",
      `- Use only the ${args.channel} connector/toolset for the external write.`,
      "- This is a share-only action. Do not transcribe audio or regenerate the summary.",
      "- Perform exactly one external write for this request.",
      `- Return only JSON: {"status":"sent","channel":"${args.channel}","destination":"actual destination","url":"optional URL","id":"optional identifier"}.`,
      "- If the connector is unavailable, fail clearly and do not claim success.",
      "",
      "Meeting summary:",
      summary,
    ].join("\n"),
  });
  return { ...result, delivery: parseShareDelivery(result.stdout, args.channel) };
}
