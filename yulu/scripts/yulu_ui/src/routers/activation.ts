import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { verifiedCoreActivationEvidence } from "../coreActivation.js";
import { publicProcedure, router } from "../trpc.js";

export const activationRouter = router({
  status: publicProcedure.query(({ ctx }) => {
    let evidence = ctx.host.getCoreActivationEvidence();
    if (!evidence) {
      for (const candidate of ctx.host.listCoreActivationCandidates()) {
        const verified = verifiedCoreActivationEvidence(candidate, ctx.artifacts, ctx.paths.moviesDir);
        if (verified) {
          evidence = ctx.host.recordCoreActivationEvidence(verified);
          break;
        }
      }
    }
    if (!evidence) return { state: "unresolved" as const, evidence: null };
    const safeStem = basename(evidence.recordingStem) === evidence.recordingStem;
    const sourceArtifactAvailable = safeStem && existsSync(join(ctx.paths.moviesDir, `${evidence.recordingStem}.wav`));
    let completedNote: string | null = null;
    if (safeStem) {
      const summaryPath = join(ctx.paths.moviesDir, `${evidence.recordingStem}.summary.md`);
      if (existsSync(summaryPath)) {
        try {
          completedNote = readFileSync(summaryPath, "utf8").trim() || null;
        } catch { /* a missing or unreadable note is not an available action */ }
      }
    }
    return {
      state: "activated" as const,
      evidence,
      sourceArtifactAvailable,
      completedNoteAvailable: completedNote !== null,
      completedNote,
    };
  }),
});
