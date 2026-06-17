import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { runTranscribe, runSummarize } from "../jobRunner.js";
import type { JobRegistry } from "../jobStatus.js";
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
const SUMMARY_CHANNELS = ["notion", "zulip"] as const;
const SummaryChannelSchema = z.enum(SUMMARY_CHANNELS);
type SummaryChannel = (typeof SUMMARY_CHANNELS)[number];
const SUMMARY_CHANNEL_LABELS: Record<SummaryChannel, string> = {
  notion: "Notion",
  zulip: "Zulip",
};

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

function recordingStatus(stem: string, wavPath: string, registry: JobRegistry): RecordingStatus {
  const job = registry.get(stem);
  if (job?.state === "failed") {
    return {
      status: job.action === "summarize" ? "summary_failed" : "transcription_failed",
      statusError: job.error,
    };
  }
  if (job) return { status: job.state, statusError: job.error };

  const wavError = wavHealthError(wavPath);
  if (wavError) return { status: "recording_failed", statusError: wavError };
  return { status: "idle" };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(root[key]);
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function connectorEnabled(config: unknown, channel: SummaryChannel): boolean {
  const root = asRecord(config);
  const connector = nestedRecord(nestedRecord(root, "connectors"), channel);
  return connector.send_summary === true;
}

function summaryDestination(config: unknown, channel: SummaryChannel): string {
  const output = nestedRecord(asRecord(config), "output");
  if (channel === "notion") {
    const notion = nestedRecord(output, "notion");
    return stringValue(notion, "destination_label")
      || stringValue(notion, "destination_id")
      || stringValue(notion, "database_id");
  }
  if (channel === "zulip") {
    const zulip = nestedRecord(output, "zulip");
    return [stringValue(zulip, "stream"), stringValue(zulip, "topic")].filter(Boolean).join(" / ");
  }
  return "";
}

function enabledSummaryTargets(config: unknown) {
  return SUMMARY_CHANNELS
    .filter((channel) => connectorEnabled(config, channel))
    .map((channel) => ({
      channel,
      label: SUMMARY_CHANNEL_LABELS[channel],
      destination: summaryDestination(config, channel) || "未设置",
    }));
}

function sendSummaryProcess(scriptDir: string, summaryPath: string, channel: SummaryChannel): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn("python3", [
      join(scriptDir, "send_summary.py"),
      "--channel",
      channel,
      summaryPath,
    ], {
      cwd: scriptDir,
      env: { ...process.env, PYTHONPATH: scriptDir },
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", rejectPromise);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

interface Row {
  stem: string;
  title: string | null;
  tags: string[];
  recordedAt: string | null;
  wavPath: string;
  sizeBytes: number;
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

function listRecordings(dir: string, registry: JobRegistry): Row[] {
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
    const currentStatus = recordingStatus(stem, wavPath, registry);
    out.push({
      stem,
      title: resolveTitle(dir, stem, title!),
      tags: readTagsSidecar(join(dir, `${stem}.tags.json`)),
      recordedAt: isoFromStem(date!, time!),
      wavPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
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
      let rows: Row[] = listRecordings(ctx.paths.moviesDir, ctx.jobs);
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
      const currentStatus = recordingStatus(input.stem, wav, ctx.jobs);
      const transcript = read(".transcript.txt");
      const raw = read(".raw.transcript.txt");
      // `.transcript.txt` and `.raw.transcript.txt` are written identically by
      // transcribe.py; `.transcript.txt` may LATER be overwritten by a cleanup
      // prompt while `.raw` keeps the pre-cleanup snapshot. Only surface raw as
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
        enabledSummaryTargets: enabledSummaryTargets(ctx.config.read()),
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
      // Every known sidecar a recording can spawn. `.tags.json`/`.title` are the
      // UI-editable ones; the rest are pipeline outputs.
      const suffixes = [".wav", ".clean.wav", ".transcript.txt", ".raw.transcript.txt",
                        ".realtime.transcript.txt", ".realtime.coverage.json", ".realtime.json",
                        ".speakers.json",
                        ".summary.md", ".summary.html",
                        ".mic.transcript.txt", ".sys.transcript.txt",
                        ".title", ".tags.json"];
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
      ctx.pubsub.publish("recordings-changed", { reason: "removed" });
      return { removed };
    }),

  transcribe: publicProcedure
    .input(z.object({
      stem: z.string(),
      diarizationNumSpeakers: z.number().int().min(1).max(8).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wavPath = join(dir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      void runTranscribe({
        stem: input.stem,
        wavPath,
        transcribePy: ctx.paths.transcribePy,
        diarizationNumSpeakers: input.diarizationNumSpeakers ?? null,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const transcriptPath = join(dir, `${input.stem}.transcript.txt`);
      const realtimePath = join(dir, `${input.stem}.realtime.transcript.txt`);
      const sourcePath = existsSync(transcriptPath) ? transcriptPath : realtimePath;
      if (!existsSync(sourcePath)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transcript missing — run Re-transcribe first" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      const wavPath = join(dir, `${input.stem}.wav`);
      const mm = `${input.stem}.wav`.match(REC_FILE_RE);
      const derivedTitle = mm ? mm[1]! : null;
      const title = resolveTitle(dir, input.stem, derivedTitle);
      const cfg = ctx.config.read();
      const llmCommand = (cfg.llm?.command ?? null) as string[] | null;
      void runSummarize({
        stem: input.stem,
        transcriptPath: sourcePath,
        summaryPath,
        audioPath: existsSync(wavPath) ? wavPath : undefined,
        title,
        llmCommand,
        agentQueueJson: ctx.paths.agentQueueJson,
        scriptDir: ctx.paths.scriptDir,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),

  sendSummary: publicProcedure
    .input(z.object({ stem: z.string(), channel: SummaryChannelSchema }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      requireRecording(dir, input.stem);
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      if (!existsSync(summaryPath)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "summary missing" });
      }
      const cfg = ctx.config.read();
      if (!connectorEnabled(cfg, input.channel)) {
        throw new TRPCError({ code: "BAD_REQUEST", message: `${input.channel} summary target is not enabled` });
      }
      if (!summaryDestination(cfg, input.channel)) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: `${input.channel} destination is not configured` });
      }
      const result = await sendSummaryProcess(ctx.paths.scriptDir, summaryPath, input.channel);
      if (result.code !== 0) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: result.stderr.trim() || result.stdout.trim() || `send_summary.py exited ${result.code}`,
        });
      }
      return { ok: true as const, stdout: result.stdout, stderr: result.stderr };
    }),
});
