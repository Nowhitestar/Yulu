import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import { resolveBundledScriptArgs, runLlmCommand } from "./llmCommand.js";
import type { AgentRuntime } from "./agentRuntime.js";

export interface AgentCliRunResult {
  stdout: string;
  stderr: string;
  code: number;
  nativeSessionId?: string;
  rawStdout?: string;
  connectorWriteState?: "not-started" | "authorized" | "unknown";
}

export interface ConnectorToolPolicy {
  connector: string;
  allowedTools: readonly string[];
  readGuard?: {
    maxResults: number;
    maxWindowHours: number;
    timeWindowTools?: readonly string[];
  };
  writeGuard?: { destination: string; content: string };
}

interface CodexSessionIndexEntry {
  id: string;
  updatedAt: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_ANYWHERE_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig;
const HERMES_CONNECTOR_RE = /^[a-zA-Z0-9_.-]+$/;
const HERMES_CONNECTOR_DISCOVERY_TIMEOUT_SECONDS = 8;

function codexHome(): string {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function codexSessionIndexPath(): string {
  return join(codexHome(), "session_index.jsonl");
}

function readCodexSessionIndex(): CodexSessionIndexEntry[] {
  const path = codexSessionIndexPath();
  if (!existsSync(path)) return [];
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((row) => ({
        id: typeof row.id === "string" ? row.id : "",
        updatedAt: typeof row.updated_at === "string" ? row.updated_at : "",
      }))
      .filter((row) => UUID_RE.test(row.id));
  } catch {
    return [];
  }
}

function newestAddedCodexSession(before: CodexSessionIndexEntry[], after: CodexSessionIndexEntry[]): string | undefined {
  const seen = new Set(before.map((row) => row.id));
  return after
    .filter((row) => !seen.has(row.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
}

function isCodexRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "codex" && head.includes("codex");
}

function isClaudeRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "claude" && head.includes("claude");
}

function isHermesRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "hermes" && head.includes("hermes");
}

function isOpenClawRuntime(runtime: AgentRuntime): boolean {
  const head = basename(runtime.command[0] ?? "").toLowerCase();
  return runtime.provider === "openclaw" && head.includes("openclaw");
}

function stripCodexOutputFlags(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === "--json") continue;
    if (arg === "-o" || arg === "--output-last-message") {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function stripFlagWithValue(args: string[], flags: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (flags.has(arg)) {
      i += 1;
      continue;
    }
    out.push(arg);
  }
  return out;
}

function stripClaudeSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(["--session-id", "--resume", "-r"]));
}

function stripHermesSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(
    args,
    new Set(["--resume", "-r", "--query", "-q", "--toolsets", "-t"]),
  ).filter((arg) => (
    !/^--(?:resume|query|toolsets)=/.test(arg) &&
    !/^-(?:r|q|t).+/.test(arg)
  ));
}

function stripOpenClawSessionFlags(args: string[]): string[] {
  return stripFlagWithValue(args, new Set(["--session-id", "--message", "-m"]));
}

export function buildCodexSessionCommand(
  command: string[],
  input: { nativeSessionId?: string; outputPath: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripCodexOutputFlags(rawArgs);
  const execIndex = args.findIndex((arg) => arg === "exec" || arg === "e");
  if (execIndex < 0) return command;
  const withOutput = [...args, "--json", "-o", input.outputPath];
  if (input.nativeSessionId) {
    return [head, ...withOutput, "resume", input.nativeSessionId, "-"];
  }
  return [head, ...withOutput, "-"];
}

export function buildClaudeSessionCommand(
  command: string[],
  input: { nativeSessionId: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripClaudeSessionFlags(rawArgs);
  if (!args.includes("--print") && !args.includes("-p")) args.unshift("--print");
  return [head, ...args, "--session-id", input.nativeSessionId];
}

export function buildHermesSessionCommand(
  command: string[],
  input: { nativeSessionId?: string; prompt: string; toolsets?: readonly string[] },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripHermesSessionFlags(rawArgs);
  if (!args.includes("chat")) args.unshift("chat");
  if (!args.includes("-Q") && !args.includes("--quiet")) args.push("-Q");
  if (!args.includes("--source")) args.push("--source", "yulu");
  if (input.nativeSessionId) args.push("--resume", input.nativeSessionId);
  if (input.toolsets !== undefined) {
    const toolsets = [...new Set(input.toolsets.map((value) => value.trim()).filter(Boolean))];
    if (toolsets.length === 0) throw new Error("Hermes toolsets must not be empty");
    args.push("--toolsets", toolsets.join(","));
  }
  return [head, ...args, "--query", input.prompt];
}

export function buildOpenClawSessionCommand(
  command: string[],
  input: { nativeSessionId: string; prompt: string },
): string[] {
  const [head, ...rawArgs] = command;
  if (!head) return command;
  const args = stripOpenClawSessionFlags(rawArgs);
  if (!args.includes("agent")) args.unshift("agent");
  if (!args.includes("--json")) args.push("--json");
  return [head, ...args, "--session-id", input.nativeSessionId, "--message", input.prompt];
}

function findSessionId(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findSessionId(item);
      if (found) return found;
    }
    return undefined;
  }
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (
      typeof raw === "string" &&
      UUID_RE.test(raw) &&
      /(?:session|conversation|thread).*id/i.test(key)
    ) {
      return raw;
    }
    const nested = findSessionId(raw);
    if (nested) return nested;
  }
  return undefined;
}

function extractCodexSessionId(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const found = findSessionId(JSON.parse(trimmed));
      if (found) return found;
    } catch {
      // Non-JSON lines are allowed in CLI output.
    }
  }
  return undefined;
}

function extractAnySessionId(text: string): string | undefined {
  UUID_ANYWHERE_RE.lastIndex = 0;
  return UUID_ANYWHERE_RE.exec(text)?.[0];
}

export function extractHermesSessionId(stderr: string): string | undefined {
  for (const line of stderr.split(/\r?\n/)) {
    const match = /^\s*session_id:\s*(\S+)\s*$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Build a short-lived Hermes config that exposes exactly one MCP connector.
 *
 * Hermes discovers MCP servers in the background. A one-shot share can reach
 * its first model turn before a stdio connector has registered its tools. The
 * scoped config both extends that bounded wait and avoids starting unrelated
 * connectors, while leaving the user's real Hermes config untouched.
 */
export function buildHermesConnectorConfig(
  raw: string,
  connector: string,
): string {
  if (!HERMES_CONNECTOR_RE.test(connector)) {
    throw new Error(`Invalid Hermes connector name: ${connector}`);
  }
  const config = parseYaml(raw) as Record<string, unknown> | null;
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("Hermes config is not a YAML object");
  }
  const servers = config.mcp_servers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error("Hermes config has no mcp_servers section");
  }
  const server = (servers as Record<string, unknown>)[connector];
  if (!server) throw new Error(`Hermes connector is not configured: ${connector}`);
  config.mcp_servers = { [connector]: server };
  config.mcp_discovery_timeout = HERMES_CONNECTOR_DISCOVERY_TIMEOUT_SECONDS;
  return stringifyYaml(config);
}

interface HermesConnectorProfile {
  home: string;
  cleanup: () => void;
}

export function prepareHermesConnectorProfile(
  connector: string,
  sourceHome?: string,
): HermesConnectorProfile {
  const source = sourceHome || process.env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
  const configPath = join(source, "config.yaml");
  if (!existsSync(configPath)) throw new Error(`Hermes config not found: ${configPath}`);

  const home = mkdtempSync(join(tmpdir(), "yulu-hermes-connector-"));
  chmodSync(home, 0o700);
  try {
    for (const entry of readdirSync(source)) {
      if (entry === "config.yaml") continue;
      symlinkSync(join(source, entry), join(home, entry));
    }
    const config = buildHermesConnectorConfig(readFileSync(configPath, "utf8"), connector);
    writeFileSync(join(home, "config.yaml"), config, { encoding: "utf8", mode: 0o600 });
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function connectorPolicy(policy: ConnectorToolPolicy): ConnectorToolPolicy {
  if (!HERMES_CONNECTOR_RE.test(policy.connector)) {
    throw new Error(`Invalid connector name: ${policy.connector}`);
  }
  const allowedTools = [...new Set(policy.allowedTools.map((tool) => tool.trim()).filter(Boolean))];
  if (allowedTools.length === 0 || allowedTools.some((tool) => !/^[a-zA-Z0-9_.-]+$/.test(tool))) {
    throw new Error("Connector tool allowlist must contain only explicit tool names");
  }
  const readGuard = policy.readGuard
    ? {
        maxResults: policy.readGuard.maxResults,
        maxWindowHours: policy.readGuard.maxWindowHours,
        timeWindowTools: [...new Set(policy.readGuard.timeWindowTools ?? [])],
      }
    : undefined;
  if (readGuard && (
    !Number.isSafeInteger(readGuard.maxResults) || readGuard.maxResults < 1 ||
    !Number.isSafeInteger(readGuard.maxWindowHours) || readGuard.maxWindowHours < 1 ||
    readGuard.timeWindowTools.some((tool) => !allowedTools.includes(tool))
  )) {
    throw new Error("Connector read guard must define positive bounds for allowed tools");
  }
  return { ...policy, connector: policy.connector, allowedTools, readGuard };
}

function connectorServerNames(connector: string): string[] {
  return connector === "zulip" ? ["zulip", "zulipchat"] : [connector];
}

export function buildSharingGuardSource(rawPolicy: ConnectorToolPolicy, auditPath: string): string {
  const policy = connectorPolicy(rawPolicy);
  const expected = JSON.stringify({
    connector: policy.connector,
    tools: policy.allowedTools,
    readGuard: policy.readGuard,
    ...policy.writeGuard,
  });
  return `
import { appendFileSync, writeFileSync } from "node:fs";
const expected = ${expected};
const auditPath = ${JSON.stringify(auditPath)};
const readAuthorizationPath = auditPath + ".read-authorized";
const writeAuthorizationPath = auditPath + ".write-authorized";
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const audit = (decision, tool = "") => appendFileSync(auditPath, JSON.stringify({ decision, tool }) + "\\n", { encoding: "utf8", mode: 0o600 });
  const deny = (message, tool = "") => { audit("deny", tool); process.stderr.write(message); process.exit(2); };
  let event;
  try { event = JSON.parse(raw); } catch { return deny("Invalid Sharing authorization event"); }
  if (event?.hook_event_name === "SessionStart") { audit("ready"); process.exit(0); }
  const input = event && typeof event.tool_input === "object" && event.tool_input ? event.tool_input : {};
  const tool = String(event?.tool_name || "");
  const serverNames = expected.connector === "zulip" ? ["zulip", "zulipchat"] : [expected.connector];
  const allowedNames = serverNames.flatMap((server) => expected.tools.map((name) => \`mcp__\${server}__\${name}\`));
  if (!allowedNames.includes(tool)) return deny("Sharing blocked an unexpected connector tool", tool);
  if (expected.readGuard) {
    const toolName = expected.tools.find((name) => serverNames.some((server) => tool === \`mcp__\${server}__\${name}\`));
    const limitKeys = ["max_results", "maxResults", "limit", "page_size", "pageSize"];
    const limitKey = limitKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
    const limit = limitKey ? input[limitKey] : undefined;
    if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > expected.readGuard.maxResults) {
      return deny("Connector read blocked because its result bound is missing or too large", tool);
    }
    const startKeys = ["time_min", "timeMin", "start", "start_time", "startTime"];
    const endKeys = ["time_max", "timeMax", "end", "end_time", "endTime"];
    const startKey = startKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
    const endKey = endKeys.find((key) => Object.prototype.hasOwnProperty.call(input, key));
    const needsWindow = expected.readGuard.timeWindowTools.includes(toolName);
    if (needsWindow || startKey || endKey) {
      const start = startKey ? Date.parse(String(input[startKey])) : NaN;
      const end = endKey ? Date.parse(String(input[endKey])) : NaN;
      const maxWindowMs = expected.readGuard.maxWindowHours * 60 * 60 * 1000;
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || end - start > maxWindowMs) {
        return deny("Connector read blocked because its time window is missing or too large", tool);
      }
    }
    try {
      writeFileSync(readAuthorizationPath, tool, { encoding: "utf8", mode: 0o600, flag: "wx" });
    } catch {
      return deny("Connector read blocked more than one operation", tool);
    }
    audit("allow", tool);
    process.exit(0);
  }
  if (typeof expected.destination !== "string" || typeof expected.content !== "string") {
    audit("allow", tool);
    process.exit(0);
  }
  const parse = (value) => { try { return JSON.parse(value); } catch { return value; } };
  const stable = (value) => {
    if (Array.isArray(value)) return \`[\${value.map(stable).join(",")}]\`;
    if (value && typeof value === "object") return \`{\${Object.keys(value).sort().map((key) => \`\${JSON.stringify(key)}:\${stable(value[key])}\`).join(",")}}\`;
    return JSON.stringify(value);
  };
  const exactKeys = (value, keys) => Boolean(
    value && typeof value === "object" && !Array.isArray(value) &&
    stable(Object.keys(value).sort()) === stable([...keys].sort())
  );
  const payloadMatches = () => {
    const wanted = parse(expected.destination);
    if (expected.connector === "notion") {
      const parent = parse(input.parent);
      const pages = parse(input.pages);
      return Boolean(
        exactKeys(input, ["parent", "pages"]) &&
        wanted && typeof wanted === "object" && !Array.isArray(wanted) &&
        parent && typeof parent === "object" && !Array.isArray(parent) &&
        stable(parent) === stable(wanted) &&
        Array.isArray(pages) && pages.length === 1 &&
        pages[0] && typeof pages[0] === "object" && !Array.isArray(pages[0]) &&
        exactKeys(pages[0], ["content"]) &&
        pages[0].content === expected.content
      );
    }
    const keys = input.type === "stream"
      ? ["type", "to", "topic", "content"]
      : ["type", "to", "content"];
    const observed = input.type === "stream"
      ? { type: "stream", to: input.to, topic: input.topic }
      : { type: input.type, to: input.to };
    return exactKeys(input, keys) && stable(observed) === stable(wanted) && input.content === expected.content;
  };
  if (!payloadMatches()) return deny("Sharing blocked a payload mismatch", tool);
  try {
    writeFileSync(writeAuthorizationPath, tool, { encoding: "utf8", mode: 0o600, flag: "wx" });
  } catch {
    return deny("Sharing blocked more than one external write", tool);
  }
  audit("allow", tool);
  process.exit(0);
});
`;
}

export interface CodexConnectorProfile {
  cwd: string;
  guardPath: string;
  auditPath: string;
  cleanup: () => void;
}

function hookCommand(guardPath: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(guardPath)}`;
}

export function prepareCodexConnectorProfile(
  rawPolicy: ConnectorToolPolicy,
): CodexConnectorProfile {
  const policy = connectorPolicy(rawPolicy);
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "yulu-codex-sharing-")));
  chmodSync(cwd, 0o700);
  const gitDir = join(cwd, ".git");
  mkdirSync(join(gitDir, "objects"), { recursive: true, mode: 0o700 });
  mkdirSync(join(gitDir, "refs", "heads"), { recursive: true, mode: 0o700 });
  writeFileSync(join(gitDir, "HEAD"), "ref: refs/heads/main\n", { encoding: "utf8", mode: 0o600 });
  writeFileSync(join(gitDir, "config"), [
    "[core]",
    "\trepositoryformatversion = 0",
    "\tfilemode = true",
    "\tbare = false",
    "\tlogallrefupdates = true",
    "",
  ].join("\n"), { encoding: "utf8", mode: 0o600 });
  const projectConfigDir = join(cwd, ".codex");
  mkdirSync(projectConfigDir, { mode: 0o700 });
  writeFileSync(join(projectConfigDir, "config.toml"), "", { encoding: "utf8", mode: 0o600 });
  const guardPath = join(projectConfigDir, "sharing-guard.mjs");
  const auditPath = join(projectConfigDir, "sharing-guard-audit.jsonl");
  writeFileSync(guardPath, buildSharingGuardSource(policy, auditPath), { encoding: "utf8", mode: 0o700 });
  return {
    cwd,
    guardPath,
    auditPath,
    cleanup: () => rmSync(cwd, { recursive: true, force: true }),
  };
}

export function buildCodexConnectorCommand(
  command: string[],
  profile: Pick<CodexConnectorProfile, "cwd" | "guardPath">,
): string[] {
  const handler = `{type="command",command=${JSON.stringify(hookCommand(profile.guardPath))},timeout=5}`;
  const hooks = `{SessionStart=[{hooks=[${handler}]}],PreToolUse=[{matcher=".*",hooks=[${handler}]}]}`;
  return [
    ...command,
    "-c", `projects.${JSON.stringify(profile.cwd)}.trust_level="trusted"`,
    "-c", `hooks=${hooks}`,
    "--dangerously-bypass-hook-trust",
  ];
}

function inspectSharingHookAudit(profile: Pick<CodexConnectorProfile, "auditPath">): {
  error: string | null;
  writeState: NonNullable<AgentCliRunResult["connectorWriteState"]>;
} {
  if (!existsSync(profile.auditPath)) return {
    error: "Sharing guard did not execute; connector operation was not authorized",
    writeState: "unknown",
  };
  const decisions = readFileSync(profile.auditPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line): string[] => {
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        return typeof value.decision === "string" ? [value.decision] : [];
      } catch {
        return [];
      }
    });
  if (decisions.includes("deny")) {
    return decisions.includes("allow") ? {
      error: "Sharing guard denied a tool call after an authorized connector write",
      writeState: "authorized",
    } : {
      error: "Sharing guard denied before any connector write was authorized",
      writeState: "not-started",
    };
  }
  if (!decisions.includes("ready") || !decisions.includes("allow")) {
    return {
      error: "Sharing guard did not prove lifecycle and pre-tool authorization",
      writeState: "unknown",
    };
  }
  return { error: null, writeState: "authorized" };
}

interface ClaudeConnectorProfile {
  configPaths: string[];
  settingsPath: string;
  auditPath: string;
  cleanup: () => void;
}

function prepareClaudeConnectorProfile(policy: ConnectorToolPolicy, cwd: string): ClaudeConnectorProfile {
  const configPaths = [
    join(cwd, ".mcp.json"),
    join(homedir(), ".claude.json"),
  ].filter((path) => existsSync(path));
  if (configPaths.length === 0) throw new Error(`Claude Code connector configuration is unavailable: ${policy.connector}`);
  const home = mkdtempSync(join(tmpdir(), "yulu-claude-sharing-"));
  chmodSync(home, 0o700);
  const settingsPath = join(home, "settings.json");
  const guardPath = join(home, "sharing-guard.mjs");
  const auditPath = join(home, "sharing-guard-audit.jsonl");
  const serverNames = connectorServerNames(policy.connector);
  const allowed = serverNames.flatMap((server) => (
    policy.allowedTools.map((tool) => `mcp__${server}__${tool}`)
  ));
  const settings: Record<string, unknown> = {
    disableClaudeAiConnectors: true,
    permissions: { allow: allowed },
  };
  writeFileSync(guardPath, buildSharingGuardSource(policy, auditPath), { encoding: "utf8", mode: 0o700 });
  settings.hooks = {
    SessionStart: [{ hooks: [{ type: "command", command: hookCommand(guardPath), timeout: 5 }] }],
    PreToolUse: [{
      matcher: ".*",
      hooks: [{ type: "command", command: hookCommand(guardPath), timeout: 5 }],
    }],
  };
  writeFileSync(settingsPath, JSON.stringify(settings), { encoding: "utf8", mode: 0o600 });
  return { configPaths, settingsPath, auditPath, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

export function buildClaudeConnectorCommand(
  command: string[],
  profile: Pick<ClaudeConnectorProfile, "configPaths" | "settingsPath">,
  rawPolicy: ConnectorToolPolicy,
): string[] {
  const policy = connectorPolicy(rawPolicy);
  const allowed = connectorServerNames(policy.connector).flatMap((server) => (
    policy.allowedTools.map((tool) => `mcp__${server}__${tool}`)
  ));
  return [
    ...command,
    "--tools", "",
    "--permission-mode", "dontAsk",
    "--allowedTools", allowed.join(","),
    "--strict-mcp-config",
    "--mcp-config", ...profile.configPaths,
    "--setting-sources", "",
    "--settings", profile.settingsPath,
    "--disable-slash-commands",
    "--no-chrome",
    "--system-prompt", "",
    "--no-session-persistence",
  ];
}

function extractCodexFinalMessage(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      const text =
        typeof parsed.text === "string" ? parsed.text :
        typeof parsed.message === "string" ? parsed.message :
        typeof parsed.content === "string" ? parsed.content :
        "";
      if (text) last = text;
    } catch {
      // Ignore non-event output.
    }
  }
  return last;
}

function findLikelyText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findLikelyText(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  for (const key of ["response", "reply", "answer", "message", "text", "content", "output"]) {
    const raw = record[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
  }
  for (const raw of Object.values(record)) {
    const found = findLikelyText(raw);
    if (found) return found;
  }
  return undefined;
}

function extractOpenClawFinalMessage(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return "";
  try {
    return findLikelyText(JSON.parse(trimmed)) ?? "";
  } catch {
    return "";
  }
}

function extractClaudeFinalMessage(stdout: string): string {
  let last = "";
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value = JSON.parse(trimmed) as Record<string, unknown>;
      if (value.type === "result" && typeof value.result === "string") last = value.result.trim();
    } catch {
      // Ignore non-event output.
    }
  }
  return last;
}

function runSpawnCommand(command: string[], input: {
  cwd: string;
  stdin: string;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const [rawCmd, ...args] = resolveBundledScriptArgs(command, input.cwd);
    const spawnEnv = envWithFallbackPath({ ...process.env, ...input.env });
    const cmd = rawCmd ? resolveExecutable(rawCmd, spawnEnv) : "";
    if (!cmd) {
      resolve({ stdout: "", stderr: "agent command is empty", code: 1 });
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: { stdout: string; stderr: string; code: number }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const proc = spawn(cmd, args, { cwd: input.cwd, env: spawnEnv });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, input.timeoutMs);
    proc.stdin.write(input.stdin);
    proc.stdin.end();
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr: stderr || err.message, code: 1 });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code: code ?? 1 });
    });
  });
}

async function requireCodexSharingHooks(runtime: AgentRuntime, timeoutMs: number): Promise<string | null> {
  const executable = runtime.command[0];
  if (!executable) return "Codex hooks are unavailable because the configured command is empty";
  const result = await runSpawnCommand([executable, "features", "list"], {
    cwd: runtime.cwd,
    stdin: "",
    timeoutMs: Math.min(timeoutMs, 5_000),
  });
  if (result.code === 0 && /^hooks\s+stable\s+true\s*$/m.test(result.stdout)) return null;
  const detail = (result.stderr || result.stdout).trim();
  return [
    'Codex hooks are unavailable; update Codex until "codex features list" reports "hooks stable true"',
    detail,
  ].filter(Boolean).join("\n");
}

export async function runAgentCliCommand(args: {
  runtime: AgentRuntime;
  scriptDir: string;
  prompt: string;
  timeoutMs: number;
  nativeSessionId?: string;
  yuluSessionId?: string;
  configDir?: string;
  hermesToolsets?: readonly string[];
  hermesConnector?: string;
  connectorToolPolicy?: ConnectorToolPolicy;
}): Promise<AgentCliRunResult> {
  if (!args.configDir) {
    return runLlmCommand(args.runtime.command, args.scriptDir, args.prompt, args.timeoutMs, args.runtime.cwd);
  }

  if (isClaudeRuntime(args.runtime)) {
    const nativeSessionId = args.nativeSessionId || args.yuluSessionId || randomUUID();
    let command = buildClaudeSessionCommand(args.runtime.command, { nativeSessionId });
    const profile = args.connectorToolPolicy
      ? prepareClaudeConnectorProfile(connectorPolicy(args.connectorToolPolicy), args.runtime.cwd)
      : null;
    if (profile && args.connectorToolPolicy) {
      command = buildClaudeConnectorCommand(command, profile, args.connectorToolPolicy);
    }
    let result: AgentCliRunResult;
    try {
      result = await runSpawnCommand(command, {
        cwd: args.runtime.cwd,
        stdin: args.prompt,
        timeoutMs: args.timeoutMs,
      });
      if (profile) {
        const audit = inspectSharingHookAudit(profile);
        result = { ...result, connectorWriteState: audit.writeState };
        if (audit.error) result = {
          ...result,
          stderr: [result.stderr.trim(), audit.error].filter(Boolean).join("\n"),
          code: 1,
        };
      }
    } finally {
      profile?.cleanup();
    }
    return {
      ...result,
      stdout: extractClaudeFinalMessage(result.stdout) || result.stdout,
      nativeSessionId,
      rawStdout: result.stdout,
    };
  }

  if (isHermesRuntime(args.runtime)) {
    if (args.connectorToolPolicy) {
      return {
        stdout: "",
        stderr: "Hermes does not provide the required Sharing pre-tool authorization boundary",
        code: 1,
        connectorWriteState: "not-started",
      };
    }
    const command = buildHermesSessionCommand(args.runtime.command, {
      nativeSessionId: args.nativeSessionId,
      prompt: args.prompt,
      toolsets: args.hermesToolsets,
    });
    const profile = args.hermesConnector
      ? prepareHermesConnectorProfile(args.hermesConnector)
      : null;
    let result: { stdout: string; stderr: string; code: number };
    try {
      result = await runSpawnCommand(command, {
        cwd: args.runtime.cwd,
        stdin: "",
        timeoutMs: args.timeoutMs,
        env: profile ? { HERMES_HOME: profile.home } : undefined,
      });
    } finally {
      profile?.cleanup();
    }
    const nativeSessionId =
      args.nativeSessionId ||
      extractHermesSessionId(result.stderr) ||
      extractAnySessionId(`${result.stdout}\n${result.stderr}`);
    return { ...result, nativeSessionId };
  }

  if (isOpenClawRuntime(args.runtime)) {
    const nativeSessionId = args.nativeSessionId || args.yuluSessionId || randomUUID();
    const command = buildOpenClawSessionCommand(args.runtime.command, {
      nativeSessionId,
      prompt: args.prompt,
    });
    const result = await runSpawnCommand(command, {
      cwd: args.runtime.cwd,
      stdin: "",
      timeoutMs: args.timeoutMs,
    });
    return {
      ...result,
      stdout: extractOpenClawFinalMessage(result.stdout) || result.stdout,
      nativeSessionId,
      rawStdout: result.stdout,
    };
  }

  if (!isCodexRuntime(args.runtime)) {
    return runLlmCommand(args.runtime.command, args.scriptDir, args.prompt, args.timeoutMs, args.runtime.cwd);
  }

  if (args.connectorToolPolicy) {
    const hooksError = await requireCodexSharingHooks(args.runtime, args.timeoutMs);
    if (hooksError) return {
      stdout: "", stderr: hooksError, code: 1, connectorWriteState: "not-started",
    };
  }

  mkdirSync(args.configDir, { recursive: true });
  const outputPath = join(args.configDir, `codex-last-message.${process.pid}.${Date.now()}.${randomUUID()}.txt`);
  const before = args.nativeSessionId ? [] : readCodexSessionIndex();
  const profile = args.connectorToolPolicy
    ? prepareCodexConnectorProfile(args.connectorToolPolicy)
    : null;
  const runtimeCommand = profile
    ? buildCodexConnectorCommand(args.runtime.command, profile)
    : args.runtime.command;
  const command = buildCodexSessionCommand(runtimeCommand, {
    nativeSessionId: args.nativeSessionId,
    outputPath,
  });
  let result: AgentCliRunResult;
  try {
    result = await runSpawnCommand(command, {
      cwd: profile?.cwd ?? args.runtime.cwd,
      stdin: args.prompt,
      timeoutMs: args.timeoutMs,
    });
    if (profile) {
      const audit = inspectSharingHookAudit(profile);
      result = { ...result, connectorWriteState: audit.writeState };
      if (audit.error) result = {
        ...result,
        stderr: [result.stderr.trim(), audit.error].filter(Boolean).join("\n"),
        code: 1,
      };
    }
  } finally {
    profile?.cleanup();
  }
  const fileMessage = existsSync(outputPath) ? readFileSync(outputPath, "utf8").trim() : "";
  try {
    if (existsSync(outputPath)) unlinkSync(outputPath);
  } catch {
    // Best effort cleanup only.
  }
  const nativeSessionId =
    args.nativeSessionId ||
    extractCodexSessionId(result.stdout) ||
    newestAddedCodexSession(before, readCodexSessionIndex());
  return {
    stdout: fileMessage || extractCodexFinalMessage(result.stdout) || result.stdout,
    stderr: result.stderr,
    code: result.code,
    nativeSessionId,
    rawStdout: result.stdout,
    connectorWriteState: result.connectorWriteState,
  };
}
