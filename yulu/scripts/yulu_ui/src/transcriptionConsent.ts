import type { HostStore } from "./hostStore.js";

export const XAI_TRANSCRIPTION_DISCLOSURE_VERSION = "xai-audio-v1";

export function hasCurrentXaiTranscriptionConsent(
  host: Pick<HostStore, "getCloudTranscriptionConsent">,
): boolean {
  return host.getCloudTranscriptionConsent()?.disclosureVersion === XAI_TRANSCRIPTION_DISCLOSURE_VERSION;
}
