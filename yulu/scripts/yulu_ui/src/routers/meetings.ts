import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { runTranscribe, runSummarize } from "../jobRunner.js";

const STEM_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;

function parseStem(filename: string): { stem: string; title: string; isoTs: string } | null {
  const m = filename.match(STEM_RE);
  if (!m) return null;
  const [, title, date, time] = m;
  if (title === "voicemail") return null;
  const iso = `${date!.slice(0,4)}-${date!.slice(4,6)}-${date!.slice(6,8)}T${time!.slice(0,2)}:${time!.slice(2,4)}:${time!.slice(4,6)}`;
  return { stem: filename.slice(0, -4), title: title!, isoTs: iso };
}

export const meetingsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
    }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      if (!existsSync(dir)) return [];
      const rows = [];
      for (const f of readdirSync(dir)) {
        const parsed = parseStem(f);
        if (!parsed) continue;
        const wavPath = join(dir, f);
        const stat = statSync(wavPath);
        const job = ctx.jobs.get(parsed.stem);
        rows.push({
          stem: parsed.stem,
          meetingTitle: parsed.title,
          recordedAt: parsed.isoTs,
          wavPath,
          sizeBytes: stat.size,
          mtimeMs: stat.mtimeMs,
          hasTranscript: existsSync(join(dir, `${parsed.stem}.transcript.txt`)),
          hasSummary:    existsSync(join(dir, `${parsed.stem}.summary.md`)),
          hasRealtime:   existsSync(join(dir, `${parsed.stem}.realtime.transcript.txt`)),
          firstWords:    firstWordsOf(join(dir, `${parsed.stem}.transcript.txt`)),
          attendeeCount: undefined as number | undefined,
          status:        job?.state ?? "idle",
          statusError:   job?.error,
        });
      }
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      let out = rows;
      if (input.since !== undefined) out = out.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) out = out.slice(0, input.limit);
      return out;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new Error(`meeting not found: ${input.stem}`);
      const read = (suffix: string) => {
        const p = join(dir, `${input.stem}${suffix}`);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      const job = ctx.jobs.get(input.stem);
      return {
        stem: input.stem,
        wavPath: wav,
        sizeBytes: statSync(wav).size,
        mtimeMs: statSync(wav).mtimeMs,
        transcript: read(".transcript.txt"),
        summary:    read(".summary.md"),
        realtime:   read(".realtime.transcript.txt"),
        status:      job?.state ?? "idle",
        statusError: job?.error,
      };
    }),

  audioUrl: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ input }) => `/files/meetings/${input.stem}.wav`),

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.moviesDir;
      const candidates = [".wav", ".transcript.txt", ".raw.transcript.txt", ".summary.md",
                          ".summary.html", ".realtime.transcript.txt", ".realtime.json"]
                          .map((s) => `${input.stem}${s}`);
      let removed = 0;
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("sidebar-counts", { voicemails: 0, meetings: -1, prompts: 0, glossary: 0 });
      return { removed };
    }),

  transcribe: publicProcedure
    .input(z.object({ stem: z.string().regex(/^.+?_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const wavPath = join(ctx.paths.moviesDir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      }
      if (ctx.jobs.get(input.stem)) {
        throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      }
      void runTranscribe({
        stem: input.stem,
        wavPath,
        transcribePy: ctx.paths.transcribePy,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string().regex(/^.+?_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const transcriptPath = join(ctx.paths.moviesDir, `${input.stem}.transcript.txt`);
      if (!existsSync(transcriptPath)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Transcript missing — run Re-transcribe first",
        });
      }
      if (ctx.jobs.get(input.stem)) {
        throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      }
      const summaryPath = join(ctx.paths.moviesDir, `${input.stem}.summary.md`);
      const cfg = ctx.config.read();
      const llmCommand = (cfg.llm?.command ?? null) as string[] | null;
      void runSummarize({
        stem: input.stem,
        transcriptPath,
        summaryPath,
        llmCommand,
        agentQueueJson: ctx.paths.agentQueueJson,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),
});

function firstWordsOf(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (raw.length <= 80) return raw;
    return raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}
