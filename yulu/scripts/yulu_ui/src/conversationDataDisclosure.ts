import type { HostStore } from "./hostStore.js";

export const XAI_CONVERSATION_DISCLOSURE_VERSION = "xai-conversation-v1";
export const CODEX_CONVERSATION_DISCLOSURE_VERSION = "codex-conversation-v1";
export const CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION = "claude-code-conversation-v1";
export const HERMES_CONVERSATION_DISCLOSURE_VERSION = "hermes-conversation-v1";
export const OPENCLAW_CONVERSATION_DISCLOSURE_VERSION = "openclaw-conversation-v1";

export function hasCurrentAgentConversationDisclosure(
  host: Pick<HostStore, "getAgentConnectionDisclosure">,
  connectionId: string,
  disclosureVersion: string,
): boolean {
  const receipt = host.getAgentConnectionDisclosure(connectionId, "conversation");
  return receipt?.disclosureVersion === disclosureVersion && receipt.decision === "accepted";
}

export function hasCurrentXaiConversationDisclosure(
  host: Pick<HostStore, "getAgentConnectionDisclosure">,
): boolean {
  return hasCurrentAgentConversationDisclosure(
    host,
    "direct-xai",
    XAI_CONVERSATION_DISCLOSURE_VERSION,
  );
}
