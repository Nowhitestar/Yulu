import type { HostStore } from "./hostStore.js";

export const XAI_CONVERSATION_DISCLOSURE_VERSION = "xai-conversation-v1";

export function hasCurrentXaiConversationDisclosure(
  host: Pick<HostStore, "getAgentConnectionDisclosure">,
): boolean {
  const receipt = host.getAgentConnectionDisclosure("direct-xai", "conversation");
  return receipt?.disclosureVersion === XAI_CONVERSATION_DISCLOSURE_VERSION &&
    receipt.decision === "accepted";
}
