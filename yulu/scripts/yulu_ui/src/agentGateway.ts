import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { AgentRuntime } from "./agentRuntime.js";
import { runAgentCliCommand } from "./agentCliRunner.js";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import type { AgentTask } from "./hostStore.js";
import type { AgentTaskWorkspace } from "./artifactStore.js";
import type { GlossaryContract } from "./glossaryContract.js";
import {
  canonicalNotionPageIdentity,
  isTrustedNotionUrl,
  isValidNotionPageId,
  notionPageIdentityProblem,
} from "./notionDelivery.js";

const HERMES_WORKFLOW_TIMEOUT_MS = 20 * 60_000;
const HERMES_CONTRACT_CACHE_MS = 5 * 60_000;
const HERMES_CONTRACT_PROBE_TIMEOUT_MS = 30_000;

function runProcess(command: string, args: string[], opts: {
  cwd: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  maxOutputBytes?: number;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const env = opts.env ?? envWithFallbackPath(process.env);
    const executable = resolveExecutable(command, env);
    const proc = spawn(executable, args, { cwd: opts.cwd, env });
    const max = opts.maxOutputBytes ?? 16 * 1024 * 1024;
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish({ stdout, stderr: stderr || `process timed out after ${opts.timeoutMs}ms`, code: 124 });
    }, opts.timeoutMs);
    proc.stdout.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stdout) < max) stdout += chunk.toString("utf8");
    });
    proc.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(stderr) < max) stderr += chunk.toString("utf8");
    });
    proc.on("error", (error) => finish({ stdout, stderr: stderr || error.message, code: 1 }));
    proc.on("close", (code) => finish({ stdout, stderr, code: code ?? 1 }));
    proc.stdin.end();
  });
}

export interface HermesCommandProbeResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type HermesCommandProbe = (
  command: string,
  args: readonly string[],
) => HermesCommandProbeResult;

export type HermesAsyncCommandProbe = (
  command: string,
  args: readonly string[],
) => Promise<HermesCommandProbeResult>;

const HERMES_CONTRACT_COMMANDS: ReadonlyArray<{
  name: string;
  args: readonly string[];
  markers: readonly string[];
}> = [
  { name: "sessions export", args: ["sessions", "export", "--help"], markers: ["--session-id", "output"] },
  { name: "config set", args: ["config", "set", "--help"], markers: ["key", "value"] },
  { name: "toolsets", args: ["--help"], markers: ["--toolsets"] },
];

function runHermesCommandProbe(command: string, args: readonly string[]): HermesCommandProbeResult {
  const result = spawnSync(command, [...args], {
    encoding: "utf8",
    env: envWithFallbackPath(process.env),
    timeout: 5_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    code: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr || result.error?.message || "",
  };
}

async function runHermesCommandProbeAsync(
  command: string,
  args: readonly string[],
): Promise<HermesCommandProbeResult> {
  const result = await runProcess(command, [...args], {
    cwd: process.cwd(),
    timeoutMs: HERMES_CONTRACT_PROBE_TIMEOUT_MS,
    maxOutputBytes: 2 * 1024 * 1024,
  });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr };
}

function hermesRecordingContractResultsProblem(
  commandResults: readonly HermesCommandProbeResult[],
  mcp: HermesCommandProbeResult,
): string | null {
  for (const [index, required] of HERMES_CONTRACT_COMMANDS.entries()) {
    const result = commandResults[index]!;
    const output = `${result.stdout}\n${result.stderr}`;
    if (result.code !== 0 || required.markers.some((marker) => !output.includes(marker))) {
      return `Hermes CLI is missing required ${required.name} support`;
    }
  }

  if (mcp.code !== 0) return "Hermes phase MCP registration could not be verified";
  const requiredServers = new Set(["yulu_artifact", "yulu_delivery"]);
  const enabledServers = new Set<string>();
  const ansi = /\x1b\[[0-9;]*m/g;
  for (const rawLine of `${mcp.stdout}\n${mcp.stderr}`.split(/\r?\n/)) {
    const fields = rawLine.replace(ansi, "").trim().split(/\s+/);
    if (fields.length >= 2 && requiredServers.has(fields[0]!) && fields.at(-1) === "enabled") {
      enabledServers.add(fields[0]!);
    }
  }
  const missingServers = [...requiredServers].filter((name) => !enabledServers.has(name));
  if (missingServers.length > 0) {
    return `Hermes phase MCP servers are not enabled: ${missingServers.join(", ")}`;
  }
  return null;
}

export function hermesRecordingContractProblem(
  command: string,
  probe: HermesCommandProbe = runHermesCommandProbe,
): string | null {
  const commandResults = HERMES_CONTRACT_COMMANDS.map((required) => probe(command, required.args));
  return hermesRecordingContractResultsProblem(commandResults, probe(command, ["mcp", "list"]));
}

export async function hermesRecordingContractProblemAsync(
  command: string,
  probe: HermesAsyncCommandProbe = runHermesCommandProbeAsync,
): Promise<string | null> {
  // Hermes is a Python CLI. LaunchAgent children inherit background QoS, and
  // cold-starting five interpreters at once can make valid probes time out or
  // contend on shared startup state. This contract runs once and is cached, so
  // prefer deterministic sequential checks over a fragile parallel cold start.
  const commandResults: HermesCommandProbeResult[] = [];
  for (const required of HERMES_CONTRACT_COMMANDS) {
    commandResults.push(await probe(command, required.args));
  }
  const mcp = await probe(command, ["mcp", "list"]);
  return hermesRecordingContractResultsProblem(commandResults, mcp);
}

export function directHermesRecordingCommandProblem(runtime: AgentRuntime): string | null {
  if (runtime.command.length !== 1) {
    return "automatic recording tasks require a direct Hermes executable without wrapper or profile arguments";
  }
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  if (!/^hermes(?:\.exe)?$/.test(head)) {
    return "automatic recording tasks require the direct Hermes executable";
  }
  return null;
}

export interface AgentGatewayHealth {
  available: boolean;
  provider: string;
  reason: string | null;
}

export class AgentUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailableError";
  }
}

export interface AgentSessionAudit {
  ok: boolean;
  toolNames: string[];
  artifactCommit: boolean;
  notionDeliveryBegin: boolean;
  notionSearch: boolean;
  notionWrite: boolean;
  notionIdempotencyMarker: boolean;
  notionWriteResultVerified: boolean;
  notionDeliveryCommit: boolean;
  notionOrderValid: boolean;
  unexpectedToolCalls?: string[];
  notionSearchOutcome?: "known" | "empty" | "match" | "invalid";
  notionWriteModeValid?: boolean;
  errors: string[];
}

export interface AgentWorkflowResult {
  stdout: string;
  stderr: string;
  nativeSessionId: string;
  audit: AgentSessionAudit;
}

export function hermesWorkflowFailureMessage(result: {
  code: number;
  stdout: string;
  stderr: string;
  nativeSessionId?: string;
}): string {
  const diagnostic = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^session_id:\s*\S+$/.test(line))
    .join("\n");
  if (diagnostic) return diagnostic;
  const session = result.nativeSessionId ? ` (session ${result.nativeSessionId})` : "";
  return `Hermes exited ${result.code}${session}; see ~/.hermes/logs/errors.log for the upstream provider error`;
}

export interface AgentArtifactWorkflowInput {
  task: AgentTask;
  leaseToken: string;
  workspace: AgentTaskWorkspace;
  transcriptionProvider: string;
  glossary?: GlossaryContract;
}

export type AgentNotionWorkflowInput = AgentArtifactWorkflowInput;

export interface RecordingAgentGateway {
  readonly provider: string;
  health(): AgentGatewayHealth;
  runArtifactWorkflow(input: AgentArtifactWorkflowInput): Promise<AgentWorkflowResult>;
  runNotionWorkflow(input: AgentNotionWorkflowInput): Promise<AgentWorkflowResult>;
  close(): void;
}

export function buildHermesRecordingPrompt(input: AgentArtifactWorkflowInput): string {
  const { task, leaseToken, transcriptionProvider } = input;
  return [
    "You are Hermes, the selected local Agent for Yulu.",
    "Complete the artifact phase of this recording task. Yulu owns only task state and artifact commits.",
    "",
    `Task ID: ${task.id}`,
    `Lease token: ${leaseToken}`,
    `Meeting title: ${task.title}`,
    `Transcript provider: ${transcriptionProvider}`,
    ...(task.instructions ? ["", "User-selected summary instructions:", task.instructions] : []),
    ...(input.glossary?.summaryInstruction
      ? ["", "Terminology contract:", input.glossary.summaryInstruction]
      : []),
    "",
    "Required order:",
    "1. Call the dedicated Yulu artifact MCP `recording_task_transcript_read` with taskId and leaseToken. Do not use filesystem tools.",
    "2. Produce a factual, structured Markdown meeting summary in the transcript's primary language.",
    "3. Call `recording_task_summary_stage` with taskId, leaseToken, and the complete Markdown summary.",
    "4. Call `recording_artifact_commit` with taskId, leaseToken, and provenance. Yulu will commit only its fixed task-scoped artifacts.",
    "",
    "Notion and every other external connector are unavailable during this phase. Do not attempt delivery.",
    "Stop after the artifact commit and report the Yulu task ID.",
  ].join("\n");
}

export function buildHermesNotionDeliveryPrompt(input: {
  task: AgentTask;
  leaseToken: string;
  workspace: AgentTaskWorkspace;
}): string {
  const { task, leaseToken } = input;
  return [
    "Start a new, separately authorized Yulu Notion delivery session.",
    "This session must not contain or request the raw transcript. The Host has verified the committed summary before exposing it.",
    "",
    `Task ID: ${task.id}`,
    `Lease token: ${leaseToken}`,
    `Meeting title: ${task.title}`,
    `Destination: ${task.destinationHint || "Yulu Meeting"}`,
    `Exact idempotency marker: yulu-${task.id}`,
    "",
    "Required order:",
    "1. Call the dedicated Yulu delivery MCP `recording_begin_notion_delivery` with taskId and leaseToken. Do not contact Notion unless it authorizes delivery.",
    "2. Call `recording_committed_summary_read` with taskId and leaseToken. Use only the Host-verified summary returned by that tool.",
    `3. Inspect the begin result. If the Host returns a verified existing page URL/ID, do not search or create: update exactly that page. Otherwise search Notion once for the exact marker yulu-${task.id}; update the single matching page, or create exactly one page only when the parsed result is explicitly empty.`,
    `4. Write the committed meeting summary to Notion and include yulu-${task.id} in the final page content.`,
    "5. Only after the single Notion write reports success, call `recording_commit_notion_delivery` with the returned page URL/id.",
    "",
    "Do not fabricate connector success. Finish with the Yulu task ID and verified Notion URL.",
  ].join("\n");
}

export function hermesRecordingToolsets(sendToNotion: boolean): readonly string[] {
  return sendToNotion ? ["yulu_delivery", "notion"] : ["yulu_artifact"];
}

interface ExportedToolCall {
  id: string;
  name: string;
  arguments: string;
  result: string;
}

function toolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); }
  catch { return ""; }
}

function canonicalHermesToolName(name: string): string {
  const match = /^mcp__([A-Za-z0-9_-]+)__([A-Za-z0-9_-]+)$/.exec(name);
  return match ? `mcp_${match[1]}_${match[2]}` : name;
}

function exportedToolCalls(value: unknown): ExportedToolCall[] {
  if (!value || typeof value !== "object") return [];
  const rows = Array.isArray(value) ? value : [value];
  const messages: unknown[] = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rowMessages = (row as { messages?: unknown }).messages;
    if (Array.isArray(rowMessages)) messages.push(...rowMessages);
  }
  const results = new Map<string, string>();
  for (const message of messages) {
    if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "tool") continue;
    const id = String((message as { tool_call_id?: unknown }).tool_call_id ?? "");
    if (id) results.set(id, toolContentText((message as { content?: unknown }).content));
  }
  const calls: ExportedToolCall[] = [];
  for (const message of messages) {
      if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") continue;
      const toolCalls = (message as { tool_calls?: unknown }).tool_calls;
      if (!Array.isArray(toolCalls)) continue;
      for (const call of toolCalls) {
        const id = call && typeof call === "object" ? String((call as { id?: unknown }).id ?? "") : "";
        const fn = call && typeof call === "object" ? (call as { function?: unknown }).function : null;
        if (!fn || typeof fn !== "object") continue;
        const name = canonicalHermesToolName(String((fn as { name?: unknown }).name ?? ""));
        const args = String((fn as { arguments?: unknown }).arguments ?? "");
        if (name) calls.push({ id, name, arguments: args, result: results.get(id) ?? "" });
      }
  }
  return calls;
}

function parsedToolArguments(call: ExportedToolCall | undefined): Record<string, unknown> | null {
  if (!call) return null;
  try {
    const value = JSON.parse(call.arguments) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function toolResultSucceeded(result: string): boolean {
  const text = result.trim();
  if (!text) return false;
  return !(
    /<tool_error\b/i.test(text) ||
    /"(?:ok|success)"\s*:\s*false/i.test(text) ||
    /"is_error"\s*:\s*true/i.test(text) ||
    /"error"\s*:/i.test(text) ||
    /\b(?:permission denied|unauthorized|forbidden|request failed)\b/i.test(text)
  );
}

function decodeNestedJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    let text = value.trim();
    // Hermes session exports may JSON-encode a string tool result before
    // storing it as message content. Decode that one layer before requiring the
    // wrapper to occupy the entire value; prose around a wrapper stays invalid.
    if (text.startsWith('"')) {
      try {
        const decoded = JSON.parse(text) as unknown;
        if (typeof decoded === "string") return decodeNestedJson(decoded, depth + 1);
      } catch { /* handled by the strict wrapper/JSON checks below */ }
    }
    const wrapped = /^<untrusted_tool_result(?:\s+[^>]*)?>\s*([\s\S]*?)\s*<\/untrusted_tool_result>$/.exec(text);
    if (wrapped) {
      text = wrapped[1]!.trim();
      // Hermes prepends a fixed untrusted-content warning inside the wrapper.
      // Only the final complete JSON object/array is connector data. Keeping
      // this exception inside a full-value wrapper rejects model prose around
      // the wrapper while accepting Hermes' real export format.
      if (!text.startsWith("{") && !text.startsWith("[")) {
        for (let index = 0; index < text.length; index += 1) {
          if (text[index] !== "{" && text[index] !== "[") continue;
          const candidate = text.slice(index).trim();
          try {
            const decoded = JSON.parse(candidate) as unknown;
            if (decoded && typeof decoded === "object") {
              return decodeNestedJson(decoded, depth + 1);
            }
          } catch { /* keep looking for the trailing complete JSON value */ }
        }
        return value;
      }
    }
    if (!text || (!text.startsWith("{") && !text.startsWith("["))) return value;
    try { return decodeNestedJson(JSON.parse(text), depth + 1); }
    catch { return value; }
  }
  if (Array.isArray(value)) return value.map((item) => decodeNestedJson(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => [key, decodeNestedJson(item, depth + 1)]));
  }
  return value;
}

function findSearchResults(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const nested = findSearchResults(item);
      if (nested) return nested;
    }
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.results)) return record.results;
  for (const item of Object.values(record)) {
    const nested = findSearchResults(item);
    if (nested) return nested;
  }
  return null;
}

function containsExactMarker(text: string, marker: string): boolean {
  let offset = 0;
  while (offset < text.length) {
    const index = text.indexOf(marker, offset);
    if (index < 0) return false;
    const before = index > 0 ? text[index - 1]! : "";
    const afterIndex = index + marker.length;
    const after = afterIndex < text.length ? text[afterIndex]! : "";
    if (!/[A-Za-z0-9-]/.test(before) && !/[A-Za-z0-9-]/.test(after)) return true;
    offset = index + marker.length;
  }
  return false;
}

function textualValueContainsMarker(value: unknown, marker: string): boolean {
  if (typeof value === "string") return containsExactMarker(value, marker);
  if (Array.isArray(value)) return value.some((item) => textualValueContainsMarker(item, marker));
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>)
    .some((item) => textualValueContainsMarker(item, marker));
}

function searchResultContainsMarker(value: unknown, marker: string): boolean {
  if (Array.isArray(value)) return value.some((item) => searchResultContainsMarker(item, marker));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, item]) => (
    (/^(?:highlight|highlights|text|snippet|content)$/i.test(key) &&
      textualValueContainsMarker(item, marker)) ||
    searchResultContainsMarker(item, marker)
  ));
}

function collectNotionIdentifiers(value: unknown, output = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    value.forEach((item) => collectNotionIdentifiers(item, output));
    return output;
  }
  if (!value || typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof item === "string" &&
      /^(?:id|page_?id|url)$/i.test(key) &&
      (isValidNotionPageId(item) || isTrustedNotionUrl(item))
    ) {
      const identity = isValidNotionPageId(item)
        ? canonicalNotionPageIdentity("", item)
        : canonicalNotionPageIdentity(item, "");
      if (identity) output.add(identity);
    }
    collectNotionIdentifiers(item, output);
  }
  return output;
}

function notionIdentityPairsAreConsistent(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(notionIdentityPairsAreConsistent);
  if (!value || typeof value !== "object") return true;
  const entries = Object.entries(value as Record<string, unknown>);
  const url = entries.find(([key, item]) => /^url$/i.test(key) && typeof item === "string" && isTrustedNotionUrl(item))?.[1];
  const pageId = entries.find(([key, item]) => /^(?:id|page_?id)$/i.test(key) && typeof item === "string" && isValidNotionPageId(item))?.[1];
  if (
    typeof url === "string" &&
    typeof pageId === "string" &&
    notionPageIdentityProblem(url, pageId)
  ) return false;
  return entries.every(([, item]) => notionIdentityPairsAreConsistent(item));
}

export function auditHermesSessionExport(raw: string, taskId: string, deliveryPhase: boolean): AgentSessionAudit {
  const parsed: unknown[] = [];
  const errors: string[] = [];
  for (const line of raw.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
    try { parsed.push(JSON.parse(line)); }
    catch { errors.push("Hermes session export contained invalid JSON"); }
  }
  const calls = exportedToolCalls(parsed);
  const toolNames = calls.map((call) => call.name);
  const callsFor = (name: string) => calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => (
      call.name === name && parsedToolArguments(call)?.taskId === taskId
    ));
  const artifactNames = new Set([
    "mcp_yulu_artifact_recording_task_get",
    "mcp_yulu_artifact_recording_task_progress",
    "mcp_yulu_artifact_recording_task_transcript_read",
    "mcp_yulu_artifact_recording_task_summary_stage",
    "mcp_yulu_artifact_recording_artifact_commit",
  ]);
  const deliveryNames = new Set([
    "mcp_yulu_delivery_recording_task_get",
    "mcp_yulu_delivery_recording_committed_summary_read",
    "mcp_yulu_delivery_recording_begin_notion_delivery",
    "mcp_yulu_delivery_recording_commit_notion_delivery",
    "mcp_notion_notion_search",
    "mcp_notion_notion_create_pages",
    "mcp_notion_notion_update_page",
  ]);
  const allowedNames = deliveryPhase ? deliveryNames : artifactNames;
  const unexpectedToolCalls = toolNames.filter((name) => !allowedNames.has(name));
  if (unexpectedToolCalls.length > 0) {
    errors.push(`Hermes session used tools outside the ${deliveryPhase ? "delivery" : "artifact"} capability set: ${[...new Set(unexpectedToolCalls)].join(", ")}`);
  }

  const transcriptReads = callsFor("mcp_yulu_artifact_recording_task_transcript_read");
  const summaryStages = callsFor("mcp_yulu_artifact_recording_task_summary_stage");
  const artifactCommits = callsFor("mcp_yulu_artifact_recording_artifact_commit");
  const artifactCommitIndex = artifactCommits[0]?.index ?? -1;
  const artifactCommit = artifactCommits.length === 1 && toolResultSucceeded(artifactCommits[0]!.call.result);

  const deliveryBegins = callsFor("mcp_yulu_delivery_recording_begin_notion_delivery");
  const summaryReads = callsFor("mcp_yulu_delivery_recording_committed_summary_read");
  const deliveryCommits = callsFor("mcp_yulu_delivery_recording_commit_notion_delivery");
  const notionDeliveryBeginIndex = deliveryBegins[0]?.index ?? -1;
  const notionDeliveryCommitIndex = deliveryCommits[0]?.index ?? -1;
  const notionDeliveryBegin = deliveryBegins.length === 1 && toolResultSucceeded(deliveryBegins[0]!.call.result);
  const notionDeliveryCommit = deliveryCommits.length === 1 && toolResultSucceeded(deliveryCommits[0]!.call.result);
  const decodedDeliveryBegin = notionDeliveryBegin
    ? decodeNestedJson(deliveryBegins[0]!.call.result)
    : null;
  const knownDeliveryIdentifiers = notionDeliveryBegin
    ? collectNotionIdentifiers(decodedDeliveryBegin)
    : new Set<string>();
  const hasKnownIdentity = knownDeliveryIdentifiers.size > 0;
  const hasKnownDelivery = hasKnownIdentity &&
    knownDeliveryIdentifiers.size === 1 &&
    notionIdentityPairsAreConsistent(decodedDeliveryBegin);
  const marker = `yulu-${taskId}`;
  const searchCalls = calls
    .map((call, index) => ({ call, index }))
    .filter(({ call }) => call.name === "mcp_notion_notion_search");
  const exactSearch = searchCalls.length === 1 && parsedToolArguments(searchCalls[0]!.call)?.query === marker
    ? searchCalls[0]!
    : undefined;
  const searchResults = exactSearch && toolResultSucceeded(exactSearch.call.result)
    ? findSearchResults(decodeNestedJson(exactSearch.call.result))
    : null;
  const exactMarkerResults = searchResults?.filter((result) => searchResultContainsMarker(result, marker)) ?? [];
  const candidateSearchIdentifiers = exactMarkerResults.length === 1
    ? collectNotionIdentifiers(exactMarkerResults[0])
    : new Set<string>();
  const exactMarkerIdentityValid = exactMarkerResults.length === 1 &&
    candidateSearchIdentifiers.size === 1 &&
    notionIdentityPairsAreConsistent(exactMarkerResults[0]);
  const notionSearchOutcome: "known" | "empty" | "match" | "invalid" = hasKnownDelivery
    ? searchCalls.length === 0 ? "known" : "invalid"
    : searchResults === null
      ? "invalid"
      : searchResults.length === 0
        ? "empty"
        : exactMarkerIdentityValid ? "match" : "invalid";
  const notionSearchIndex = notionSearchOutcome === "empty" || notionSearchOutcome === "match"
    ? exactSearch!.index
    : -1;
  const notionSearch = notionSearchIndex >= 0;
  const searchIdentifiers = notionSearchOutcome === "match"
    ? candidateSearchIdentifiers
    : new Set<string>();
  const notionWriteIndexes = calls.flatMap((call, index) => (
    call.name === "mcp_notion_notion_create_pages" || call.name === "mcp_notion_notion_update_page"
      ? [index]
      : []
  ));
  const notionWrites = notionWriteIndexes.map((index) => calls[index]!);
  const notionDeliveryCommitCall = deliveryCommits[0]?.call;
  const notionCommitArgs = parsedToolArguments(notionDeliveryCommitCall);
  const committedUrl = typeof notionCommitArgs?.url === "string" ? notionCommitArgs.url.trim() : "";
  const committedPageId = typeof notionCommitArgs?.pageId === "string" ? notionCommitArgs.pageId.trim() : "";
  const committedIdentity = notionPageIdentityProblem(committedUrl, committedPageId)
    ? null
    : canonicalNotionPageIdentity(committedUrl, committedPageId);
  const notionWrite = notionWrites.length === 1;
  const notionWriteArguments = notionWrites.length === 1
    ? parsedToolArguments(notionWrites[0])
    : null;
  const notionIdempotencyMarker = notionWriteArguments !== null &&
    textualValueContainsMarker(notionWriteArguments, marker);
  const writeResultIdentifiers = notionWrites.length === 1
    ? collectNotionIdentifiers(decodeNestedJson(notionWrites[0]!.result))
    : new Set<string>();
  const writeResultIdentityValid = notionWrites.length === 1 &&
    writeResultIdentifiers.size === 1 &&
    notionIdentityPairsAreConsistent(decodeNestedJson(notionWrites[0]!.result));
  const authorizedIdentifiers = notionSearchOutcome === "known"
    ? knownDeliveryIdentifiers
    : notionSearchOutcome === "match" ? searchIdentifiers : new Set<string>();
  const notionWriteResultVerified = notionWrites.length === 1 && (
    toolResultSucceeded(notionWrites[0]!.result) &&
    writeResultIdentityValid &&
    committedIdentity !== null &&
    writeResultIdentifiers.has(committedIdentity) &&
    (authorizedIdentifiers.size === 0 || (
      authorizedIdentifiers.size === 1 && authorizedIdentifiers.has(committedIdentity)
    ))
  );
  const writeArgumentIdentifiers = notionWrites.length === 1
    ? collectNotionIdentifiers(notionWriteArguments ?? {})
    : new Set<string>();
  const notionWriteModeValid = notionWrites.length === 1 && (
    notionSearchOutcome === "known"
      ? notionWrites[0]!.name === "mcp_notion_notion_update_page" &&
        [...knownDeliveryIdentifiers].some((identifier) => writeArgumentIdentifiers.has(identifier))
      : notionSearchOutcome === "empty"
      ? notionWrites[0]!.name === "mcp_notion_notion_create_pages"
      : notionSearchOutcome === "match" &&
        notionWrites[0]!.name === "mcp_notion_notion_update_page" &&
        searchIdentifiers.size > 0 &&
        [...searchIdentifiers].some((identifier) => writeArgumentIdentifiers.has(identifier))
  );
  const notionOrderValid = deliveryPhase
    ? notionDeliveryBeginIndex >= 0 &&
      summaryReads.length === 1 &&
      summaryReads[0]!.index > notionDeliveryBeginIndex &&
      notionWriteIndexes.length === 1 &&
      (notionSearchOutcome === "known"
        ? searchCalls.length === 0 && notionWriteIndexes[0]! > summaryReads[0]!.index
        : notionSearchIndex > summaryReads[0]!.index && notionWriteIndexes[0]! > notionSearchIndex) &&
      notionWriteIndexes[0]! < notionDeliveryCommitIndex
    : transcriptReads.length >= 1 &&
      summaryStages.length === 1 &&
      artifactCommits.length === 1 &&
      transcriptReads.every(({ index }) => index < summaryStages[0]!.index) &&
      summaryStages[0]!.index < artifactCommitIndex;

  if (!deliveryPhase) {
    if (transcriptReads.length < 1 || !transcriptReads.every(({ call }) => toolResultSucceeded(call.result))) {
      errors.push("Hermes artifact session did not successfully read the task-scoped transcript");
    }
    if (summaryStages.length !== 1 || !summaryStages.every(({ call }) => toolResultSucceeded(call.result))) {
      errors.push("Hermes artifact session must stage exactly one summary through Yulu");
    }
    if (!artifactCommit) errors.push("Hermes artifact session did not contain one successful Yulu artifact commit");
    if (!notionOrderValid) errors.push("Hermes artifact calls did not follow transcript read, summary stage, and artifact commit order");
  } else {
    if (!notionDeliveryBegin) errors.push("Hermes delivery session did not begin the authorized Notion delivery exactly once");
    if (hasKnownIdentity && !hasKnownDelivery) {
      errors.push("Hermes begin result contained an inconsistent or ambiguous existing Notion page identity");
    }
    if (summaryReads.length !== 1 || !summaryReads.every(({ call }) => toolResultSucceeded(call.result))) {
      errors.push("Hermes delivery session did not read exactly one Host-verified committed summary");
    }
    if (hasKnownDelivery && searchCalls.length > 0) {
      errors.push("Hermes searched Notion even though the Host returned a verified existing page");
    } else if (!hasKnownDelivery && !notionSearch) {
      errors.push("Hermes did not produce one successful, parseable exact-marker Notion search");
    }
    if (!notionWrite) errors.push("Hermes delivery session must contain exactly one Notion write tool call");
    if (!notionWriteModeValid) {
      errors.push(hasKnownDelivery
        ? "Hermes did not update the Host-verified existing Notion page"
        : "Hermes Notion write did not create after an empty search or update the matched page");
    }
    if (!notionIdempotencyMarker) errors.push("Hermes Notion write omitted the Yulu delivery idempotency marker");
    if (!notionWriteResultVerified) errors.push("Hermes Notion write result did not verify the reported page URL or ID");
    if (!notionDeliveryCommit) errors.push("Hermes delivery session did not report Notion delivery to Yulu exactly once");
    if (!notionOrderValid) errors.push("Hermes delivery calls did not follow authorization, committed-summary read, authorized page resolution, one write, and delivery commit order");
  }
  return {
    ok: errors.length === 0,
    toolNames,
    artifactCommit,
    notionDeliveryBegin,
    notionSearch,
    notionWrite,
    notionIdempotencyMarker,
    notionWriteResultVerified,
    notionDeliveryCommit,
    notionOrderValid,
    unexpectedToolCalls,
    notionSearchOutcome,
    notionWriteModeValid,
    errors,
  };
}

export class HermesRecordingGateway implements RecordingAgentGateway {
  readonly provider = "hermes";
  private contractProbePromise: Promise<string | null> | null = null;
  private contractProbePending = false;
  private contractProbeSettledAt = 0;

  constructor(
    private readonly runtime: AgentRuntime,
    private readonly configDir: string,
    private readonly scriptDir: string,
    private readonly options: { commandProbe?: HermesAsyncCommandProbe } = {},
  ) {}

  health(): AgentGatewayHealth {
    if (this.runtime.provider !== "hermes") {
      return { available: false, provider: this.runtime.provider, reason: "automatic recording tasks require the Hermes Agent" };
    }
    if (this.runtime.disabledReason || this.runtime.command.length === 0) {
      return { available: false, provider: "hermes", reason: this.runtime.disabledReason ?? "Hermes command is unavailable" };
    }
    const commandProblem = directHermesRecordingCommandProblem(this.runtime);
    if (commandProblem) return { available: false, provider: "hermes", reason: commandProblem };
    const env = envWithFallbackPath(process.env);
    const hermes = resolveExecutable(this.runtime.command[0]!, env);
    if (!existsSync(hermes)) return { available: false, provider: "hermes", reason: "Hermes CLI is unavailable" };
    return { available: true, provider: "hermes", reason: null };
  }

  async runArtifactWorkflow(input: AgentArtifactWorkflowInput): Promise<AgentWorkflowResult> {
    await this.requireRecordingContract();
    try { unlinkSync(input.workspace.summaryPath); } catch { /* stale summary absent */ }
    // Start a fresh native session for each durable attempt. Delivery starts a
    // different fresh session, so neither phase can inherit calls or raw
    // transcript context from an older attempt.
    return this.runWorkflowPhase({
      input,
      prompt: buildHermesRecordingPrompt(input),
      toolsets: hermesRecordingToolsets(false),
      sendToNotion: false,
    });
  }

  async runNotionWorkflow(input: AgentNotionWorkflowInput): Promise<AgentWorkflowResult> {
    await this.requireRecordingContract();
    if (!input.task.sendToNotion) throw new Error("Notion delivery was not authorized for this task");
    const deliveryDir = mkdtempSync(join(tmpdir(), "yulu-delivery-session-"));
    try {
      return await this.runWorkflowPhase({
        input: { ...input, workspace: { ...input.workspace, dir: deliveryDir } },
        prompt: buildHermesNotionDeliveryPrompt(input),
        toolsets: hermesRecordingToolsets(true),
        sendToNotion: true,
      });
    } finally {
      rmSync(deliveryDir, { recursive: true, force: true });
    }
  }

  close(): void {
    // The summary/delivery gateway owns no persistent child process.
  }

  private async requireRecordingContract(): Promise<void> {
    const health = this.health();
    if (!health.available) {
      throw new AgentUnavailableError(health.reason ?? "Hermes recording capability is unavailable");
    }
    const timestamp = Date.now();
    if (
      !this.contractProbePromise ||
      (!this.contractProbePending && timestamp - this.contractProbeSettledAt >= HERMES_CONTRACT_CACHE_MS)
    ) {
      const env = envWithFallbackPath(process.env);
      const hermes = resolveExecutable(this.runtime.command[0]!, env);
      this.contractProbePending = true;
      const probePromise = hermesRecordingContractProblemAsync(hermes, this.options.commandProbe)
        .catch((error) => `Hermes recording contract probe failed: ${(error as Error).message}`);
      this.contractProbePromise = probePromise;
      void probePromise.finally(() => {
        if (this.contractProbePromise === probePromise) {
          this.contractProbePending = false;
          this.contractProbeSettledAt = Date.now();
        }
      });
    }
    const problem = await this.contractProbePromise;
    if (problem) throw new AgentUnavailableError(problem);
  }

  private async runWorkflowPhase(args: {
    input: AgentArtifactWorkflowInput;
    prompt: string;
    toolsets: readonly string[];
    sendToNotion: boolean;
  }): Promise<AgentWorkflowResult> {
    const runtime = { ...this.runtime, cwd: args.input.workspace.dir };
    const result = await runAgentCliCommand({
      runtime,
      scriptDir: this.scriptDir,
      prompt: args.prompt,
      timeoutMs: HERMES_WORKFLOW_TIMEOUT_MS,
      yuluSessionId: args.input.task.id,
      configDir: this.configDir,
      hermesToolsets: args.toolsets,
    });
    if (result.code !== 0) {
      throw new Error(hermesWorkflowFailureMessage(result));
    }
    if (!result.nativeSessionId) throw new Error("Hermes did not return a native session id");
    const exported = await runProcess(runtime.command[0]!, [
      "sessions", "export", "--session-id", result.nativeSessionId, "-",
    ], { cwd: args.input.workspace.dir, timeoutMs: 60_000 });
    if (exported.code !== 0) throw new Error(`failed to export Hermes session: ${exported.stderr.trim()}`);
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      nativeSessionId: result.nativeSessionId,
      audit: auditHermesSessionExport(exported.stdout, args.input.task.id, args.sendToNotion),
    };
  }
}
