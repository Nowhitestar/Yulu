import { z } from "zod";
import { FAST_DICTATION_MODEL } from "./dictationPreferences.js";

/** Live notes must keep up with the meeting, so their default is the fast model. */
export const LIVE_NOTES_MODEL_DEFAULT = FAST_DICTATION_MODEL;

/**
 * `xai` is the default; `none` keeps meeting text on this Mac. Even with `xai`,
 * nothing is sent before the live notes disclosure is accepted.
 */
export const LiveNotesProviderSchema = z.enum(["none", "xai"]);
export type LiveNotesProvider = z.infer<typeof LiveNotesProviderSchema>;

export const LiveNotesLanguageSchema = z.enum(["zh", "en"]);
export type LiveNotesLanguage = z.infer<typeof LiveNotesLanguageSchema>;

/** The exact model used for live notes. Never a fallback. */
export const LiveNotesModelSchema = z.string().trim().min(1).max(128);

/** Why live notes send nothing. The panel names the missing step. */
export const LIVE_NOTES_UNAVAILABLE_REASONS = [
  "provider_off",
  "needs_disclosure",
  "needs_connection",
] as const;
export type LiveNotesUnavailableReason = typeof LIVE_NOTES_UNAVAILABLE_REASONS[number];

/** Notes follow the interface language until the person picks one. */
export function liveNotesLanguage(
  liveNotes: { language?: LiveNotesLanguage | undefined } | undefined,
  uiLanguage: string | undefined,
): LiveNotesLanguage {
  return liveNotes?.language ?? (uiLanguage === "en" ? "en" : "zh");
}
