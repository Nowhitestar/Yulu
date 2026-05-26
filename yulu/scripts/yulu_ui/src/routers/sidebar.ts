import { readdirSync, existsSync } from "node:fs";
import { router, publicProcedure } from "../trpc.js";

const MEETING_STEM_RE = /^(?!voicemail_)(.+?)_\d{8}_\d{6}\.wav$/;
const VOICEMAIL_STEM_RE = /^voicemail_\d{8}_\d{6}\.wav$/;

export const sidebarRouter = router({
  counts: publicProcedure.query(({ ctx }) => {
    const meetings = existsSync(ctx.paths.moviesDir)
      ? readdirSync(ctx.paths.moviesDir).filter((f) => MEETING_STEM_RE.test(f)).length
      : 0;
    const voicemails = existsSync(ctx.paths.voicemailsDir)
      ? readdirSync(ctx.paths.voicemailsDir).filter((f) => VOICEMAIL_STEM_RE.test(f)).length
      : 0;
    const prompts = (ctx.db.prompts.prepare("SELECT COUNT(*) AS n FROM prompts").get() as { n: number }).n;
    const glossary = (ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM vocab").get() as { n: number }).n;
    return { voicemails, meetings, prompts, glossary };
  }),
});
