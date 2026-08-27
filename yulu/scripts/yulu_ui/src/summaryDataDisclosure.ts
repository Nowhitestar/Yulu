import type { HostStore } from "./hostStore.js";

export const XAI_SUMMARY_DISCLOSURE_VERSION = "xai-summary-v1";
export const CODEX_SUMMARY_DISCLOSURE_VERSION = "codex-summary-v1";
export const CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION = "claude-code-summary-v1";

export function hasCurrentSummaryDataPathDisclosure(
  host: Pick<HostStore, "getSummaryDataPathDisclosure">,
  provider: string,
  disclosureVersion: string,
): boolean {
  const receipt = host.getSummaryDataPathDisclosure(provider);
  return receipt?.disclosureVersion === disclosureVersion && receipt.decision === "accepted";
}

export function hasCurrentXaiSummaryDisclosure(
  host: Pick<HostStore, "getSummaryDataPathDisclosure">,
): boolean {
  return hasCurrentSummaryDataPathDisclosure(host, "xai", XAI_SUMMARY_DISCLOSURE_VERSION);
}
