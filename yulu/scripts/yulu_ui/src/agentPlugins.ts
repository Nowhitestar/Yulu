import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type ConsoleAgentId = "codex" | "claude" | "hermes" | "openclaw";
export type AgentPluginId = "summary" | "notion" | "zulip" | "calendar";
export type AgentPluginStatus = "configured" | "unconfigured" | "unsupported";
export type AgentDestinationChannel = "notion" | "zulip";

export interface AgentDestinationView {
  channel: AgentDestinationChannel;
  label: string;
  value: string;
  configured: boolean;
  missingReason: string;
  notion?: { target: string };
  zulip?: { stream: string; topic: string };
}

export interface AgentPluginState {
  id: AgentPluginId;
  label: string;
  added: boolean;
  core: boolean;
  status: AgentPluginStatus;
  statusLabel: string;
  resolvedPath: string;
  detail: string;
  configureLabel: string;
  agent: ConsoleAgentId | null;
  destination?: AgentDestinationView;
}

export interface AgentPluginOverview {
  agent: ConsoleAgentId | null;
  current: AgentPluginState[];
  available: AgentPluginState[];
  all: AgentPluginState[];
}

export interface ConfigurePluginAction {
  ok: boolean;
  agent: ConsoleAgentId | null;
  plugin: AgentPluginId;
  label: string;
  agentCli: string;
  message: string;
}

const PLUGIN_IDS = ["summary", "notion", "zulip", "calendar"] as const;
const DEFAULT_ADDED: AgentPluginId[] = ["summary"];

const PLUGIN_META: Record<AgentPluginId, { label: string; aliases: string[]; core?: boolean }> = {
  summary: { label: "总结", aliases: [], core: true },
  notion: { label: "Notion", aliases: ["notion"] },
  zulip: { label: "Zulip", aliases: ["zulip", "zulipchat"] },
  calendar: { label: "日历", aliases: ["calendar", "google-calendar", "google_calendar", "gog"] },
};

const AGENT_LABEL: Record<ConsoleAgentId, string> = {
  codex: "Codex CLI",
  claude: "Claude Code",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const DEFAULT_NOTION_TARGET = "Yulu Meeting";

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeAgent(value: unknown): ConsoleAgentId | null {
  const id = String(value ?? "").trim().toLowerCase();
  if (id === "codex" || id === "claude" || id === "hermes" || id === "openclaw") return id;
  if (id === "claude-code") return "claude";
  return null;
}

export function normalizeConsoleAgent(value: unknown): ConsoleAgentId | null {
  return normalizeAgent(value);
}

function sanitizePluginIds(value: unknown): AgentPluginId[] {
  const seen = new Set<AgentPluginId>();
  const out: AgentPluginId[] = [];
  const items = Array.isArray(value) ? value : DEFAULT_ADDED;
  for (const item of items) {
    const id = String(item).trim().toLowerCase();
    if (!PLUGIN_IDS.includes(id as AgentPluginId)) continue;
    if (seen.has(id as AgentPluginId)) continue;
    seen.add(id as AgentPluginId);
    out.push(id as AgentPluginId);
  }
  if (!seen.has("summary")) out.unshift("summary");
  return out;
}

export function addedPluginIds(config: unknown): AgentPluginId[] {
  const root = asRecord(config);
  const agentConsole = asRecord(root.agent_console);
  const plugins = asRecord(agentConsole.plugins);
  return sanitizePluginIds(plugins.added);
}

export function withAddedPlugin(config: unknown, plugin: AgentPluginId): AgentPluginId[] {
  const ids = addedPluginIds(config);
  return ids.includes(plugin) ? ids : [...ids, plugin];
}

export function withoutAddedPlugin(config: unknown, plugin: AgentPluginId): AgentPluginId[] {
  if (plugin === "summary") return addedPluginIds(config);
  return addedPluginIds(config).filter((id) => id !== plugin);
}

function stringValue(root: Record<string, unknown>, key: string): string {
  return typeof root[key] === "string" ? String(root[key]).trim() : "";
}

function destinationRoot(config: unknown, agent: ConsoleAgentId | null): Record<string, unknown> {
  if (!agent) return {};
  const root = asRecord(config);
  const consoleConfig = asRecord(root.agent_console);
  const destinations = asRecord(consoleConfig.destinations);
  return asRecord(destinations[agent]);
}

export function agentDestinationView(
  config: unknown,
  agent: ConsoleAgentId | null,
  channel: AgentDestinationChannel,
): AgentDestinationView {
  const root = destinationRoot(config, agent);
  if (channel === "notion") {
    const notion = asRecord(root.notion);
    const target = stringValue(notion, "target") || DEFAULT_NOTION_TARGET;
    return {
      channel,
      label: "Notion",
      value: target,
      configured: target.length > 0,
      missingReason: target.length > 0 ? "" : "请选择 Notion 页面或数据库",
      notion: { target },
    };
  }

  const zulip = asRecord(root.zulip);
  const stream = stringValue(zulip, "stream");
  const topic = stringValue(zulip, "topic");
  const configured = stream.length > 0 && topic.length > 0;
  return {
    channel,
    label: "Zulip",
    value: configured ? `${stream} / ${topic}` : "选择 Channel 和 Topic",
    configured,
    missingReason: configured ? "" : "请选择 Zulip Channel 和 Topic",
    zulip: { stream, topic },
  };
}

export function agentDestinationHint(
  config: unknown,
  agent: ConsoleAgentId | null,
  channel: AgentDestinationChannel,
  title: string,
): string {
  const destination = agentDestinationView(config, agent, channel);
  if (channel === "notion") {
    return destination.notion?.target || DEFAULT_NOTION_TARGET;
  }
  const stream = destination.zulip?.stream ?? "";
  const topic = destination.zulip?.topic || title;
  return stream ? `Zulip stream/channel "${stream}", topic "${topic}"` : "";
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

function splitEnvRoots(value: string | undefined): string[] {
  if (!value) return [];
  return value.split(":").map((item) => item.trim()).filter(Boolean).map(expandHome);
}

function agentPluginRoots(agent: ConsoleAgentId): string[] {
  const envKey = `YULU_${agent.toUpperCase()}_PLUGIN_ROOTS`;
  const roots = [
    ...splitEnvRoots(process.env[envKey]),
    ...splitEnvRoots(process.env.YULU_AGENT_PLUGIN_ROOTS),
  ];
  if (process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY === "1") return roots;
  if (agent === "codex") {
    roots.push(expandHome("~/.codex/plugins/cache"), expandHome("~/.codex/plugins"));
  } else if (agent === "claude") {
    roots.push(expandHome("~/.claude/plugins"), expandHome("~/.config/claude/plugins"));
  } else if (agent === "hermes") {
    roots.push(expandHome("~/.hermes/plugins"), expandHome("~/.config/hermes/plugins"));
  } else {
    roots.push(expandHome("~/.openclaw/plugins"), expandHome("~/.config/openclaw/plugins"));
  }
  return roots;
}

function findPluginPath(agent: ConsoleAgentId, plugin: AgentPluginId): string {
  const aliases = PLUGIN_META[plugin].aliases.map((alias) => alias.toLowerCase());
  if (aliases.length === 0) return "";
  for (const root of agentPluginRoots(agent)) {
    const found = walkForAlias(root, aliases);
    if (found) return found;
  }
  if (agent === "codex") return findCodexMcpPluginPath(plugin, aliases);
  return "";
}

function codexConfigPaths(): string[] {
  if (process.env.YULU_CODEX_CONFIG_PATH) return [expandHome(process.env.YULU_CODEX_CONFIG_PATH)];
  if (process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY === "1") return [];
  return [expandHome("~/.codex/config.toml")];
}

function normalizeTomlKey(raw: string): string {
  return raw.trim().replace(/^["']|["']$/g, "").toLowerCase();
}

function aliasInText(text: string, aliases: string[]): boolean {
  const lower = text.toLowerCase();
  return aliases.some((alias) => lower.includes(alias));
}

function findCodexMcpPluginPath(plugin: AgentPluginId, aliases: string[]): string {
  if (aliases.length === 0) return "";
  for (const configPath of codexConfigPaths()) {
    if (!existsSync(configPath)) continue;
    let content = "";
    try {
      content = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    const headers = Array.from(content.matchAll(/^\s*\[mcp_servers\.([^\]]+)\]\s*$/gm));
    for (let i = 0; i < headers.length; i += 1) {
      const header = headers[i]!;
      const name = normalizeTomlKey(header[1] ?? "");
      const next = headers[i + 1];
      const body = content.slice(header.index ?? 0, next?.index ?? content.length);
      if (aliases.some((alias) => name.includes(alias)) || aliasInText(body, aliases)) {
        return `${configPath}#mcp_servers.${name || plugin}`;
      }
    }
  }
  return "";
}

function walkForAlias(root: string, aliases: string[]): string {
  if (!existsSync(root)) return "";
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  while (queue.length > 0 && visited < 4000) {
    const item = queue.shift()!;
    visited += 1;
    const name = item.path.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (aliases.some((alias) => name.includes(alias))) return item.path;
    if (item.depth >= 4) continue;
    let children: string[];
    try {
      children = readdirSync(item.path, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(item.path, entry.name));
    } catch {
      continue;
    }
    for (const child of children) queue.push({ path: child, depth: item.depth + 1 });
  }
  return "";
}

export function agentPluginOverview(
  config: unknown,
  input: { agent: unknown; agentReady: boolean },
): AgentPluginOverview {
  const agent = normalizeAgent(input.agent);
  const added = new Set(addedPluginIds(config));
  const unsupported = !agent;
  const all = PLUGIN_IDS.map((id): AgentPluginState => {
    const meta = PLUGIN_META[id];
    const core = meta.core === true;
    const resolvedPath = !unsupported && !core && agent ? findPluginPath(agent, id) : "";
    const configured = core ? input.agentReady && !unsupported : input.agentReady && resolvedPath.length > 0;
    const status: AgentPluginStatus = unsupported ? "unsupported" : configured ? "configured" : "unconfigured";
    return {
      id,
      label: meta.label,
      added: added.has(id),
      core,
      status,
      statusLabel: status === "configured" ? "已配置" : status === "unsupported" ? "不可用" : "未配置",
      resolvedPath,
      detail: detailForPlugin(status, agent, id, resolvedPath),
      configureLabel: status === "configured" ? "已配置" : "去配置",
      agent,
      ...(id === "notion" || id === "zulip" ? { destination: agentDestinationView(config, agent, id) } : {}),
    };
  });
  return {
    agent,
    all,
    current: all.filter((plugin) => plugin.added),
    available: all.filter((plugin) => !plugin.added),
  };
}

function detailForPlugin(status: AgentPluginStatus, agent: ConsoleAgentId | null, plugin: AgentPluginId, resolvedPath: string): string {
  if (status === "unsupported") return "当前底层 Agent 暂不支持插件探测";
  if (status === "configured" && plugin === "summary") return "摘要由当前 Agent 执行";
  if (status === "configured") return resolvedPath;
  if (!agent) return "未选择底层 Agent";
  return `${AGENT_LABEL[agent]} 尚未配置 ${PLUGIN_META[plugin].label} 插件`;
}

export function configurePluginAction(agent: unknown, plugin: AgentPluginId): ConfigurePluginAction {
  const id = normalizeAgent(agent);
  const label = PLUGIN_META[plugin].label;
  if (!id) {
    return {
      ok: false,
      agent: id,
      plugin,
      label,
      agentCli: "",
      message: `当前底层 Agent 暂不支持配置 ${label} 插件。`,
    };
  }
  const agentCli =
    id === "codex" ? "codex" :
    id === "claude" ? "claude" :
    id === "hermes" ? "hermes" :
    "openclaw";
  return {
    ok: true,
    agent: id,
    plugin,
    label,
    agentCli,
    message: `请在 ${AGENT_LABEL[id]} 中添加或授权 ${label} 插件；Yulu 只会重新探测状态，不保存该插件凭证。`,
  };
}
