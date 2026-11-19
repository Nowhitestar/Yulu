import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";
import {
  hasXaiCaptionTextDisclosure,
  XAI_CAPTION_TEXT_DISCLOSURE_VERSION,
} from "../captionTranslation.js";

/**
 * The explicit live-caption translation selection (ADR-011).
 *
 * Caption text is sent to xAI only when the audio engine is `xai`,
 * `transcription.captions.translation_provider` is `xai`, this disclosure was
 * accepted and an xAI credential source is selected. Choosing a translated
 * overlay mode is a per-recording request, never consent. Nothing falls back to
 * another provider or model.
 */
export const captionTranslationRouter = router({
  status: publicProcedure.query(({ ctx }) => {
    const config = ctx.config.read();
    const captions = config.transcription.captions;
    const receipt = ctx.host.getCaptionTranslationDisclosure("xai");
    const accepted = hasXaiCaptionTextDisclosure(ctx.host);
    const credentialSource = ctx.agentConnections?.selectedXaiCredentialSource() ?? null;
    return {
      provider: captions.translation_provider,
      model: captions.translation_model,
      audioEngine: config.transcription.engine,
      credentialSource,
      disclosure: {
        disclosureVersion: XAI_CAPTION_TEXT_DISCLOSURE_VERSION,
        data: "caption_text" as const,
        destination: "xAI" as const,
        accepted,
        acceptedVersion: accepted ? receipt?.disclosureVersion ?? null : null,
        decidedAt: accepted ? receipt?.decidedAt ?? null : null,
      },
      active: config.transcription.engine === "xai" && captions.translation_provider === "xai" &&
        credentialSource !== null && accepted,
    };
  }),

  acceptDisclosure: uiMutationProcedure.mutation(({ ctx }) => {
    const receipt = ctx.host.recordCaptionTranslationDisclosure("xai", XAI_CAPTION_TEXT_DISCLOSURE_VERSION);
    return { accepted: true as const, disclosureVersion: receipt.disclosureVersion, decidedAt: receipt.decidedAt };
  }),
});
