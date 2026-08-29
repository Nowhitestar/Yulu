import { createHash } from "node:crypto";

export interface AgentConnectionRevisionInput {
  adapter: string;
  label: string;
  lifecycle: string;
  settings: Record<string, unknown>;
}

export function agentConnectionRevision(connection: AgentConnectionRevisionInput): string {
  return createHash("sha256").update(JSON.stringify({
    adapter: connection.adapter,
    label: connection.label,
    lifecycle: connection.lifecycle,
    settings: connection.settings,
  })).digest("hex");
}
