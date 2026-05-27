import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { runTranscribe, runSummarize } from "../jobRunner.js";
import type { JobRegistry } from "../jobStatus.js";

const STEM_RE = /^(voicemail_\d{8}_\d{6})\.wav$/;

function listFromDir(dir: string, registry: JobRegistry) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const rows = [];
  for (const f of entries) {
    const m = f.match(STEM_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const hasTranscript = existsSync(transcriptPath);
    const job = registry.get(stem);
    rows.push({
      stem,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript,
      hasSummary:    existsSync(join(dir, `${stem}.summary.md`)),
      firstWords:    hasTranscript ? firstWordsOf(transcriptPath) : null,
      status:        job?.state ?? "idle",
      statusError:   job?.error,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}

function firstWordsOf(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (raw.length <= 80) return raw;
    return raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}

export const voicemailsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
    }))
    .query(({ ctx, input }) => {
      let rows = listFromDir(ctx.paths.voicemailsDir, ctx.jobs);
      if (input.since !== undefined) rows = rows.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) rows = rows.slice(0, input.limit);
      return rows;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .query(({ ctx, input }) => {
      const dir = ctx.paths.voicemailsDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new Error(`voicemail not found: ${input.stem}`);
      const transcriptPath = join(dir, `${input.stem}.transcript.txt`);
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      const job = ctx.jobs.get(input.stem);
      return {
        stem: input.stem,
        wavPath: wav,
        sizeBytes: statSync(wav).size,
        mtimeMs: statSync(wav).mtimeMs,
        transcript: existsSync(transcriptPath) ? readFileSync(transcriptPath, "utf8") : null,
        summary:    existsSync(summaryPath)    ? readFileSync(summaryPath, "utf8")    : null,
        status:      job?.state ?? "idle",
        statusError: job?.error,
      };
    }),

  audioUrl: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ input }) => `/files/voicemails/${input.stem}.wav`),

  delete: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(({ ctx, input }) => {
      const dir = ctx.paths.voicemailsDir;
      const candidates = [`${input.stem}.wav`, `${input.stem}.transcript.txt`,
                          `${input.stem}.raw.transcript.txt`, `${input.stem}.summary.md`,
                          `${input.stem}.summary.html`, `${input.stem}.title`];
      let removed = 0;
      for (const c of candidates) {
        const p = join(dir, c);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("sidebar-counts", { voicemails: -1, meetings: 0, prompts: 0, glossary: 0 });
      return { removed };
    }),

  transcribe: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const wavPath = join(ctx.paths.voicemailsDir, `${input.stem}.wav`);
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
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const transcriptPath = join(ctx.paths.voicemailsDir, `${input.stem}.transcript.txt`);
      if (!existsSync(transcriptPath)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Transcript missing — run Re-transcribe first",
        });
      }
      if (ctx.jobs.get(input.stem)) {
        throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      }
      const summaryPath = join(ctx.paths.voicemailsDir, `${input.stem}.summary.md`);
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
