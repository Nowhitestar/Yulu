import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const STORE_VERSION = 3;
const STORE_FILE = "agent-sessions.json";
const MAX_TITLE_CHARS = 48;
const MAX_MESSAGE_CHARS = 80_000;
const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_CHARS = 12_000;

export const agentSessionSourceSchema = z.object({
  ref: z.number().optional(),
  kind: z.string().optional(),
  stem: z.string().optional(),
  title: z.string().optional(),
  recordedAt: z.string().optional(),
  sourcePath: z.string().optional(),
  snippet: z.string().optional(),
  url: z.string().optional(),
});

export const agentSessionRemoteSourceSchema = z.object({
  channel: z.string().optional(),
  label: z.string().optional(),
  detail: z.string().optional(),
  connected: z.boolean().optional(),
});

const agentSessionRetrySourceSchema = z.object({
  ref: z.number(),
  kind: z.enum(["meeting_summary", "meeting_transcript"]),
  stem: z.string(),
  title: z.string(),
  recordedAt: z.string(),
  sourcePath: z.string(),
  snippet: z.string(),
  url: z.string(),
});

const agentSessionRetrySnapshotSchema = z.object({
  question: z.string().trim().min(1).max(2_000),
  sources: z.array(agentSessionRetrySourceSchema).max(8),
  retrievalPending: z.boolean().optional(),
});

export const agentSessionMessageInputSchema = z.object({
  role: z.enum(["user", "assistant"]),
  text: z.string().max(MAX_MESSAGE_CHARS),
  sources: z.array(agentSessionSourceSchema).optional(),
  remoteSources: z.array(agentSessionRemoteSourceSchema).optional(),
  error: z.string().optional(),
});

const persistedMessageSchema = agentSessionMessageInputSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});

const persistedSessionSchema = z.object({
  id: z.string(),
  agent: z.string(),
  provider: z.string().trim().min(1).max(128).optional(),
  model: z.string().trim().min(1).max(128).optional(),
  credentialSource: z.enum(["oauth", "api-key"]).optional(),
  status: z.enum(["active", "paused"]).optional(),
  pausedReason: z.string().max(1000).optional(),
  retrySnapshot: agentSessionRetrySnapshotSchema.optional(),
  purpose: z.enum(["ask", "background"]).default("ask"),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pinnedAt: z.string().optional(),
  archivedAt: z.string().optional(),
  nativeSessionId: z.string().optional(),
  runtimeLabel: z.string().optional(),
  messages: z.array(persistedMessageSchema),
}).transform((session) => ({
  ...session,
  provider: session.provider ?? session.agent,
  model: session.model ?? "runtime-managed",
  status: session.status ?? "active",
}));

const storeSchema = z.object({
  version: z.number(),
  sessions: z.array(persistedSessionSchema),
});

export type AgentSessionStore = z.infer<typeof storeSchema>;
export type AgentSession = z.infer<typeof persistedSessionSchema>;
export type AgentSessionMessage = z.infer<typeof persistedMessageSchema>;
export type AgentSessionMessageInput = z.infer<typeof agentSessionMessageInputSchema>;
export type AgentSessionRetrySnapshot = z.infer<typeof agentSessionRetrySnapshotSchema>;

export interface AgentSessionHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export function storePath(configDir: string): string {
  return join(configDir, STORE_FILE);
}

export function readAgentSessionStore(configDir: string): AgentSessionStore {
  const path = storePath(configDir);
  if (!existsSync(path)) return { version: STORE_VERSION, sessions: [] };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const parsed = storeSchema.safeParse(raw);
    if (!parsed.success) return { version: STORE_VERSION, sessions: [] };
    const store = {
      version: STORE_VERSION,
      sessions: parsed.data.sessions,
    };
    const rawSessions = Array.isArray(raw.sessions) ? raw.sessions : [];
    const needsMigration = raw.version !== STORE_VERSION || rawSessions.some((session: unknown) => {
      if (!session || typeof session !== "object" || Array.isArray(session)) return false;
      const value = session as Record<string, unknown>;
      return !("provider" in value) || !("model" in value) || !("status" in value);
    });
    if (needsMigration) writeAgentSessionStore(configDir, store);
    return store;
  } catch {
    return { version: STORE_VERSION, sessions: [] };
  }
}

export function writeAgentSessionStore(configDir: string, store: AgentSessionStore): void {
  mkdirSync(configDir, { recursive: true });
  const path = storePath(configDir);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ version: STORE_VERSION, sessions: store.sessions }, null, 2)}\n`);
  renameSync(tmp, path);
}

function nowIso(): string {
  return new Date().toISOString();
}

function titleFromText(value: string): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return "新对话";
  return compact.length > MAX_TITLE_CHARS ? `${compact.slice(0, MAX_TITLE_CHARS - 1)}…` : compact;
}

export function summarizeAgentSession(session: AgentSession) {
  const lastMessage = session.messages[session.messages.length - 1];
  return {
    id: session.id,
    agent: session.agent,
    provider: session.provider,
    model: session.model,
    status: session.status,
    pausedReason: session.pausedReason,
    purpose: session.purpose,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    pinnedAt: session.pinnedAt,
    archivedAt: session.archivedAt,
    messageCount: session.messages.length,
    lastMessage: lastMessage ? {
      role: lastMessage.role,
      text: lastMessage.text,
      createdAt: lastMessage.createdAt,
    } : null,
  };
}

function makeMessage(input: AgentSessionMessageInput): AgentSessionMessage {
  return {
    id: randomUUID(),
    role: input.role,
    text: input.text,
    createdAt: nowIso(),
    ...(input.sources ? { sources: input.sources } : {}),
    ...(input.remoteSources ? { remoteSources: input.remoteSources } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export function createAgentSession(
  configDir: string,
  input: {
    title?: string;
    runtimeLabel?: string;
  } & (
    { purpose?: "ask"; provider: string; model: string; credentialSource?: "oauth" | "api-key" }
    | { purpose: "background"; agent: string }
  ),
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const timestamp = nowIso();
  const purpose = input.purpose ?? "ask";
  const identity = input.purpose === "background"
    ? { provider: input.agent, model: "runtime-managed" }
    : z.object({
        provider: z.string().trim().min(1).max(128),
        model: z.string().trim().min(1).max(128),
      }).parse(input);
  const session: AgentSession = {
    id: randomUUID(),
    agent: identity.provider,
    provider: identity.provider,
    model: identity.model,
    ...(input.purpose !== "background" && input.credentialSource
      ? { credentialSource: input.credentialSource }
      : {}),
    status: "active",
    purpose,
    title: titleFromText(input.title ?? ""),
    createdAt: timestamp,
    updatedAt: timestamp,
    runtimeLabel: input.runtimeLabel,
    messages: [],
  };
  store.sessions.unshift(session);
  writeAgentSessionStore(configDir, store);
  return session;
}

export function ensureBackgroundAgentSession(
  configDir: string,
  input: { agent: string; runtimeLabel?: string },
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const existing = store.sessions.find((session) =>
    session.agent === input.agent && session.purpose === "background"
  );
  if (existing) {
    if (input.runtimeLabel && existing.runtimeLabel !== input.runtimeLabel) {
      existing.runtimeLabel = input.runtimeLabel;
      existing.updatedAt = nowIso();
      writeAgentSessionStore(configDir, store);
    }
    return existing;
  }
  return createAgentSession(configDir, {
    agent: input.agent,
    purpose: "background",
    title: "Yulu Agent Console",
    runtimeLabel: input.runtimeLabel,
  });
}

export function listAgentSessions(
  configDir: string,
  input: { agent?: string; purpose?: "ask" | "background"; includeArchived?: boolean } = {},
): AgentSession[] {
  const store = readAgentSessionStore(configDir);
  return store.sessions
    .filter((session) => !input.agent || session.agent === input.agent)
    .filter((session) => !input.purpose || session.purpose === input.purpose)
    .filter((session) => input.includeArchived || !session.archivedAt)
    .slice()
    .sort((a, b) =>
      Number(Boolean(b.pinnedAt)) - Number(Boolean(a.pinnedAt)) ||
      (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "") ||
      b.updatedAt.localeCompare(a.updatedAt)
    );
}

export function getAgentSession(configDir: string, id: string): AgentSession | null {
  return readAgentSessionStore(configDir).sessions.find((session) => session.id === id) ?? null;
}

export function projectAgentSessionHistory(
  session: AgentSession,
  currentQuestion?: string,
): AgentSessionHistoryMessage[] {
  const messages = session.messages.slice();
  if (currentQuestion) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]!;
      if (message.role === "user" && message.text.trim() === currentQuestion.trim()) {
        messages.splice(index, 1);
        break;
      }
    }
  }
  const history: AgentSessionHistoryMessage[] = [];
  let remainingChars = MAX_HISTORY_CHARS;
  for (let index = messages.length - 1; index >= 0 && history.length < MAX_HISTORY_MESSAGES && remainingChars > 0; index -= 1) {
    const message = messages[index]!;
    let content = message.text.trim().slice(0, remainingChars);
    if (/[\uD800-\uDBFF]$/.test(content)) content = content.slice(0, -1);
    if (!content) continue;
    remainingChars -= content.length;
    history.unshift({ role: message.role, content });
  }
  return history;
}

export function appendAgentSessionMessage(
  configDir: string,
  sessionId: string,
  input: AgentSessionMessageInput,
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("Agent session not found");
  }
  const message = makeMessage(input);
  session.messages.push(message);
  session.updatedAt = message.createdAt;
  if (session.title === "新对话" && message.role === "user") {
    session.title = titleFromText(message.text);
  }
  writeAgentSessionStore(configDir, store);
  return session;
}

export function updateAgentSessionNativeSession(
  configDir: string,
  sessionId: string,
  input: { nativeSessionId?: string; runtimeLabel?: string },
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("Agent session not found");
  }
  if (input.nativeSessionId) session.nativeSessionId = input.nativeSessionId;
  if (input.runtimeLabel) session.runtimeLabel = input.runtimeLabel;
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

function findMutableSession(store: AgentSessionStore, sessionId: string): AgentSession {
  const session = store.sessions.find((item) => item.id === sessionId);
  if (!session) throw new Error("Agent session not found");
  return session;
}

export function pauseAgentSession(
  configDir: string,
  sessionId: string,
  reason: string,
  retrySnapshot?: AgentSessionRetrySnapshot,
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  session.status = "paused";
  session.pausedReason = reason.slice(0, 1000);
  if (retrySnapshot) session.retrySnapshot = agentSessionRetrySnapshotSchema.parse(retrySnapshot);
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

export function resumeAgentSession(configDir: string, sessionId: string): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  session.status = "active";
  delete session.pausedReason;
  delete session.retrySnapshot;
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

export function renameAgentSession(configDir: string, sessionId: string, title: string): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  session.title = titleFromText(title);
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

export function deleteAgentSession(configDir: string, sessionId: string): { deleted: boolean } {
  const store = readAgentSessionStore(configDir);
  const next = store.sessions.filter((session) => session.id !== sessionId);
  if (next.length === store.sessions.length) throw new Error("Agent session not found");
  writeAgentSessionStore(configDir, { ...store, sessions: next });
  return { deleted: true };
}

export function pinAgentSession(configDir: string, sessionId: string, pinned: boolean): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (pinned) session.pinnedAt = nowIso();
  else delete session.pinnedAt;
  writeAgentSessionStore(configDir, store);
  return session;
}

export function archiveAgentSession(configDir: string, sessionId: string, archived: boolean): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (archived) session.archivedAt = nowIso();
  else delete session.archivedAt;
  writeAgentSessionStore(configDir, store);
  return session;
}
