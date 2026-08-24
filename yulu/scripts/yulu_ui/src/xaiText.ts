import type { XaiCredentialManager, XaiCredentialSource } from "./xaiCredentials.js";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_INPUT_MESSAGES = 64;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 131_072;
const OUTPUT_LIMIT_ERROR = "xAI text response exceeded the output limit";

export type XaiTextCapability = "summary" | "conversation";

export interface XaiTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface XaiTextRequest {
  capability: XaiTextCapability;
  model: string;
  input: XaiTextMessage[];
  maxOutputTokens?: number;
}

export interface XaiTextResult {
  text: string;
  model: string;
  credentialSource: XaiCredentialSource;
}

function validateRequest(request: XaiTextRequest): { model: string; maxOutputTokens: number } {
  const model = request.model.trim();
  if (!model || model.length > 128) throw new Error("xAI model identity is invalid");
  if (request.input.length === 0 || request.input.length > MAX_INPUT_MESSAGES) {
    throw new Error("xAI text input message count is invalid");
  }
  let bytes = 0;
  for (const message of request.input) {
    if (!message.content || !["system", "user", "assistant"].includes(message.role)) {
      throw new Error("xAI text input is invalid");
    }
    bytes += Buffer.byteLength(message.content, "utf8");
  }
  if (bytes > MAX_INPUT_BYTES) throw new Error("xAI text input exceeds 1000000 bytes");
  const maxOutputTokens = request.maxOutputTokens ?? 4_096;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > MAX_OUTPUT_TOKENS) {
    throw new Error("xAI max output tokens is invalid");
  }
  return { model, maxOutputTokens };
}

function outputText(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("xAI text response was invalid");
  }
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) throw new Error("xAI text response was invalid");
  const text = output.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    return content.flatMap((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return [];
      const value = part as { type?: unknown; text?: unknown };
      return value.type === "output_text" && typeof value.text === "string" ? [value.text] : [];
    });
  }).join("\n").trim();
  if (!text) throw new Error("xAI text response was empty");
  if (text.length > MAX_OUTPUT_CHARS || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(OUTPUT_LIMIT_ERROR);
  }
  return text;
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
    throw new Error(OUTPUT_LIMIT_ERROR);
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error(OUTPUT_LIMIT_ERROR);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof Error && error.message === OUTPUT_LIMIT_ERROR) throw error;
    try { await reader.cancel(); } catch { /* best effort */ }
    throw new Error("xAI text response was invalid");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}

export class XaiTextClient {
  constructor(
    private readonly credentials: Pick<XaiCredentialManager, "resolve">,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(request: XaiTextRequest): Promise<XaiTextResult> {
    const { model, maxOutputTokens } = validateRequest(request);
    const credential = await this.credentials.resolve();
    let response: Response;
    try {
      response = await this.fetchFn(XAI_RESPONSES_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: request.input,
          max_output_tokens: maxOutputTokens,
          store: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new Error(`xAI ${request.capability} request failed`);
    }
    if (!response.ok) {
      throw new Error(`xAI ${request.capability} request failed (HTTP ${response.status})`);
    }
    const raw = await readBoundedResponse(response);
    let payload: unknown;
    try { payload = JSON.parse(raw); }
    catch { throw new Error("xAI text response was invalid"); }
    return {
      text: outputText(payload),
      model,
      credentialSource: credential.source,
    };
  }
}
