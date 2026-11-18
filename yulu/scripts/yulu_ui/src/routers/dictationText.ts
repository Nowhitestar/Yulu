import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";
import {
  hasXaiDictationTextDisclosure,
  XAI_DICTATION_TEXT_DISCLOSURE_VERSION,
} from "../dictationTextDisclosure.js";

/**
 * The explicit dictation text selection (ADR-010).
 *
 * Cleanup and voice translation send dictated text to xAI only when the audio
 * engine is `xai`, `transcription.dictation.text_provider` is `xai`, an xAI
 * credential source is selected, and this disclosure was accepted. Nothing
 * falls back to another provider or model.
 */
export const dictationTextRouter = router({
  status: publicProcedure.query(({ ctx }) => {
    const config = ctx.config.read();
    const dictation = config.transcription.dictation;
    const receipt = ctx.host.getDictationTextDisclosure("xai");
    const accepted = hasXaiDictationTextDisclosure(ctx.host);
    const credentialSource = ctx.agentConnections?.selectedXaiCredentialSource() ?? null;
    return {
      provider: dictation.text_provider,
      model: dictation.text_model,
      audioEngine: config.transcription.engine,
      credentialSource,
      disclosure: {
        disclosureVersion: XAI_DICTATION_TEXT_DISCLOSURE_VERSION,
        data: "dictated_text" as const,
        destination: "xAI" as const,
        accepted,
        acceptedVersion: accepted ? receipt?.disclosureVersion ?? null : null,
        decidedAt: accepted ? receipt?.decidedAt ?? null : null,
      },
      active: config.transcription.engine === "xai" && dictation.text_provider === "xai" &&
        credentialSource !== null && accepted,
    };
  }),

  acceptDisclosure: uiMutationProcedure.mutation(({ ctx }) => {
    const receipt = ctx.host.recordDictationTextDisclosure("xai", XAI_DICTATION_TEXT_DISCLOSURE_VERSION);
    return { accepted: true as const, disclosureVersion: receipt.disclosureVersion, decidedAt: receipt.decidedAt };
  }),
});
