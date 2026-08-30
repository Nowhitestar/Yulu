import { router, publicProcedure, type AppContext } from "../trpc.js";
import { ipcSend } from "../ipc.js";
import { z } from "zod";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

interface StatusReply {
  ok: boolean;
  state?: string;
  hotkey?: string;
  launcher_pid?: number;
  dictation_active?: boolean;
  dictation_intent?: string;
  voice_chat_window_visible?: boolean;
  voice_chat_window_url?: string;
}
interface ToggleReply { ok: boolean; state_before?: string; state_after?: string; }

interface HistoryRow {
  id?: unknown;
  created_at?: unknown;
  action?: unknown;
  text?: unknown;
  audio_path?: unknown;
  engine?: unknown;
  language?: unknown;
  prompt_slug?: unknown;
  target_language?: unknown;
}

interface HistoryItem {
  id: string;
  createdAt: string;
  action: "dictate" | "translate";
  text: string;
  audioPath: string;
  engine: string;
  language: string;
  promptSlug: string;
  targetLanguage: string;
}

function publishState(ctx: Pick<AppContext, "pubsub">, stateAfter: string) {
  if (stateAfter === "idle" || stateAfter === "recording" || stateAfter === "processing" || stateAfter === "meetingBusy" || stateAfter === "daemonDown") {
    ctx.pubsub.publish("recording", { state: stateAfter });
  }
}

async function readHistory(configDir: string, legacyReadOnlyDataDir: string, logsDir: string) {
  const rows = [
    ...await readHistoryJsonl(configDir),
    ...await readHistoryJsonl(legacyReadOnlyDataDir),
    ...await readHistoryLog(logsDir),
    ...await readHistoryLog(legacyReadOnlyDataDir),
  ];
  const byId = new Map<string, HistoryItem>();
  for (const row of rows) byId.set(row.id, row);
  return Array.from(byId.values())
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .slice(-100)
    .reverse();
}

async function readHistoryJsonl(configDir: string): Promise<HistoryItem[]> {
  let raw = "";
  try {
    raw = await readFile(join(configDir, "dictation", "history.jsonl"), "utf8");
  } catch {
    return [];
  }
  const rows: HistoryItem[] = [];
  for (const line of raw.split(/\n+/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: HistoryRow;
    try {
      parsed = JSON.parse(trimmed) as HistoryRow;
    } catch {
      continue;
    }
    const text = String(parsed.text ?? "").trim();
    if (!text) continue;
    const item = toHistoryItem(parsed, rows.length);
    if (item) rows.push(item);
  }
  return rows;
}

async function readHistoryLog(configDir: string): Promise<HistoryItem[]> {
  let raw = "";
  try {
    raw = await readFile(join(configDir, "status_agent_launcher.log"), "utf8");
  } catch {
    return [];
  }
  const rows: HistoryItem[] = [];
  for (const obj of parseJsonObjects(raw)) {
    const parsed = obj as HistoryRow;
    if (parsed.action !== "stop") continue;
    const item = toHistoryItem(parsed, rows.length);
    if (item) rows.push(item);
  }
  return rows;
}

function toHistoryItem(parsed: HistoryRow, index: number): HistoryItem | null {
  const text = String(parsed.text ?? "").trim();
  if (!text) return null;
  const audioPath = String(parsed.audio_path ?? "");
  const createdAt = String(parsed.created_at ?? "") || createdAtFromAudioPath(audioPath);
  const targetLanguage = String(parsed.target_language ?? "").trim();
  return {
    id: String((parsed.id ?? audioPath) || `${createdAt}-${index}`),
    createdAt,
    action: parsed.action === "translate" || targetLanguage ? "translate" : "dictate",
    text,
    audioPath,
    engine: String(parsed.engine ?? ""),
    language: String(parsed.language ?? ""),
    promptSlug: String(parsed.prompt_slug ?? ""),
    targetLanguage,
  };
}

function createdAtFromAudioPath(path: string): string {
  const match = path.match(/Dictation_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!match) return "";
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
}

function parseJsonObjects(raw: string): unknown[] {
  const out: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch !== "}" || depth === 0) continue;
    depth -= 1;
    if (depth === 0 && start >= 0) {
      try {
        out.push(JSON.parse(raw.slice(start, i + 1)));
      } catch {
        // Ignore partial or non-JSON log fragments.
      }
      start = -1;
    }
  }
  return out;
}

export const recordingRouter = router({
  history: publicProcedure.query(({ ctx }) => readHistory(
    ctx.paths.durableDataDir,
    ctx.paths.legacyReadOnlyDataDir,
    ctx.paths.logsDir,
  )),

  state: publicProcedure.query(async ({ ctx }) => {
    try {
      const r = await ipcSend<StatusReply>(ctx.paths.statusAgentSock, { action: "status" });
      return {
        state: r.state ?? "unknown",
        hotkey: r.hotkey ?? "?",
        launcherPid: r.launcher_pid,
        dictationActive: Boolean(r.dictation_active),
        dictationIntent: r.dictation_intent,
        voiceChatWindowVisible: Boolean(r.voice_chat_window_visible),
        voiceChatWindowUrl: r.voice_chat_window_url,
      };
    } catch {
      return {
        state: "unknown",
        hotkey: "?",
        launcherPid: undefined,
        dictationActive: false,
        dictationIntent: undefined,
        voiceChatWindowVisible: false,
        voiceChatWindowUrl: undefined,
      };
    }
  }),

  toggle: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, { action: "toggle" });
    const stateAfter = r.state_after ?? "?";
    publishState(ctx, stateAfter);
    return { stateBefore: r.state_before ?? "?", stateAfter };
  }),

  dictate: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, { action: "dictate_toggle" });
    const stateAfter = r.state_after ?? "?";
    publishState(ctx, stateAfter);
    return { stateBefore: r.state_before ?? "?", stateAfter };
  }),

  translate: publicProcedure
    .input(z.object({ targetLanguage: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, {
        action: "dictate_translate",
        target_language: input?.targetLanguage ?? "",
      });
      const stateAfter = r.state_after ?? "?";
      publishState(ctx, stateAfter);
      return { stateBefore: r.state_before ?? "?", stateAfter };
    }),

  voiceChat: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<ToggleReply>(ctx.paths.statusAgentSock, { action: "voice_chat" });
    const stateAfter = r.state_after ?? "?";
    publishState(ctx, stateAfter);
    return { stateBefore: r.state_before ?? "?", stateAfter };
  }),

  previewSound: publicProcedure.mutation(async ({ ctx }) => {
    const r = await ipcSend<{ ok: boolean; enabled?: boolean }>(ctx.paths.statusAgentSock, { action: "preview_sound" });
    return { ok: r.ok, enabled: r.enabled ?? true };
  }),

  openInbox: publicProcedure.mutation(async ({ ctx }) => {
    await ipcSend(ctx.paths.statusAgentSock, { action: "open_inbox" });
    return { ok: true };
  }),
});
