import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
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
    const job = registry.get(stem);
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
      const job = ctx.jobs.get(input.stem);
      let recordedAt: string | null = null;
      const tm = input.stem.match(/_(\d{8})_(\d{6})$/);
      if (tm) recordedAt = isoFromStem(tm[1]!, tm[2]!);
      const mm = `${input.stem}.wav`.match(REC_FILE_RE);
      const derivedTitle = mm ? mm[1]! : null;
      const title = resolveTitle(dir, input.stem, derivedTitle);
      const tags = readTagsSidecar(join(dir, `${input.stem}.tags.json`));
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
        wavPath: wav, sizeBytes: stat.size, mtimeMs: stat.mtimeMs,
        transcript,
        raw,
        rawDiffers,
        summary: read(".summary.md"),
        realtime: read(".realtime.transcript.txt"),
        hasRealtime: existsSync(join(dir, `${input.stem}.realtime.transcript.txt`)),
        status: job?.state ?? "idle", statusError: job?.error,
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

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      // Every known sidecar a recording can spawn. `.tags.json`/`.title` are the
      // UI-editable ones; the rest are pipeline outputs.
      const suffixes = [".wav", ".transcript.txt", ".raw.transcript.txt",
                        ".realtime.transcript.txt", ".realtime.coverage.json", ".realtime.json",
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
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wavPath = join(dir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      void runTranscribe({ stem: input.stem, wavPath, transcribePy: ctx.paths.transcribePy, registry: ctx.jobs, pubsub: ctx.pubsub });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
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
