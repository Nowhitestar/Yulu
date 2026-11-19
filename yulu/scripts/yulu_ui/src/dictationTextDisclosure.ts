import type { ConfigManager } from "./config.js";
import type { HostStore } from "./hostStore.js";

export const XAI_DICTATION_TEXT_DISCLOSURE_VERSION = "xai-dictation-text-v1";

/** The disclosure of the retired xAI Conversation capability. Dictated text was
 * sent under it before ADR-010, so a receipt carried over at upgrade keeps this
 * version instead of claiming the user accepted the newer wording. */
export const RETIRED_XAI_CONVERSATION_DISCLOSURE_VERSION = "xai-conversation-v1";

const CARRY_OVER_MIGRATION_ID = "dictation-text-disclosure-v1";

export function hasXaiDictationTextDisclosure(
  host: Pick<HostStore, "getDictationTextDisclosure">,
): boolean {
  const version = host.getDictationTextDisclosure("xai")?.disclosureVersion;
  return version === XAI_DICTATION_TEXT_DISCLOSURE_VERSION ||
    version === RETIRED_XAI_CONVERSATION_DISCLOSURE_VERSION;
}

/**
 * One-time upgrade step. Where dictation text was already going to xAI (the
 * config migration kept `text_provider: "xai"`), copy the accepted Conversation
 * receipt so cleanup does not stop. Everyone else accepts the dictation
 * disclosure when they turn the provider on.
 */
export function carryOverRetiredConversationDisclosure(
  host: Pick<
    HostStore,
    "hasAgentConnectionMigration" | "recordAgentConnectionMigration" | "carryOverRetiredXaiConversationDisclosure"
  >,
  config: Pick<ConfigManager, "read">,
): boolean {
  if (host.hasAgentConnectionMigration(CARRY_OVER_MIGRATION_ID)) return false;
  const carried = config.read().transcription.dictation.text_provider === "xai" &&
    host.carryOverRetiredXaiConversationDisclosure(RETIRED_XAI_CONVERSATION_DISCLOSURE_VERSION) !== null;
  host.recordAgentConnectionMigration(CARRY_OVER_MIGRATION_ID);
  return carried;
}
