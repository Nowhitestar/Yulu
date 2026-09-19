import type { XaiCredentialManager, XaiCredentialSource } from "./xaiCredentials.js";

const XAI_RESPONSES_URL = "https://api.x.ai/v1/responses";
const SUMMARY_REQUEST_TIMEOUT_MS = 180_000;
const CONVERSATION_REQUEST_TIMEOUT_MS = 30_000;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_INPUT_MESSAGES = 64;
const MAX_OUTPUT_TOKENS = 8_192;
const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 131_072;
const OUTPUT_LIMIT_ERROR = "xAI text response exceeded the output limit";

export type XaiTextCapability = "summary" | "conversation" | "dictation";

export interface XaiTextMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface XaiTextRequest {
  capability: XaiTextCapability;
  model: string;
  credentialSource?: XaiCredentialSource;
  input: XaiTextMessage[];
  maxOutputTokens?: number;
  timeoutMs?: number;
  /** Receives provisional full-text snapshots; only the returned result is final. */
  onText?: (text: string) => void;
}

export interface XaiTextResult {
  text: string;
  model: string;
  credentialSource: XaiCredentialSource;
}

export class XaiTextUnknownOutcomeError extends Error {
  readonly capability: XaiTextCapability;
  readonly model: string;
  readonly credentialSource: XaiCredentialSource;

  constructor(input: {
    capability: XaiTextCapability;
    model: string;
    credentialSource: XaiCredentialSource;
  }) {
    super(`xAI ${input.capability} entered Unknown Outcome; do not retry this execution automatically`);
    this.name = "XaiTextUnknownOutcomeError";
    this.capability = input.capability;
    this.model = input.model;
    this.credentialSource = input.credentialSource;
  }
}

class XaiTextResponseTransportError extends Error {}

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

function outputModel(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("xAI text response was invalid");
  }
  const model = (payload as { model?: unknown }).model;
  if (typeof model !== "string" || !model.trim() || model.length > 128) {
    throw new Error("xAI text response model was invalid");
  }
  return model.trim();
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
    throw new XaiTextResponseTransportError("xAI text response transport was lost");
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), bytes).toString("utf8");
}

async function readStreamingResponse(response: Response, model: string, onText: (text: string) => void): Promise<unknown> {
  if (!response.body) throw new XaiTextResponseTransportError("xAI stream ended before completion");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let bytes = 0;
  let text = "";
  let verifiedModel = false;
  let completed: unknown;
  const event = (frame: string) => {
    const data = frame.split("\n").filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart()).join("\n");
    if (!data || data === "[DONE]") return;
    let item: { type?: string; delta?: unknown; response?: unknown };
    try { item = JSON.parse(data); } catch { throw new Error("xAI streaming response was invalid"); }
    if (!item || typeof item !== "object") throw new Error("xAI streaming response was invalid");
    if (item.response) {
      const actualModel = outputModel(item.response);
      if (actualModel !== model) throw new Error(`Pinned xAI model ${model} does not match response model ${actualModel}`);
      verifiedModel = true;
    }
    if (item.type === "response.output_text.delta" && typeof item.delta === "string") {
      text += item.delta;
      if (text.length > MAX_OUTPUT_CHARS || Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) throw new Error(OUTPUT_LIMIT_ERROR);
      if (verifiedModel) onText(text);
    }
    if (item.type === "response.completed") {
      if ((item.response as { status?: unknown } | undefined)?.status !== "completed") throw new Error("xAI streaming response was incomplete");
      completed = item.response;
    }
    if (["error", "response.failed", "response.incomplete"].includes(item.type ?? "")) {
      throw new Error("xAI streaming response was incomplete");
    }
  };
  try {
    while (!completed) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); }
      catch { throw new XaiTextResponseTransportError("xAI streaming response transport was lost"); }
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES * 4) throw new Error(OUTPUT_LIMIT_ERROR);
      buffer += decoder.decode(chunk.value, { stream: true });
      // Normalize only complete lines so a CR/LF pair split across reads stays intact.
      buffer = buffer.replace(/\r\n/g, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        event(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (completed) break;
      }
      if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(OUTPUT_LIMIT_ERROR);
    }
    if (!completed) throw new XaiTextResponseTransportError("xAI stream ended before completion");
    return completed;
  } finally {
    try { await reader.cancel(); } catch { /* final state/error already determined */ }
    reader.releaseLock();
  }
}

export class XaiTextClient {
  constructor(
    private readonly credentials: Pick<XaiCredentialManager, "resolve">,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async request(request: XaiTextRequest): Promise<XaiTextResult> {
    const { model, maxOutputTokens } = validateRequest(request);
    const defaultTimeout = request.capability === "summary" ? SUMMARY_REQUEST_TIMEOUT_MS
      : request.capability === "dictation" ? 8_000 : CONVERSATION_REQUEST_TIMEOUT_MS;
    const timeoutMs = request.timeoutMs ?? defaultTimeout;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > defaultTimeout) {
      throw new Error("xAI text timeout is invalid");
    }
    const signal = AbortSignal.timeout(timeoutMs);
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("xAI text deadline exceeded before request"));
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    const credential = await Promise.race([this.credentials.resolve(request.credentialSource), cancelled])
      .finally(() => signal.removeEventListener("abort", onAbort));
    if (signal.aborted) throw new Error("xAI text deadline exceeded before request");
    if (request.credentialSource && credential.source !== request.credentialSource) {
      throw new Error(`Pinned xAI credential ${request.credentialSource} does not match resolved credential ${credential.source}`);
    }
    let response: Response;
    try {
      response = await this.fetchFn(XAI_RESPONSES_URL, {
        method: "POST",
        redirect: "error",
        headers: {
          Accept: request.onText ? "text/event-stream" : "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          input: request.input,
          max_output_tokens: maxOutputTokens,
          store: false,
          ...(request.onText ? { stream: true } : {}),
        }),
        signal,
      });
    } catch {
      throw new XaiTextUnknownOutcomeError({
        capability: request.capability,
        model,
        credentialSource: credential.source,
      });
    }
    if (!response.ok) {
      throw new Error(`xAI ${request.capability} request failed (HTTP ${response.status})`);
    }
    let payload: unknown;
    try {
      if (request.onText) payload = await readStreamingResponse(response, model, request.onText);
      else {
        const raw = await readBoundedResponse(response);
        try { payload = JSON.parse(raw); }
        catch { throw new Error("xAI text response was invalid"); }
      }
    } catch (error) {
      if (error instanceof XaiTextResponseTransportError) {
        throw new XaiTextUnknownOutcomeError({
          capability: request.capability,
          model,
          credentialSource: credential.source,
        });
      }
      throw error;
    }
    if (request.capability === "dictation" && (payload as { status?: string } | null)?.status !== "completed") {
      throw new Error("xAI dictation cleanup was incomplete");
    }
    const responseModel = outputModel(payload);
    if (responseModel !== model) {
      throw new Error(`Pinned xAI model ${model} does not match response model ${responseModel}`);
    }
    return {
      text: outputText(payload),
      model: responseModel,
      credentialSource: credential.source,
    };
  }
}
