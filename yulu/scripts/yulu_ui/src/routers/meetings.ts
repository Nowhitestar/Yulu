import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

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
      return {
        stem: input.stem,
        wavPath: wav,
        sizeBytes: statSync(wav).size,
        mtimeMs: statSync(wav).mtimeMs,
        transcript: read(".transcript.txt"),
        summary:    read(".summary.md"),
        realtime:   read(".realtime.transcript.txt"),
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
});
