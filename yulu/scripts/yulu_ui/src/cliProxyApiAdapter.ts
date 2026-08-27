import { lookup as dnsLookup } from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { SummaryCommitRuntimeEvidence } from "./hostStore.js";

const MAX_RESPONSE_BYTES = 1_000_000;
const MAX_OUTPUT_CHARS = 131_072;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;
export const CLIPROXYAPI_CONTRACT_VERSION = "cliproxyapi-v0.23.0-rc.1-openai-responses";

export type GatewayTransportIdentity = "loopback-http" | "approved-https";

export interface GatewayEndpointIdentity {
  endpoint: string;
  transport: GatewayTransportIdentity;
}

export interface GatewaySecretStore {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface GatewayRuntimeEvidence extends SummaryCommitRuntimeEvidence {
  endpoint: string;
  toolsEnabled: false;
}

export function isExactGatewayRuntimeEvidence(
  evidence: SummaryCommitRuntimeEvidence,
  expected: { endpoint: string; model: string; terminalStatus: "ready" | "unknown" },
): evidence is GatewayRuntimeEvidence {
  let expectedTransport: string;
  try {
    const protocol = new URL(expected.endpoint).protocol;
    if (protocol !== "http:" && protocol !== "https:") return false;
    expectedTransport = protocol === "https:"
      ? "openai-responses-approved-https"
      : "openai-responses-loopback-http";
  } catch {
    return false;
  }
  const ready = expected.terminalStatus === "ready";
  const requestIdMatches = ready
    ? typeof evidence.requestId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(evidence.requestId)
    : evidence.requestId === null;
  return evidence.adapter === "cliproxyapi" && evidence.transport === expectedTransport &&
    evidence.runtimeVersion === CLIPROXYAPI_CONTRACT_VERSION && evidence.endpoint === expected.endpoint &&
    evidence.requestedProvider === null && evidence.actualProvider === null &&
    evidence.requestedModel === expected.model && evidence.actualModel === (ready ? expected.model : null) &&
    requestIdMatches && evidence.sessionId === null &&
    evidence.terminalStatus === expected.terminalStatus && evidence.fallbackOccurred === false &&
    evidence.toolsEnabled === false;
}

export interface GatewayTransportRequest {
  endpoint: string;
  httpsApproved: boolean;
  key: string;
  body: Record<string, unknown>;
  timeoutMs: number;
}

export interface GatewayTransport {
  validate(endpoint: string, httpsApproved: boolean): Promise<GatewayEndpointIdentity>;
  responses(request: GatewayTransportRequest): Promise<unknown>;
}

type LookupAddress = { address: string; family: number };
export type GatewayLookup = (hostname: string) => Promise<LookupAddress[]>;

export class GatewayNetworkPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayNetworkPolicyError";
  }
}

class GatewayTransportUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTransportUnknownOutcomeError";
  }
}

export class GatewayRequestUnknownOutcomeError extends Error {
  readonly executionId: string;
  readonly evidence: GatewayRuntimeEvidence;

  constructor(message: string, evidence: GatewayRuntimeEvidence) {
    super(message);
    this.name = "GatewayRequestUnknownOutcomeError";
    this.executionId = `gateway-${randomUUID()}`;
    this.evidence = evidence;
  }
}

function ipv4Number(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map(Number);
  if (octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!) >>> 0;
}

function inIpv4Cidr(address: number, base: string, bits: number): boolean {
  const network = ipv4Number(base)!;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (address & mask) === (network & mask);
}

function isLoopbackAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::1") return true;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = ipv4Number(mapped ?? normalized);
  return ipv4 !== null && inIpv4Cidr(ipv4, "127.0.0.0", 8);
}

const GLOBAL_IPV6 = new BlockList();
GLOBAL_IPV6.addSubnet("2000::", 3, "ipv6");
const UNSAFE_GLOBAL_IPV6 = new BlockList();
UNSAFE_GLOBAL_IPV6.addSubnet("2001::", 23, "ipv6");
UNSAFE_GLOBAL_IPV6.addSubnet("2001:db8::", 32, "ipv6");
UNSAFE_GLOBAL_IPV6.addSubnet("2002::", 16, "ipv6");
UNSAFE_GLOBAL_IPV6.addSubnet("3ffe::", 16, "ipv6");
UNSAFE_GLOBAL_IPV6.addSubnet("3fff::", 20, "ipv6");

function isUnsafePublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  const ipv4 = ipv4Number(mapped ?? normalized);
  if (ipv4 !== null) {
    return [
      ["0.0.0.0", 8],
      ["10.0.0.0", 8],
      ["100.64.0.0", 10],
      ["127.0.0.0", 8],
      ["169.254.0.0", 16],
      ["172.16.0.0", 12],
      ["192.0.0.0", 24],
      ["192.0.2.0", 24],
      ["192.88.99.0", 24],
      ["192.168.0.0", 16],
      ["198.18.0.0", 15],
      ["198.51.100.0", 24],
      ["203.0.113.0", 24],
      ["224.0.0.0", 4],
      ["240.0.0.0", 4],
    ].some(([base, bits]) => inIpv4Cidr(ipv4, base as string, bits as number));
  }
  if (isIP(normalized) !== 6) return true;
  return !GLOBAL_IPV6.check(normalized, "ipv6") || UNSAFE_GLOBAL_IPV6.check(normalized, "ipv6");
}

function parseEndpoint(value: string): URL {
  let parsed: URL;
  try { parsed = new URL(value.trim()); }
  catch { throw new GatewayNetworkPolicyError("Gateway endpoint is not a valid URL"); }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GatewayNetworkPolicyError("Gateway endpoint must use HTTP or HTTPS");
  }
  if (parsed.username || parsed.password) {
    throw new GatewayNetworkPolicyError("Gateway endpoint must not contain userinfo");
  }
  if (parsed.search || parsed.hash) {
    throw new GatewayNetworkPolicyError("Gateway endpoint must not contain a query or fragment");
  }
  if (!parsed.hostname) throw new GatewayNetworkPolicyError("Gateway endpoint hostname is required");
  return parsed;
}

function endpointIdentity(value: string): GatewayEndpointIdentity {
  const parsed = parseEndpoint(value);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  return {
    endpoint: parsed.toString().replace(/\/$/, ""),
    transport: parsed.protocol === "http:" ? "loopback-http" : "approved-https",
  };
}

function dnsHostname(parsed: URL): string {
  const hostname = parsed.hostname;
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

const defaultLookup: GatewayLookup = async (hostname) => {
  try {
    return await dnsLookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new GatewayNetworkPolicyError("Gateway endpoint DNS resolution failed");
  }
};

function validateResolvedAddresses(
  parsed: URL,
  addresses: LookupAddress[],
  httpsApproved: boolean,
): void {
  if (addresses.length === 0 || addresses.some((entry) => isIP(entry.address) === 0)) {
    throw new GatewayNetworkPolicyError("Gateway endpoint DNS resolution was invalid");
  }
  if (parsed.protocol === "http:") {
    if (!addresses.every((entry) => isLoopbackAddress(entry.address))) {
      throw new GatewayNetworkPolicyError("HTTP Gateway endpoints are allowed only on loopback");
    }
    return;
  }
  if (!httpsApproved) {
    throw new GatewayNetworkPolicyError("HTTPS Gateway endpoint must be explicitly approved");
  }
  if (addresses.some((entry) => isUnsafePublicAddress(entry.address))) {
    throw new GatewayNetworkPolicyError("HTTPS Gateway endpoint resolved to an unsafe destination");
  }
}

export async function validateGatewayEndpoint(
  value: string,
  httpsApproved: boolean,
  lookup: GatewayLookup = defaultLookup,
): Promise<GatewayEndpointIdentity> {
  const parsed = parseEndpoint(value);
  const addresses = await lookup(dnsHostname(parsed));
  validateResolvedAddresses(parsed, addresses, httpsApproved);
  return endpointIdentity(value);
}

function unknownTimeout(): GatewayTransportUnknownOutcomeError {
  return new GatewayTransportUnknownOutcomeError("Gateway request outcome is unknown after timeout");
}

function preDispatchTimeout(): GatewayNetworkPolicyError {
  return new GatewayNetworkPolicyError("Gateway request timed out before dispatch");
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw preDispatchTimeout();
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(preDispatchTimeout()), remaining);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readResponseBody(response: NodeJS.ReadableStream, contentLength?: string): Promise<string> {
  const declared = Number(contentLength);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error("Gateway response exceeded the output limit");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of response) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > MAX_RESPONSE_BYTES) throw new Error("Gateway response exceeded the output limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export class SecureGatewayTransport implements GatewayTransport {
  private readonly lookup: GatewayLookup;

  constructor(options: { lookup?: GatewayLookup } = {}) {
    this.lookup = options.lookup ?? defaultLookup;
  }

  validate(endpoint: string, httpsApproved: boolean): Promise<GatewayEndpointIdentity> {
    return validateGatewayEndpoint(endpoint, httpsApproved, this.lookup);
  }

  async responses(input: GatewayTransportRequest): Promise<unknown> {
    const deadline = Date.now() + input.timeoutMs;
    const identity = await beforeDeadline(this.validate(input.endpoint, input.httpsApproved), deadline);
    const url = new URL(`${identity.endpoint}/responses`);
    const raw = await this.post(url, input, 0, url.origin, deadline);
    try { return JSON.parse(raw) as unknown; }
    catch { throw new Error("Gateway returned invalid JSON"); }
  }

  private async post(
    url: URL,
    input: GatewayTransportRequest,
    redirects: number,
    approvedOrigin: string,
    deadline: number,
  ): Promise<string> {
    if (redirects > MAX_REDIRECTS) throw new GatewayNetworkPolicyError("Gateway redirect limit exceeded");
    const identity = await beforeDeadline(this.validate(url.toString(), input.httpsApproved), deadline);
    const approvedUrl = new URL(identity.endpoint);
    const addresses = await beforeDeadline(this.lookup(dnsHostname(approvedUrl)), deadline);
    validateResolvedAddresses(approvedUrl, addresses, input.httpsApproved);
    if (Date.now() >= deadline) throw preDispatchTimeout();
    const selected = addresses[0];
    if (!selected) throw new GatewayNetworkPolicyError("Gateway endpoint DNS resolution failed");
    const body = JSON.stringify(input.body);
    const request = approvedUrl.protocol === "https:" ? httpsRequest : httpRequest;
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      let dispatchPossible = false;
      const finish = (error?: Error, value?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value ?? "");
      };
      const outbound = request(approvedUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${input.key}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        lookup: (_hostname, options, callback) => {
          if ((options as { all?: boolean }).all) {
            (callback as unknown as (error: null, addresses: LookupAddress[]) => void)(null, [selected]);
            return;
          }
          callback(null, selected.address, selected.family);
        },
      }, async (response) => {
        dispatchPossible = true;
        try {
          const status = response.statusCode ?? 0;
          if ([307, 308].includes(status)) {
            response.resume();
            const location = response.headers.location;
            if (!location) throw new GatewayNetworkPolicyError("Gateway redirect omitted its destination");
            const redirected = new URL(location, approvedUrl);
            if (redirected.origin !== approvedOrigin) {
              throw new GatewayNetworkPolicyError("Gateway cross-origin redirect was rejected");
            }
            finish(undefined, await this.post(redirected, input, redirects + 1, approvedOrigin, deadline));
            return;
          }
          if (status >= 300 && status < 400) {
            response.resume();
            throw new GatewayNetworkPolicyError("Gateway redirect status was rejected");
          }
          let raw: string;
          try {
            raw = await readResponseBody(response, response.headers["content-length"]);
          } catch (error) {
            if ((error as Error).message === "Gateway response exceeded the output limit") throw error;
            throw new GatewayTransportUnknownOutcomeError(
              "Gateway request outcome is unknown after response transport loss",
            );
          }
          if (status < 200 || status >= 300) throw new Error(`Gateway request failed (HTTP ${status})`);
          finish(undefined, raw);
        } catch (error) {
          finish(error as Error);
        }
      });
      outbound.once("socket", (socket) => {
        if (!socket.connecting) {
          dispatchPossible = true;
          return;
        }
        socket.once(approvedUrl.protocol === "https:" ? "secureConnect" : "connect", () => {
          dispatchPossible = true;
        });
      });
      outbound.once("error", (error: NodeJS.ErrnoException) => {
        const code = typeof error.code === "string" && /^[A-Z0-9_]{2,64}$/.test(error.code)
          ? ` (${error.code})`
          : "";
        finish(dispatchPossible
          ? new GatewayTransportUnknownOutcomeError(
            `Gateway request outcome is unknown after transport loss${code}`,
          )
          : new GatewayNetworkPolicyError(`Gateway request failed before dispatch${code}`));
      });
      const timer = setTimeout(() => {
        outbound.destroy();
        finish(dispatchPossible ? unknownTimeout() : preDispatchTimeout());
      }, Math.max(1, deadline - Date.now()));
      timer.unref?.();
      outbound.end(body);
    });
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Gateway returned an invalid response");
  }
  return value as Record<string, unknown>;
}

function parseResponse(payload: unknown, requestedModel: string): {
  text: string;
  requestId: string;
  model: string;
} {
  const value = object(payload);
  const rawRequestId = typeof value.id === "string" ? value.id.trim() : "";
  const requestId = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(rawRequestId) ? rawRequestId : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";
  if (!requestId || !model || value.status !== "completed") {
    throw new Error("Gateway returned incomplete Runtime Evidence");
  }
  if (model !== requestedModel) throw new Error("Gateway returned a different model identity");
  if (!Array.isArray(value.output)) throw new Error("Gateway returned an invalid response");
  const parts: string[] = [];
  for (const rawItem of value.output) {
    const item = object(rawItem);
    if (item.type === "reasoning") {
      if (typeof item.id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(item.id)) {
        throw new Error("Gateway returned an invalid reasoning item");
      }
      continue;
    }
    if (item.type !== "message") throw new Error("Gateway violated the tool-free response contract");
    if (!Array.isArray(item.content)) throw new Error("Gateway returned an invalid response");
    for (const rawPart of item.content) {
      const part = object(rawPart);
      if (part.type !== "output_text" || typeof part.text !== "string") {
        throw new Error("Gateway violated the tool-free response contract");
      }
      parts.push(part.text);
    }
  }
  const text = parts.join("\n").trim();
  if (!text || text.length > MAX_OUTPUT_CHARS || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
    throw new Error("Gateway returned invalid summary or conversation output");
  }
  return { text, requestId, model };
}

function validModel(value: string): string {
  const model = value.trim();
  if (!model || model.length > 128) throw new Error("Gateway model identity is invalid");
  return model;
}

export class CliProxyApiAdapter {
  private readonly endpoint: string;
  private readonly httpsApproved: boolean;
  private readonly secrets: GatewaySecretStore;
  private readonly transport: GatewayTransport;
  private readonly timeoutMs: number;

  constructor(options: {
    endpoint: string;
    httpsApproved: boolean;
    secrets: GatewaySecretStore;
    transport?: GatewayTransport;
    timeoutMs?: number;
  }) {
    this.endpoint = options.endpoint;
    this.httpsApproved = options.httpsApproved;
    this.secrets = options.secrets;
    this.transport = options.transport ?? new SecureGatewayTransport();
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  validateEndpoint(): Promise<GatewayEndpointIdentity> {
    return this.transport.validate(this.endpoint, this.httpsApproved);
  }

  async keyConfigured(): Promise<boolean> {
    try { return Boolean((await this.secrets.read())?.trim()); }
    catch { return false; }
  }

  async probe(input: { capability: "summary" | "conversation"; model: string }) {
    const model = validModel(input.model);
    try {
      const result = await this.invoke(model, [
        { role: "system", content: "Return one short acknowledgement. Do not use tools." },
        { role: "user", content: `Yulu Gateway ${input.capability} capability probe.` },
      ], 32);
      return { status: "ready" as const, evidence: result.evidence };
    } catch (error) {
      if (error instanceof GatewayRequestUnknownOutcomeError) {
        return {
          status: "failed" as const,
          reason: "unknown_outcome" as const,
          remediation: "The Gateway may still be processing this request. Do not retry it; verify Gateway state before a new attempt",
          evidence: error.evidence,
        };
      }
      return {
        status: "failed" as const,
        reason: /different model identity/i.test((error as Error).message)
          ? "invalid_model" as const
          : "readiness_failed" as const,
        remediation: "Verify the approved endpoint, least-privilege inference key, and exact model, then test again",
      };
    }
  }

  async summarize(input: { model: string; instructions: string; transcript: string }) {
    if (!input.instructions.trim() || !input.transcript.trim()) {
      throw new Error("Gateway Summary requires selected instructions and committed transcript text");
    }
    const result = await this.invoke(validModel(input.model), [
      { role: "system", content: input.instructions },
      { role: "user", content: input.transcript },
    ]);
    return { summary: result.text, evidence: result.evidence };
  }

  async converse(input: {
    model: string;
    input: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }) {
    if (input.input.length === 0 || input.input.some((message) => !message.content.trim())) {
      throw new Error("Gateway Conversation input is invalid");
    }
    const result = await this.invoke(validModel(input.model), input.input);
    return { answer: result.text, evidence: result.evidence };
  }

  private async invoke(
    model: string,
    input: Array<{ role: "system" | "user" | "assistant"; content: string }>,
    maxOutputTokens = 4_096,
  ): Promise<{ text: string; evidence: GatewayRuntimeEvidence }> {
    const key = (await this.secrets.read())?.trim() ?? "";
    if (!key) throw new Error("Gateway inference key is unavailable");
    const identity = endpointIdentity(this.endpoint);
    let payload: unknown;
    try {
      payload = await this.transport.responses({
        endpoint: identity.endpoint,
        httpsApproved: this.httpsApproved,
        key,
        body: {
          model,
          input,
          tools: [],
          tool_choice: "none",
          max_output_tokens: maxOutputTokens,
          store: false,
        },
        timeoutMs: this.timeoutMs,
      });
    } catch (error) {
      if (error instanceof GatewayNetworkPolicyError) throw error;
      if (error instanceof GatewayTransportUnknownOutcomeError) {
        const evidence: GatewayRuntimeEvidence = {
          adapter: "cliproxyapi",
          transport: `openai-responses-${identity.transport}`,
          runtimeVersion: CLIPROXYAPI_CONTRACT_VERSION,
          endpoint: identity.endpoint,
          requestedProvider: null,
          requestedModel: model,
          actualProvider: null,
          actualModel: null,
          requestId: null,
          sessionId: null,
          terminalStatus: "unknown",
          fallbackOccurred: false,
          toolsEnabled: false,
        };
        throw new GatewayRequestUnknownOutcomeError(
          "CLIProxyAPI Gateway request outcome is unknown; do not retry this execution",
          evidence,
        );
      }
      throw new Error("Gateway request failed");
    }
    const parsed = parseResponse(payload, model);
    return {
      text: parsed.text,
      evidence: {
        adapter: "cliproxyapi",
        transport: `openai-responses-${identity.transport}`,
        runtimeVersion: CLIPROXYAPI_CONTRACT_VERSION,
        endpoint: identity.endpoint,
        requestedProvider: null,
        requestedModel: model,
        actualProvider: null,
        actualModel: parsed.model,
        requestId: parsed.requestId,
        sessionId: null,
        terminalStatus: "ready",
        fallbackOccurred: false,
        toolsEnabled: false,
      },
    };
  }
}
