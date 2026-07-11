import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { STANDARD_SUMMARY_INSTRUCTIONS } from "../promptInstructions.js";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import {
  publicAgentTask,
  RecordingTaskDeletionBlockedError,
  type HostStore,
} from "../hostStore.js";
import {
  readTitleSidecar,
  writeTitleSidecar,
  readTagsSidecar,
  writeTagsSidecar,
} from "../recordingMeta.js";

// Every recording is a meeting now (voicemails were unified into meetings and
// the separate voicemails/ directory was merged into the root). A recording is
// any `<title>_YYYYMMDD_HHMMSS.wav` in the recordings root.
const REC_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;
interface SummaryTemplateOption {
  id: string;
  slug: string;
  name: string;
  isAutoRun: boolean;
}

interface SummaryPromptSnapshot {
  id: string;
  slug: string;
  name: string;
  content: string;
}

function isoFromStem(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

/** True iff `child` resolves to a path inside `parent` (defends delete against
 *  a stem containing `..` or an absolute path). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function firstWordsOf(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    return raw.length <= 80 ? raw : raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}

function wavDurationSeconds(path: string): number | null {
  let fd: number | null = null;
  try {
    const stat = statSync(path);
    if (stat.size < 44) return null;
    fd = openSync(path, "r");
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, header.length, 0) < header.length) return null;
    if (
      header.subarray(0, 4).toString("ascii") !== "RIFF" ||
      header.subarray(8, 12).toString("ascii") !== "WAVE"
    ) {
      return null;
    }

    let offset = 12;
    let byteRate = 0;
    let dataBytes: number | null = null;
    const chunkHeader = Buffer.alloc(8);
    while (offset + 8 <= stat.size) {
      if (readSync(fd, chunkHeader, 0, chunkHeader.length, offset) < chunkHeader.length) break;
      const chunkId = chunkHeader.subarray(0, 4).toString("ascii");
      const chunkSize = chunkHeader.readUInt32LE(4);
      offset += 8;

      if (chunkId === "fmt " && chunkSize >= 12) {
        const fmt = Buffer.alloc(Math.min(chunkSize, 16));
        if (readSync(fd, fmt, 0, fmt.length, offset) >= 12) {
          byteRate = fmt.readUInt32LE(8);
          if (byteRate > 0 && dataBytes !== null) break;
        }
      } else if (chunkId === "data") {
        dataBytes = chunkSize;
        if (byteRate > 0) break;
      }

      offset += chunkSize + (chunkSize % 2);
    }

    if (!byteRate || dataBytes === null) return null;
    return dataBytes / byteRate;
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

interface RecordingStatus {
  status: string;
  statusError?: string;
}

function wavHealthError(path: string): string | null {
  try {
    const stat = statSync(path);
    if (stat.size < 12) return "Recording file is incomplete.";
    const fd = openSync(path, "r");
    try {
      const header = Buffer.alloc(12);
      const bytes = readSync(fd, header, 0, header.length, 0);
      if (bytes < 12) return "Recording file is incomplete.";
      if (
        header.subarray(0, 4).toString("ascii") !== "RIFF" ||
        header.subarray(8, 12).toString("ascii") !== "WAVE"
      ) {
        return "Recording file is not a valid WAV. The recorder likely crashed before stop completed.";
      }
      let offset = 12;
      const chunkHeader = Buffer.alloc(8);
      while (offset + chunkHeader.length <= stat.size) {
        const chunkBytes = readSync(fd, chunkHeader, 0, chunkHeader.length, offset);
        if (chunkBytes < chunkHeader.length) break;
        const chunkId = chunkHeader.subarray(0, 4).toString("ascii");
        const chunkSize = chunkHeader.readUInt32LE(4);
        if (chunkId === "data") {
          return chunkSize > 0 ? null : "Recording file contains no audio frames.";
        }
        offset += chunkHeader.length + chunkSize + (chunkSize % 2);
      }
      return "Recording file has no audio data chunk.";
    } finally {
      closeSync(fd);
    }
  } catch (exc) {
    return `Recording file cannot be inspected: ${(exc as Error).message}`;
  }
}

function recordingStatus(stem: string, wavPath: string, host?: HostStore): RecordingStatus {
  const task = host?.latestForRecording(stem);
  if (task && task.state !== "completed" && task.state !== "cancelled") {
    if (task.state === "queued") return { status: "agent_queued" };
    if (task.state === "awaiting_agent") return { status: "awaiting_agent", statusError: task.error ?? undefined };
    if (task.state === "awaiting_policy") return { status: "awaiting_policy", statusError: task.error ?? undefined };
    if (task.state === "failed") return { status: "agent_failed", statusError: task.error ?? undefined };
    if (task.state === "delivery_unverified") return { status: "delivery_unverified", statusError: task.error ?? undefined };
    if (task.state === "sending" || task.state === "delivery_reported") return { status: "sending_notion" };
    if (task.phase === "transcribing") return { status: "transcribing" };
    return { status: "summarizing" };
  }
  const wavError = wavHealthError(wavPath);
  if (wavError) return { status: "recording_failed", statusError: wavError };
  return { status: "idle" };
}

function summaryTemplateOptions(db: unknown): SummaryTemplateOption[] {
  if (!db) return [];
  try {
    const rows = (db as {
      prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] };
    }).prepare(
      "SELECT id, slug, name, is_auto_run FROM prompts WHERE category = ? ORDER BY sort_order, name"
    ).all("summary") as Array<Record<string, unknown>>;
    return rows
      .filter((row) => typeof row.id === "string" && typeof row.slug === "string" && typeof row.name === "string")
      .map((row) => ({
        id: String(row.id),
        slug: String(row.slug),
        name: String(row.name),
        isAutoRun: Number(row.is_auto_run ?? 0) === 1,
      }));
  } catch {
    return [];
  }
}

function defaultSummaryTemplateId(options: SummaryTemplateOption[]): string | null {
  return options.find((item) => item.slug === "summary")?.id ?? options[0]?.id ?? null;
}

function summaryPromptSnapshot(
  db: unknown,
  promptId: string | null | undefined,
): SummaryPromptSnapshot | null {
  if (!db) return null;
  try {
    const promptDb = db as {
      prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
    };
    const row = promptId
      ? promptDb.prepare("SELECT id, slug, name, content FROM prompts WHERE id = ? AND category = ?").get(promptId, "summary")
      : (
          promptDb.prepare("SELECT id, slug, name, content FROM prompts WHERE slug = ? AND category = ?").get("summary", "summary")
          ?? promptDb.prepare("SELECT id, slug, name, content FROM prompts WHERE category = ? ORDER BY sort_order, name LIMIT 1").get("summary")
        );
    if (!isRecord(row)) return null;
    if (
      typeof row.id !== "string" ||
      typeof row.slug !== "string" ||
      typeof row.name !== "string" ||
      typeof row.content !== "string"
    ) return null;
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      content: row.content,
    };
  } catch {
    return null;
  }
}

interface Row {
  stem: string;
  title: string | null;
  tags: string[];
  recordedAt: string | null;
  wavPath: string;
  sizeBytes: number;
  durationSeconds: number | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

interface SpeakerEntry {
  display_name?: string;
  renamed?: boolean;
  merged_into?: string | null;
  [key: string]: unknown;
}

interface SpeakerSegment {
  start?: number;
  end?: number;
  text?: string;
  speaker_id?: string;
  display_name?: string;
  source?: string;
  confident?: boolean;
  [key: string]: unknown;
}

interface SpeakerSidecar {
  schema_version?: number;
  provider?: string;
  model?: string | null;
  num_speakers_detected?: number;
  num_speakers_supplied?: number | null;
  turns?: unknown[];
  segments?: SpeakerSegment[];
  speakers?: Record<string, SpeakerEntry>;
  [key: string]: unknown;
}

const UNKNOWN_SPEAKER_ID = "unknown";
const UNKNOWN_DISPLAY_NAME = "Unknown";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function speakersSidecarPath(dir: string, stem: string): string {
  return join(dir, `${stem}.speakers.json`);
}

function normalizeSpeakerSidecar(raw: unknown): SpeakerSidecar | null {
  if (!isRecord(raw)) return null;
  const doc = raw as SpeakerSidecar;
  doc.segments = Array.isArray(doc.segments)
    ? doc.segments.filter(isRecord).map((s) => s as SpeakerSegment)
    : [];
  const speakers: Record<string, SpeakerEntry> = {};
  if (isRecord(doc.speakers)) {
    for (const [id, entry] of Object.entries(doc.speakers)) {
      speakers[id] = isRecord(entry)
        ? { ...(entry as SpeakerEntry) }
        : { display_name: id, renamed: false, merged_into: null };
    }
  }
  doc.speakers = speakers;
  updateSegmentDisplayNames(doc);
  return doc;
}

function readSpeakerSidecar(dir: string, stem: string): SpeakerSidecar | null {
  try {
    const raw = JSON.parse(readFileSync(speakersSidecarPath(dir, stem), "utf8")) as unknown;
    return normalizeSpeakerSidecar(raw);
  } catch {
    return null;
  }
}

function requireRecording(dir: string, stem: string): void {
  if (!existsSync(join(dir, `${stem}.wav`))) {
    throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${stem}` });
  }
}

function requireSpeakerSidecar(dir: string, stem: string): SpeakerSidecar {
  requireRecording(dir, stem);
  const doc = readSpeakerSidecar(dir, stem);
  if (!doc) {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "speaker data missing" });
  }
  return doc;
}

function defaultSpeakerName(id: string): string {
  if (id === UNKNOWN_SPEAKER_ID) return UNKNOWN_DISPLAY_NAME;
  const m = id.match(/^spk-(\d+)$/);
  if (m?.[1]) return `Speaker ${Number(m[1]) + 1}`;
  return id;
}

function speakerIdsIn(doc: SpeakerSidecar): string[] {
  const ids = new Set<string>(Object.keys(doc.speakers ?? {}));
  for (const seg of doc.segments ?? []) {
    if (typeof seg.speaker_id === "string" && seg.speaker_id) ids.add(seg.speaker_id);
  }
  return [...ids];
}

function speakerExists(doc: SpeakerSidecar, speakerId: string): boolean {
  return speakerIdsIn(doc).includes(speakerId);
}

function resolveSpeakerId(doc: SpeakerSidecar, speakerId: string): string {
  const speakers = doc.speakers ?? {};
  let cur = speakerId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const next = speakers[cur]?.merged_into;
    if (typeof next !== "string" || !next) break;
    cur = next;
  }
  return cur;
}

function ensureSpeaker(doc: SpeakerSidecar, speakerId: string): SpeakerEntry {
  doc.speakers ??= {};
  doc.speakers[speakerId] ??= {
    display_name: defaultSpeakerName(speakerId),
    renamed: false,
    merged_into: null,
  };
  return doc.speakers[speakerId]!;
}

function speakerDisplayName(doc: SpeakerSidecar, speakerId: string): string {
  const resolved = resolveSpeakerId(doc, speakerId);
  const entry = doc.speakers?.[resolved];
  return typeof entry?.display_name === "string" && entry.display_name.trim()
    ? entry.display_name
    : defaultSpeakerName(resolved);
}

function updateSegmentDisplayNames(doc: SpeakerSidecar): void {
  for (const seg of doc.segments ?? []) {
    const sid = typeof seg.speaker_id === "string" && seg.speaker_id ? seg.speaker_id : UNKNOWN_SPEAKER_ID;
    seg.speaker_id = resolveSpeakerId(doc, sid);
    seg.display_name = speakerDisplayName(doc, seg.speaker_id);
  }
}

function formatTimestamp(seconds: unknown): string {
  const total = Math.max(0, Math.floor(typeof seconds === "number" && Number.isFinite(seconds) ? seconds : 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function transcriptRowsFromSidecar(doc: SpeakerSidecar): Array<{ timestamp: string; name: string; text: string }> {
  return [...(doc.segments ?? [])]
    .filter((seg) => typeof seg.text === "string" && seg.text.trim())
    .sort((a, b) => (Number(a.start ?? 0) - Number(b.start ?? 0)))
    .map((seg) => {
    const name = speakerDisplayName(doc, seg.speaker_id ?? UNKNOWN_SPEAKER_ID);
    return {
      timestamp: formatTimestamp(seg.start),
      name,
      text: String(seg.text ?? "").trim(),
    };
  });
}

function renderTranscriptFromRows(rows: Array<{ timestamp: string; name: string; text: string }>): string {
  return rows.map((row) => `[${row.timestamp} ${row.name}] ${row.text}`).join("\n");
}

function renderTranscriptFromSidecar(doc: SpeakerSidecar): string {
  return renderTranscriptFromRows(transcriptRowsFromSidecar(doc));
}

const TAGGED_TRANSCRIPT_LINE_RE = /^\[(\d{2}:\d{2}(?::\d{2})?)\s+(.+?)\]\s*(.*)$/;

function renderTranscriptPreservingBodies(doc: SpeakerSidecar, existingText: string | null): string {
  const nextRows = transcriptRowsFromSidecar(doc);
  if (!existingText) return renderTranscriptFromRows(nextRows);

  const existingLines = existingText.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const parsed = existingLines.map((line) => line.match(TAGGED_TRANSCRIPT_LINE_RE));
  const canRetag = parsed.length === nextRows.length && parsed.every((match, index) => {
    const timestamp = match?.[1];
    return timestamp !== undefined && timestamp === nextRows[index]?.timestamp;
  });
  if (!canRetag) {
    return existingText;
  }

  return nextRows.map((row, index) => {
    const body = parsed[index]?.[3] ?? row.text;
    return `[${row.timestamp} ${row.name}] ${body}`;
  }).join("\n");
}

function writeTextAtomic(path: string, body: string): void {
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, path);
}

function writeSpeakerSidecar(dir: string, stem: string, doc: SpeakerSidecar): SpeakerSidecar {
  updateSegmentDisplayNames(doc);
  const path = speakersSidecarPath(dir, stem);
  writeTextAtomic(path, JSON.stringify(doc, null, 2));
  const transcriptPath = join(dir, `${stem}.transcript.txt`);
  const existingTranscript = existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null;
  writeTextAtomic(transcriptPath, renderTranscriptPreservingBodies(doc, existingTranscript));
  return doc;
}

/** Title shown to the user: the `<stem>.title` override sidecar if present,
 *  else the filename-derived title. */
function resolveTitle(dir: string, stem: string, derived: string | null): string | null {
  return readTitleSidecar(join(dir, `${stem}.title`)) ?? derived;
}

function listRecordings(dir: string, host?: HostStore): Row[] {
  if (!existsSync(dir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(REC_FILE_RE);
    if (!m) continue;
    const [, title, date, time] = m;
    const stem = f.slice(0, -4);
      const wavPath = join(dir, f);
      const stat = statSync(wavPath);
      const transcriptPath = join(dir, `${stem}.transcript.txt`);
      const currentStatus = recordingStatus(stem, wavPath, host);
      out.push({
        stem,
        title: resolveTitle(dir, stem, title!),
      tags: readTagsSidecar(join(dir, `${stem}.tags.json`)),
      recordedAt: isoFromStem(date!, time!),
      wavPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
      durationSeconds: wavDurationSeconds(wavPath),
      hasTranscript: existsSync(transcriptPath),
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      hasRealtime: existsSync(join(dir, `${stem}.realtime.transcript.txt`)),
        firstWords: firstWordsOf(transcriptPath),
        status: currentStatus.status, statusError: currentStatus.statusError,
      });
  }
  return out;
}

export const recordingsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
    }))
    .query(({ ctx, input }) => {
      let rows: Row[] = listRecordings(ctx.paths.moviesDir, ctx.host);
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (input.since !== undefined) rows = rows.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) rows = rows.slice(0, input.limit);
      return rows;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${input.stem}` });
      const read = (suffix: string) => {
        const p = join(dir, `${input.stem}${suffix}`);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      const stat = statSync(wav);
      const cleanFile = `${input.stem}.clean.wav`;
      const cleanPath = join(dir, cleanFile);
      const audioFile = existsSync(cleanPath) ? cleanFile : `${input.stem}.wav`;
      const audioStat = statSync(join(dir, audioFile));
      let recordedAt: string | null = null;
      const tm = input.stem.match(/_(\d{8})_(\d{6})$/);
      if (tm) recordedAt = isoFromStem(tm[1]!, tm[2]!);
      const mm = `${input.stem}.wav`.match(REC_FILE_RE);
      const derivedTitle = mm ? mm[1]! : null;
      const title = resolveTitle(dir, input.stem, derivedTitle);
      const tags = readTagsSidecar(join(dir, `${input.stem}.tags.json`));
      const currentStatus = recordingStatus(input.stem, wav, ctx.host);
      const agentTask = ctx.host?.latestForRecording(input.stem) ?? null;
      const notionDelivery = agentTask ? ctx.host?.getNotionDelivery(agentTask.id) ?? null : null;
      const transcript = read(".transcript.txt");
      const raw = read(".raw.transcript.txt");
      // Older Yulu releases wrote identical `.transcript.txt` and
      // `.raw.transcript.txt` files; the primary transcript may later differ.
      // Only surface raw as
      // a distinct view when it actually differs — otherwise it's a confusing
      // duplicate.
      const rawDiffers = raw !== null && transcript !== null && raw.trim() !== transcript.trim();
      return {
        stem: input.stem, title, tags, recordedAt,
        wavPath: wav, audioFile, audioMtimeMs: audioStat.mtimeMs, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
        transcript,
        raw,
        rawDiffers,
        summary: read(".summary.md"),
        realtime: read(".realtime.transcript.txt"),
        hasRealtime: existsSync(join(dir, `${input.stem}.realtime.transcript.txt`)),
        speakerData: readSpeakerSidecar(dir, input.stem),
        status: currentStatus.status, statusError: currentStatus.statusError,
        agentTask: agentTask ? publicAgentTask(agentTask) : null,
        notionDelivery,
        summaryTemplateOptions: summaryTemplateOptions(ctx.db?.prompts),
        defaultSummaryTemplateId: defaultSummaryTemplateId(summaryTemplateOptions(ctx.db?.prompts)),
      };
    }),

  rename: publicProcedure
    .input(z.object({ stem: z.string(), title: z.string().max(200) }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      if (!existsSync(join(dir, `${input.stem}.wav`))) {
        throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${input.stem}` });
      }
      // Persist as a `<stem>.title` sidecar rather than renaming the WAV — the
      // filename is load-bearing (audio URLs, search index, agent-queue paths,
      // the YYYYMMDD_HHMMSS timestamp).
      writeTitleSidecar(join(dir, `${input.stem}.title`), input.title);
      ctx.pubsub.publish("recordings-changed", { reason: "changed" });
      return { title: input.title.trim() || null };
    }),

  setTags: publicProcedure
    .input(z.object({ stem: z.string(), tags: z.array(z.string()).max(50) }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      if (!existsSync(join(dir, `${input.stem}.wav`))) {
        throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${input.stem}` });
      }
      const saved = writeTagsSidecar(join(dir, `${input.stem}.tags.json`), input.tags);
      ctx.pubsub.publish("recordings-changed", { reason: "changed" });
      return { tags: saved };
    }),

  renameSpeaker: publicProcedure
    .input(z.object({
      stem: z.string(),
      speakerId: z.string().min(1),
      displayName: z.string().max(80),
    }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const doc = requireSpeakerSidecar(dir, input.stem);
      const speakerId = resolveSpeakerId(doc, input.speakerId);
      if (!speakerExists(doc, speakerId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: `speaker not found: ${input.speakerId}` });
      }
      const displayName = input.displayName.trim();
      if (!displayName) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "speaker name cannot be empty" });
      }
      const entry = ensureSpeaker(doc, speakerId);
      entry.display_name = displayName;
      entry.renamed = true;
      const speakerData = writeSpeakerSidecar(dir, input.stem, doc);
      ctx.pubsub.publish("recordings-changed", { reason: "changed" });
      return { speakerData };
    }),

  mergeSpeakers: publicProcedure
    .input(z.object({
      stem: z.string(),
      fromSpeakerId: z.string().min(1),
      toSpeakerId: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const doc = requireSpeakerSidecar(dir, input.stem);
      const fromId = resolveSpeakerId(doc, input.fromSpeakerId);
      const toId = resolveSpeakerId(doc, input.toSpeakerId);
      if (fromId === toId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "choose two different speakers" });
      }
      if (!speakerExists(doc, fromId) || !speakerExists(doc, toId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "speaker not found" });
      }
      ensureSpeaker(doc, fromId);
      ensureSpeaker(doc, toId);
      const aliases = speakerIdsIn(doc).filter((id) => resolveSpeakerId(doc, id) === fromId);
      for (const alias of aliases) {
        ensureSpeaker(doc, alias).merged_into = toId;
      }
      for (const seg of doc.segments ?? []) {
        const sid = typeof seg.speaker_id === "string" ? seg.speaker_id : UNKNOWN_SPEAKER_ID;
        if (aliases.includes(sid) || resolveSpeakerId(doc, sid) === fromId) {
          seg.speaker_id = toId;
          seg.source = "manual";
          seg.confident = true;
        }
      }
      const speakerData = writeSpeakerSidecar(dir, input.stem, doc);
      ctx.pubsub.publish("recordings-changed", { reason: "changed" });
      return { speakerData };
    }),

  assignSegmentSpeaker: publicProcedure
    .input(z.object({
      stem: z.string(),
      segmentIndex: z.number().int().nonnegative(),
      speakerId: z.string().min(1),
    }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const doc = requireSpeakerSidecar(dir, input.stem);
      const segment = doc.segments?.[input.segmentIndex];
      if (!segment) {
        throw new TRPCError({ code: "NOT_FOUND", message: `segment not found: ${input.segmentIndex}` });
      }
      const speakerId = resolveSpeakerId(doc, input.speakerId);
      if (!speakerExists(doc, speakerId)) {
        throw new TRPCError({ code: "NOT_FOUND", message: `speaker not found: ${input.speakerId}` });
      }
      segment.speaker_id = speakerId;
      segment.source = "manual";
      segment.confident = true;
      const speakerData = writeSpeakerSidecar(dir, input.stem, doc);
      ctx.pubsub.publish("recordings-changed", { reason: "changed" });
      return { speakerData };
    }),

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      let taskIds: string[];
      try {
        taskIds = ctx.host.prepareRecordingDeletion(input.stem);
      } catch (error) {
        if (error instanceof RecordingTaskDeletionBlockedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
      for (const taskId of taskIds) ctx.artifacts.cleanupWorkspace(taskId);
      // Every known sidecar a recording can spawn. `.tags.json`/`.title` are the
      // UI-editable ones; the rest are pipeline outputs.
      const suffixes = [".wav", ".clean.wav", ".transcript.txt", ".raw.transcript.txt",
                        ".realtime.transcript.txt", ".realtime.coverage.json", ".realtime.json",
                        ".speakers.json",
                        ".summary.md", ".summary.html",
                        ".mic.transcript.txt", ".sys.transcript.txt",
                        ".title", ".tags.json", ".shares.json"];
      const targets = new Set(suffixes.map((s) => join(dir, `${input.stem}${s}`)));
      // `<stem>.chunk-*` split-recording fragments (glob — no fixed count).
      // Read the dir and match by prefix instead of trusting a wildcard path.
      const chunkPrefix = `${input.stem}.chunk-`;
      try {
        for (const f of readdirSync(dir)) {
          if (f.startsWith(chunkPrefix)) targets.add(join(dir, f));
        }
      } catch { /* dir gone — nothing to remove */ }
      let removed = 0;
      for (const p of targets) {
        // Containment guard: only ever unlink inside the recordings dir, never
        // follow a stem that escapes via `..` or an absolute path.
        if (!isInside(dir, p)) continue;
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      try {
        ctx.host.purgeRecordingTasks(input.stem);
      } catch (error) {
        if (error instanceof RecordingTaskDeletionBlockedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
      ctx.pubsub.publish("recordings-changed", { reason: "removed" });
      return { removed };
    }),

  reprocess: publicProcedure
    .input(z.object({
      stem: z.string(),
      promptId: z.string().nullable().optional(),
      sendToNotion: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wavPath = join(dir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      const mm = `${input.stem}.wav`.match(REC_FILE_RE);
      const derivedTitle = mm ? mm[1]! : null;
      const title = resolveTitle(dir, input.stem, derivedTitle);
      const prompt = summaryPromptSnapshot(ctx.db?.prompts, input.promptId ?? null);
      if (input.promptId && !prompt) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "summary template not found" });
      }
      const result = ctx.recordingPipeline.enqueueReprocess({
        audioPath: wavPath,
        title: title ?? input.stem,
        sendToNotion: input.sendToNotion === true,
        instructions: prompt?.content ?? STANDARD_SUMMARY_INSTRUCTIONS,
      });
      return { ok: true as const, taskId: result.task.id, created: result.created };
    }),
});
