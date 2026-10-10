export type TranscriptionFailureReason =
  | "network" | "secure_connection" | "timeout" | "credentials" | "permission"
  | "rate_limit" | "service" | "configuration" | "unknown";

/** Keep public failure categories separate from diagnostic text and nested causes. */
export function transcriptionFailureReason(error: unknown): TranscriptionFailureReason {
  const pending: unknown[] = [error];
  const seen = new Set<object>();
  const messages: string[] = [];
  const codes: string[] = [];
  while (pending.length && seen.size < 16) {
    const item = pending.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    const value = item as { message?: unknown; code?: unknown; name?: unknown; cause?: unknown; errors?: unknown };
    if (typeof value.message === "string") messages.push(value.message);
    for (const code of [value.code, value.name]) if (typeof code === "string") codes.push(code);
    if (value.cause) pending.push(value.cause);
    if (Array.isArray(value.errors)) pending.push(...value.errors.slice(0, 16));
  }
  const message = messages.join("\n");
  const code = codes.join(" ");
  if (/CERT_|SELF_SIGNED_CERT|UNABLE_TO_VERIFY_LEAF_SIGNATURE|ERR_TLS_CERT_ALTNAME_INVALID/.test(code)) return "secure_connection";
  if (/TimeoutError|ETIMEDOUT|UND_ERR_(?:CONNECT|HEADERS|BODY)_TIMEOUT/.test(code)) return "timeout";
  if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET/.test(code)) return "network";

  // Only interpret an upstream status, never the Host's generic 502/503 wrapper.
  const status = Number(message.match(/xAI[^\n]*?[（(](?:HTTP\s+)?(\d{3})[）)]/i)?.[1]
    ?? message.match(/Unexpected server response:\s*(\d{3})/i)?.[1]);
  if (status === 401 || /OAuth 已失效|尚未连接|尚未设置|请先在 Yulu 设置中连接 xAI/.test(message)) return "credentials";
  if (status === 403 || /没有 API 或音频转写权限/.test(message)) return "permission";
  if (status === 429) return "rate_limit";
  if (status >= 500 && status <= 599) return "service";
  if (status) return "unknown";
  if (/Cloud Transcription Consent|本地转写模型尚未安装|显式选择 xAI 凭据来源/.test(message)) return "configuration";
  if (/certificate (?:has expired|verify failed)|self.signed certificate/i.test(message)) return "secure_connection";
  if (/timed?\s*out|timeout|deadline exceeded/i.test(message)) return "timeout";
  if (/fetch failed|network socket disconnected|connection (?:reset|closed)|socket hang up/i.test(message)) return "network";
  return "unknown";
}
