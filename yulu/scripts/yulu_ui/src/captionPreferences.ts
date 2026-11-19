import { z } from "zod";
import { FAST_DICTATION_MODEL } from "./dictationPreferences.js";

/** Live captions are low-latency, so their default is the fast text model. */
export const CAPTION_TRANSLATION_MODEL_DEFAULT = FAST_DICTATION_MODEL;
/** Caption text leaves the Mac only for an explicitly selected provider (ADR-011). */
export const CaptionTranslationProviderSchema = z.enum(["none", "xai"]);
export type CaptionTranslationProvider = z.infer<typeof CaptionTranslationProviderSchema>;
/** The exact model used for caption translation. Never a fallback. */
export const CaptionTranslationModelSchema = z.string().trim().min(1).max(128);

/** Why a requested caption translation sends nothing. The overlay maps each
 * reason to its own notice. */
export const CAPTION_TRANSLATION_UNAVAILABLE_REASONS = [
  "provider_off",
  "needs_xai_audio",
  "needs_disclosure",
  "needs_connection",
] as const;
export type CaptionTranslationUnavailableReason = typeof CAPTION_TRANSLATION_UNAVAILABLE_REASONS[number];
