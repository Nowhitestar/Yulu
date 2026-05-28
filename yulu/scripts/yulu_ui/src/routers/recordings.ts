import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { runTranscribe, runSummarize } from "../jobRunner.js";
import type { JobRegistry } from "../jobStatus.js";

export type RecordingType = "voicemail" | "meeting";

const VOICEMAIL_RE = /^voicemail_\d{8}_\d{6}$/;
const VM_FILE_RE = /^(voicemail_\d{8}_\d{6})\.wav$/;
const MTG_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;

export function dispatchType(stem: string): RecordingType {
  return VOICEMAIL_RE.test(stem) ? "voicemail" : "meeting";
}

function isoFromStem(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
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

interface Row {
  stem: string;
  type: RecordingType;
  title: string | null;
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

function listVoicemails(dir: string, registry: JobRegistry): Row[] {
  if (!existsSync(dir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(VM_FILE_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const hasTranscript = existsSync(transcriptPath);
    const job = registry.get(stem);
    const tm = stem.match(/_(\d{8})_(\d{6})$/);
    out.push({
      stem, type: "voicemail", title: null,
      recordedAt: tm ? isoFromStem(tm[1]!, tm[2]!) : null,
      wavPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
      hasTranscript,
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      hasRealtime: false,
      firstWords: hasTranscript ? firstWordsOf(transcriptPath) : null,
      status: job?.state ?? "idle", statusError: job?.error,
    });
  }
  return out;
}

function listMeetings(dir: string, registry: JobRegistry): Row[] {
  if (!existsSync(dir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(MTG_FILE_RE);
    if (!m) continue;
    const [, title, date, time] = m;
    if (title === "voicemail") continue;
    const stem = f.slice(0, -4);
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const job = registry.get(stem);
    out.push({
      stem, type: "meeting", title: title!,
      recordedAt: isoFromStem(date!, time!),
      wavPath, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
      hasTranscript: existsSync(transcriptPath),
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      hasRealtime: existsSync(join(dir, `${stem}.realtime.transcript.txt`)),
      firstWords: firstWordsOf(transcriptPath),
      status: job?.state ?? "idle", statusError: job?.error,
    });
  }
  return out;
}

export const recordingsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
      type: z.enum(["voicemail", "meeting"]).optional(),
    }))
    .query(({ ctx, input }) => {
      let rows: Row[] = [];
      if (input.type !== "meeting") rows = rows.concat(listVoicemails(ctx.paths.voicemailsDir, ctx.jobs));
      if (input.type !== "voicemail") rows = rows.concat(listMeetings(ctx.paths.moviesDir, ctx.jobs));
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (input.since !== undefined) rows = rows.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) rows = rows.slice(0, input.limit);
      return rows;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${input.stem}` });
      const read = (suffix: string) => {
        const p = join(dir, `${input.stem}${suffix}`);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      const stat = statSync(wav);
      const job = ctx.jobs.get(input.stem);
      let title: string | null = null;
      let recordedAt: string | null = null;
      const tm = input.stem.match(/_(\d{8})_(\d{6})$/);
      if (tm) recordedAt = isoFromStem(tm[1]!, tm[2]!);
      if (type === "meeting") {
        const mm = `${input.stem}.wav`.match(MTG_FILE_RE);
        title = mm ? mm[1]! : null;
      }
      return {
        stem: input.stem, type, title, recordedAt,
        wavPath: wav, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
        transcript: read(".transcript.txt"),
        summary: read(".summary.md"),
        realtime: type === "meeting" ? read(".realtime.transcript.txt") : null,
        hasRealtime: type === "meeting" && existsSync(join(dir, `${input.stem}.realtime.transcript.txt`)),
        status: job?.state ?? "idle", statusError: job?.error,
      };
    }),

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const suffixes = [".wav", ".transcript.txt", ".raw.transcript.txt", ".summary.md",
                        ".summary.html", ".realtime.transcript.txt", ".realtime.json", ".title"];
      let removed = 0;
      for (const s of suffixes) {
        const p = join(dir, `${input.stem}${s}`);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("recordings-changed", { reason: "removed" });
      return { removed };
    }),

  transcribe: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const wavPath = join(dir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      void runTranscribe({ stem: input.stem, wavPath, transcribePy: ctx.paths.transcribePy, registry: ctx.jobs, pubsub: ctx.pubsub });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const transcriptPath = join(dir, `${input.stem}.transcript.txt`);
      if (!existsSync(transcriptPath)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transcript missing — run Re-transcribe first" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      const cfg = ctx.config.read();
      const llmCommand = (cfg.llm?.command ?? null) as string[] | null;
      void runSummarize({ stem: input.stem, transcriptPath, summaryPath, llmCommand, agentQueueJson: ctx.paths.agentQueueJson, registry: ctx.jobs, pubsub: ctx.pubsub });
      return { ok: true as const };
    }),
});
