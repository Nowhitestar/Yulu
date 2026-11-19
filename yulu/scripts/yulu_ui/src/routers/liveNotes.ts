import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";
import { hasXaiLiveNotesDisclosure, XAI_LIVE_NOTES_DISCLOSURE_VERSION } from "../liveNotes.js";
import { liveNotesLanguage, LiveNotesLanguageSchema } from "../liveNotesPreferences.js";

/**
 * Live notes during a recording. Meeting text is sent to xAI only when
 * `transcription.live_notes.provider` is `xai`, this disclosure was accepted
 * and an xAI credential source is selected. The attendee's own notes are kept
 * on this Mac either way. Nothing falls back to another provider or model.
 */
export const liveNotesRouter = router({
  status: publicProcedure.query(({ ctx }) => {
    const config = ctx.config.read();
    const liveNotes = config.transcription.live_notes;
    const receipt = ctx.host.getLiveNotesDisclosure("xai");
    const accepted = hasXaiLiveNotesDisclosure(ctx.host);
    const credentialSource = ctx.agentConnections?.selectedXaiCredentialSource() ?? null;
    return {
      provider: liveNotes.provider,
      model: liveNotes.model,
      language: liveNotesLanguage(liveNotes, config.ui.language),
      credentialSource,
      disclosure: {
        disclosureVersion: XAI_LIVE_NOTES_DISCLOSURE_VERSION,
        data: "meeting_text" as const,
        destination: "xAI" as const,
        accepted,
        decidedAt: accepted ? receipt?.decidedAt ?? null : null,
      },
      active: liveNotes.provider === "xai" && credentialSource !== null && accepted,
    };
  }),

  acceptDisclosure: uiMutationProcedure.mutation(({ ctx }) => {
    const receipt = ctx.host.recordLiveNotesDisclosure("xai", XAI_LIVE_NOTES_DISCLOSURE_VERSION);
    return { accepted: true as const, disclosureVersion: receipt.disclosureVersion, decidedAt: receipt.decidedAt };
  }),

  /** The notes of the meeting being recorded, or null. */
  current: publicProcedure.query(({ ctx }) => ctx.liveNotes?.current() ?? null),

  addNote: uiMutationProcedure
    .input(z.object({ stem: z.string().min(1).max(255), text: z.string().min(1).max(2_000) }))
    .mutation(({ ctx, input }) => {
      if (!ctx.liveNotes) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Live notes are unavailable" });
      try { return ctx.liveNotes.addNote(input.stem, input.text); }
      catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message }); }
    }),

  setLanguage: uiMutationProcedure
    .input(z.object({ stem: z.string().min(1).max(255), language: LiveNotesLanguageSchema }))
    .mutation(({ ctx, input }) => {
      if (!ctx.liveNotes) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Live notes are unavailable" });
      try { return ctx.liveNotes.setLanguage(input.stem, input.language); }
      catch (error) { throw new TRPCError({ code: "BAD_REQUEST", message: (error as Error).message }); }
    }),
});
