import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";

export const NOTION_MCP_RESOURCE_URL = "https://mcp.notion.com/mcp";
const PENDING_FILE = "notion-mcp-oauth-state.json";
const TOKEN_FILE = "notion-mcp-token.json";
const PENDING_TTL_MS = 10 * 60 * 1000;

type FetchLike = typeof fetch;

interface OAuthMetadata {
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface ClientCredentials {
  client_id: string;
  client_secret?: string;
}

interface PendingOAuthState {
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  tokenEndpoint: string;
  authorizationEndpoint: string;
  createdAt: number;
  expiresAt: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

export function notionMcpPendingPath(configDir: string): string {
  return join(configDir, PENDING_FILE);
}

export function notionMcpTokenPath(configDir: string): string {
  return join(configDir, TOKEN_FILE);
}

export function notionMcpProtectedResourceMetadataUrl(resourceUrl = NOTION_MCP_RESOURCE_URL): string {
  return new URL("/.well-known/oauth-protected-resource", resourceUrl).toString();
}

function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

function base64Url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256Base64Url(input: string): string {
  return base64Url(createHash("sha256").update(input).digest());
}

function tokenFromRandom(bytes: Buffer): string {
  return base64Url(bytes);
}

async function fetchJson<T>(fetchImpl: FetchLike, url: string, init?: RequestInit): Promise<T> {
  const response = await fetchImpl(url, init);
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return await response.json() as T;
}

async function discoverOAuthMetadata(fetchImpl: FetchLike): Promise<OAuthMetadata> {
  const protectedResource = await fetchJson<{ authorization_servers?: string[] }>(
    fetchImpl,
    notionMcpProtectedResourceMetadataUrl(),
    { headers: { Accept: "application/json" } },
  );
  const authServer = protectedResource.authorization_servers?.[0];
  if (!authServer) throw new Error("Notion MCP did not advertise an authorization server");
  return fetchJson<OAuthMetadata>(
    fetchImpl,
    `${authServer.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    { headers: { Accept: "application/json" } },
  );
}

async function registerClient(
  fetchImpl: FetchLike,
  metadata: OAuthMetadata,
  redirectUri: string,
): Promise<ClientCredentials> {
  if (!metadata.registration_endpoint) {
    throw new Error("Notion OAuth metadata did not include a registration endpoint");
  }
  const payload = {
    client_name: "Yulu Notion MCP",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
  const credentials = await fetchJson<ClientCredentials>(
    fetchImpl,
    metadata.registration_endpoint,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload),
    },
  );
  if (!credentials.client_id) throw new Error("Notion client registration did not return client_id");
  return credentials;
}

export function buildAuthorizationUrl(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  scopes?: string[];
}): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: (input.scopes ?? []).join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    prompt: "consent",
  });
  return `${input.authorizationEndpoint}?${params.toString()}`;
}

export async function startNotionMcpOAuth(input: {
  configDir: string;
  redirectUri: string;
  fetchImpl?: FetchLike;
  randomBytes?: () => Buffer;
  nowMs?: number;
}): Promise<{ authUrl: string; state: string; expiresAt: number; redirectUri: string }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const entropy = input.randomBytes ?? (() => nodeRandomBytes(32));
  const metadata = await discoverOAuthMetadata(fetchImpl);
  const credentials = await registerClient(fetchImpl, metadata, input.redirectUri);
  const codeVerifier = tokenFromRandom(entropy());
  const state = tokenFromRandom(entropy());
  const expiresAt = nowMs + PENDING_TTL_MS;
  const pending: PendingOAuthState = {
    state,
    codeVerifier,
    clientId: credentials.client_id,
    clientSecret: credentials.client_secret,
    redirectUri: input.redirectUri,
    tokenEndpoint: metadata.token_endpoint,
    authorizationEndpoint: metadata.authorization_endpoint,
    createdAt: nowMs,
    expiresAt,
  };
  writePrivateJson(notionMcpPendingPath(input.configDir), pending);
  return {
    authUrl: buildAuthorizationUrl({
      authorizationEndpoint: metadata.authorization_endpoint,
      clientId: credentials.client_id,
      redirectUri: input.redirectUri,
      codeChallenge: sha256Base64Url(codeVerifier),
      state,
    }),
    state,
    expiresAt,
    redirectUri: input.redirectUri,
  };
}

function readPending(configDir: string, nowMs: number): PendingOAuthState {
  const raw = JSON.parse(readFileSync(notionMcpPendingPath(configDir), "utf8")) as PendingOAuthState;
  if (raw.expiresAt < nowMs) throw new Error("Notion MCP OAuth state expired");
  return raw;
}

export async function exchangeCodeForTokens(input: {
  configDir: string;
  callbackUrl: string;
  fetchImpl?: FetchLike;
  nowMs?: number;
}): Promise<{ connected: true; expiresAt?: number }> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const nowMs = input.nowMs ?? Date.now();
  const pending = readPending(input.configDir, nowMs);
  const callback = new URL(input.callbackUrl);
  const error = callback.searchParams.get("error");
  if (error) {
    const detail = callback.searchParams.get("error_description") || "Unknown error";
    throw new Error(`Notion OAuth error: ${error} - ${detail}`);
  }
  if (callback.searchParams.get("state") !== pending.state) {
    throw new Error("Invalid Notion OAuth state");
  }
  const code = callback.searchParams.get("code");
  if (!code) throw new Error("Notion OAuth callback is missing code");
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: pending.clientId,
    redirect_uri: pending.redirectUri,
    code_verifier: pending.codeVerifier,
  });
  if (pending.clientSecret) body.set("client_secret", pending.clientSecret);

  const tokens = await fetchJson<TokenResponse>(
    fetchImpl,
    pending.tokenEndpoint,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
        "User-Agent": "Yulu-Notion-MCP/1.0",
      },
      body: body.toString(),
    },
  );
  if (!tokens.access_token) throw new Error("Notion token response did not include access_token");
  const expiresAt = tokens.expires_in ? nowMs + tokens.expires_in * 1000 : undefined;
  writePrivateJson(notionMcpTokenPath(input.configDir), {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    token_type: tokens.token_type,
    scope: tokens.scope,
    expires_at: expiresAt,
    client_id: pending.clientId,
    client_secret: pending.clientSecret,
    token_endpoint: pending.tokenEndpoint,
    authorization_endpoint: pending.authorizationEndpoint,
  });
  return { connected: true, expiresAt };
}

export function notionMcpCredentialStatus(configDir: string): { connected: boolean; detail: string } {
  const tokenPath = notionMcpTokenPath(configDir);
  if (!existsSync(tokenPath)) return { connected: false, detail: "Notion MCP OAuth token not found" };
  try {
    const raw = JSON.parse(readFileSync(tokenPath, "utf8")) as { access_token?: string };
    if (!raw.access_token) return { connected: false, detail: "Notion MCP token file is incomplete" };
    return { connected: true, detail: "Notion MCP OAuth token stored" };
  } catch (exc) {
    return { connected: false, detail: `Notion MCP token file unreadable: ${(exc as Error).message}` };
  }
}
