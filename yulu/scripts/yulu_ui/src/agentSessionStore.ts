import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

const STORE_VERSION = 8;
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

const agentSessionProviderMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(120_000),
}).strict();

const agentSessionProviderInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("messages"),
    messages: z.array(agentSessionProviderMessageSchema).min(1).max(20),
  }).strict(),
  z.object({
    kind: z.literal("prompt"),
    prompt: z.string().min(1).max(120_000),
  }).strict(),
]);

const agentSessionInvocationSchema = z.object({
  executionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/),
  provider: z.string().trim().min(1).max(128),
  connectionId: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(128),
  runtimeProvider: z.string().trim().min(1).max(128).optional(),
  endpointIdentity: z.string().trim().min(1).max(2_048).optional(),
  disclosureVersion: z.string().trim().min(1).max(200).optional(),
  credentialIdentity: z.string().trim().min(1).max(200).optional(),
  credentialSource: z.enum(["oauth", "api-key", "runtime-oauth"]).optional(),
  nativeSessionId: z.string().trim().min(1).max(200).optional(),
  inputSha256: z.string().regex(/^[a-f0-9]{64}$/),
  snapshot: agentSessionRetrySnapshotSchema,
  providerInput: agentSessionProviderInputSchema,
  startedAt: z.string(),
  recoveredAt: z.string().optional(),
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
  runtimeProvider: z.string().trim().min(1).max(128).optional(),
  connectionId: z.string().trim().min(1).max(200).optional(),
  endpointIdentity: z.string().trim().min(1).max(2_048).optional(),
  disclosureVersion: z.string().trim().min(1).max(200).optional(),
  credentialIdentity: z.string().trim().min(1).max(200).optional(),
  credentialSource: z.enum(["oauth", "api-key", "runtime-oauth"]).optional(),
  status: z.enum(["active", "paused"]).optional(),
  pausedReason: z.string().max(1000).optional(),
  retrySnapshot: agentSessionRetrySnapshotSchema.optional(),
  retryProviderInput: agentSessionProviderInputSchema.optional(),
  pendingInvocation: agentSessionInvocationSchema.optional(),
  unknownOutcome: agentSessionInvocationSchema.optional(),
  supersedesSessionId: z.string().trim().min(1).max(200).optional(),
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
export type AgentSessionProviderInput = z.infer<typeof agentSessionProviderInputSchema>;
export type AgentSessionInvocation = z.infer<typeof agentSessionInvocationSchema>;

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
    connectionId: session.connectionId,
    endpointIdentity: session.endpointIdentity,
    disclosureVersion: session.disclosureVersion,
    model: session.model,
    runtimeProvider: session.runtimeProvider,
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
    {
      purpose?: "ask";
      provider: string;
      model: string;
      runtimeProvider?: string;
      connectionId?: string;
      endpointIdentity?: string;
      disclosureVersion?: string;
      credentialIdentity?: string;
      credentialSource?: "oauth" | "api-key" | "runtime-oauth";
    }
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
    ...(input.purpose !== "background" && input.runtimeProvider
      ? { runtimeProvider: input.runtimeProvider }
      : {}),
    ...(input.purpose !== "background" && input.connectionId
      ? { connectionId: input.connectionId }
      : {}),
    ...(input.purpose !== "background" && input.endpointIdentity
      ? { endpointIdentity: input.endpointIdentity }
      : {}),
    ...(input.purpose !== "background" && input.disclosureVersion
      ? { disclosureVersion: input.disclosureVersion }
      : {}),
    ...(input.purpose !== "background" && input.credentialIdentity
      ? { credentialIdentity: input.credentialIdentity }
      : {}),
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
  retryProviderInput?: AgentSessionProviderInput,
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  session.status = "paused";
  session.pausedReason = reason.slice(0, 1000);
  if (retrySnapshot) session.retrySnapshot = agentSessionRetrySnapshotSchema.parse(retrySnapshot);
  else delete session.retrySnapshot;
  if (retryProviderInput) session.retryProviderInput = agentSessionProviderInputSchema.parse(retryProviderInput);
  else if (!retrySnapshot) delete session.retryProviderInput;
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

export function resumeAgentSession(configDir: string, sessionId: string): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (session.unknownOutcome) {
    throw new Error("Unknown Outcome requires an explicit new Conversation attempt");
  }
  session.status = "active";
  delete session.pausedReason;
  delete session.retrySnapshot;
  delete session.retryProviderInput;
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

function invocationInputSha256(
  snapshot: AgentSessionRetrySnapshot,
  providerInput: AgentSessionProviderInput,
): string {
  return createHash("sha256").update(JSON.stringify({ snapshot, providerInput })).digest("hex");
}

function invocationInputValid(invocation: AgentSessionInvocation): boolean {
  return invocation.inputSha256 === invocationInputSha256(invocation.snapshot, invocation.providerInput);
}

export function beginAgentSessionInvocation(
  configDir: string,
  sessionId: string,
  snapshotInput: AgentSessionRetrySnapshot,
  providerInputValue: AgentSessionProviderInput,
): AgentSessionInvocation {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (session.pendingInvocation || session.unknownOutcome) {
    throw new Error("Conversation already has unresolved remote execution");
  }
  const snapshot = agentSessionRetrySnapshotSchema.parse(snapshotInput);
  const providerInput = agentSessionProviderInputSchema.parse(providerInputValue);
  const invocation = agentSessionInvocationSchema.parse({
    executionId: `conversation-${randomUUID()}`,
    provider: session.provider,
    connectionId: session.connectionId,
    model: session.model,
    runtimeProvider: session.runtimeProvider,
    endpointIdentity: session.endpointIdentity,
    disclosureVersion: session.disclosureVersion,
    credentialIdentity: session.credentialIdentity,
    credentialSource: session.credentialSource,
    nativeSessionId: session.nativeSessionId,
    inputSha256: invocationInputSha256(snapshot, providerInput),
    snapshot,
    providerInput,
    startedAt: nowIso(),
  });
  session.pendingInvocation = invocation;
  session.updatedAt = invocation.startedAt;
  writeAgentSessionStore(configDir, store);
  return invocation;
}

export function completeAgentSessionInvocation(
  configDir: string,
  sessionId: string,
  executionId: string,
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (session.pendingInvocation?.executionId !== executionId) {
    throw new Error("Conversation execution journal changed before completion");
  }
  delete session.pendingInvocation;
  session.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return session;
}

export function markAgentSessionInvocationUnknown(
  configDir: string,
  sessionId: string,
  executionId: string,
  reason: string,
): AgentSession {
  const store = readAgentSessionStore(configDir);
  const session = findMutableSession(store, sessionId);
  if (session.pendingInvocation?.executionId !== executionId) {
    throw new Error("Conversation Unknown Outcome does not match its execution journal");
  }
  session.unknownOutcome = { ...session.pendingInvocation, recoveredAt: nowIso() };
  delete session.pendingInvocation;
  delete session.retrySnapshot;
  delete session.retryProviderInput;
  session.status = "paused";
  session.pausedReason = reason.slice(0, 1000);
  session.updatedAt = session.unknownOutcome.recoveredAt!;
  writeAgentSessionStore(configDir, store);
  return session;
}

export function recoverInterruptedAgentSessionInvocations(configDir: string): string[] {
  const store = readAgentSessionStore(configDir);
  const recovered: string[] = [];
  const recoveredAt = nowIso();
  for (const session of store.sessions) {
    if (!session.pendingInvocation) continue;
    session.unknownOutcome = { ...session.pendingInvocation, recoveredAt };
    delete session.pendingInvocation;
    delete session.retrySnapshot;
    delete session.retryProviderInput;
    session.status = "paused";
    session.pausedReason = `${session.provider} Conversation was interrupted after dispatch; outcome is unknown`;
    session.updatedAt = recoveredAt;
    recovered.push(session.id);
  }
  if (recovered.length > 0) writeAgentSessionStore(configDir, store);
  return recovered;
}

export function createAgentSessionAttemptFromUnknown(configDir: string, sessionId: string): AgentSession {
  const original = getAgentSession(configDir, sessionId);
  if (!original?.unknownOutcome) {
    throw new Error("Conversation does not have an Unknown Outcome to replace");
  }
  if (!invocationInputValid(original.unknownOutcome)) {
    throw new Error("Conversation Unknown Outcome input snapshot failed integrity validation");
  }
  const replacement = createAgentSession(configDir, {
    purpose: "ask",
    provider: original.provider,
    model: original.model,
    runtimeProvider: original.runtimeProvider,
    connectionId: original.connectionId,
    endpointIdentity: original.endpointIdentity,
    disclosureVersion: original.disclosureVersion,
    credentialIdentity: original.credentialIdentity,
    credentialSource: original.credentialSource,
    title: original.title,
    runtimeLabel: original.runtimeLabel,
  });
  const store = readAgentSessionStore(configDir);
  const created = findMutableSession(store, replacement.id);
  created.supersedesSessionId = original.id;
  created.status = "paused";
  created.pausedReason = "Explicit replacement attempt is ready to send the preserved input";
  created.retrySnapshot = original.unknownOutcome.snapshot;
  created.retryProviderInput = original.unknownOutcome.providerInput;
  created.updatedAt = nowIso();
  writeAgentSessionStore(configDir, store);
  return created;
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
