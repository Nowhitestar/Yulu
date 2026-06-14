import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  notionMcpCredentialStatus,
  notionMcpPendingPath,
  notionMcpTokenPath,
  startNotionMcpOAuth,
} from "../src/notionMcpOAuth.js";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("notionMcpOAuth", () => {
  it("starts OAuth by discovering Notion metadata, registering a client, and persisting pending PKCE state", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notion_mcp_"));
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      if (String(url).endsWith("/.well-known/oauth-protected-resource")) {
        return jsonResponse({ authorization_servers: ["https://auth.notion.test"] });
      }
      if (String(url).endsWith("/.well-known/oauth-authorization-server")) {
        return jsonResponse({
          authorization_endpoint: "https://auth.notion.test/authorize",
          token_endpoint: "https://auth.notion.test/token",
          registration_endpoint: "https://auth.notion.test/register",
        });
      }
      if (String(url) === "https://auth.notion.test/register") {
        return jsonResponse({ client_id: "client-123" });
      }
      throw new Error(`unexpected ${String(url)}`);
    };

    const result = await startNotionMcpOAuth({
      configDir: dir,
      redirectUri: "http://127.0.0.1:7788/integrations/notion/callback",
      fetchImpl,
      randomBytes: () => Buffer.alloc(32, 1),
      nowMs: 1_000,
    });

    const authUrl = new URL(result.authUrl);
    expect(authUrl.origin + authUrl.pathname).toBe("https://auth.notion.test/authorize");
    expect(authUrl.searchParams.get("client_id")).toBe("client-123");
    expect(authUrl.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:7788/integrations/notion/callback");
    expect(authUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authUrl.searchParams.get("prompt")).toBe("consent");
    expect(result.expiresAt).toBe(601_000);
    expect(statSync(notionMcpPendingPath(dir)).mode & 0o777).toBe(0o600);
    const pending = JSON.parse(readFileSync(notionMcpPendingPath(dir), "utf8"));
    expect(pending.state).toBe(authUrl.searchParams.get("state"));
    expect(pending.clientId).toBe("client-123");
    expect(seen.map((item) => item.url)).toEqual([
      "https://mcp.notion.com/.well-known/oauth-protected-resource",
      "https://auth.notion.test/.well-known/oauth-authorization-server",
      "https://auth.notion.test/register",
    ]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("exchanges a callback code for tokens and stores them without exposing token values in status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "notion_mcp_"));
    await startNotionMcpOAuth({
      configDir: dir,
      redirectUri: "http://127.0.0.1:7788/integrations/notion/callback",
      fetchImpl: async (url: string | URL | Request) => {
        if (String(url).endsWith("/.well-known/oauth-protected-resource")) {
          return jsonResponse({ authorization_servers: ["https://auth.notion.test"] });
        }
        if (String(url).endsWith("/.well-known/oauth-authorization-server")) {
          return jsonResponse({
            authorization_endpoint: "https://auth.notion.test/authorize",
            token_endpoint: "https://auth.notion.test/token",
            registration_endpoint: "https://auth.notion.test/register",
          });
        }
        return jsonResponse({ client_id: "client-123", client_secret: "client-secret" });
      },
      randomBytes: () => Buffer.alloc(32, 2),
      nowMs: 10_000,
    });
    const pending = JSON.parse(readFileSync(notionMcpPendingPath(dir), "utf8"));
    const postedBodies: string[] = [];
    const tokens = await exchangeCodeForTokens({
      configDir: dir,
      callbackUrl: `http://127.0.0.1:7788/integrations/notion/callback?code=abc&state=${pending.state}`,
      fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
        postedBodies.push(String(init?.body ?? ""));
        return jsonResponse({
          access_token: "access-secret",
          refresh_token: "refresh-secret",
          token_type: "Bearer",
          expires_in: 3600,
        });
      },
      nowMs: 20_000,
    });

    expect(tokens.connected).toBe(true);
    expect(postedBodies[0]).toContain("grant_type=authorization_code");
    expect(postedBodies[0]).toContain("code_verifier=");
    expect(statSync(notionMcpTokenPath(dir)).mode & 0o777).toBe(0o600);
    expect(readFileSync(notionMcpTokenPath(dir), "utf8")).toContain("access-secret");
    expect(notionMcpCredentialStatus(dir)).toEqual({
      connected: true,
      detail: "Notion MCP OAuth token stored",
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it("buildAuthorizationUrl includes PKCE and CSRF state parameters", () => {
    const url = new URL(buildAuthorizationUrl({
      authorizationEndpoint: "https://auth.example/authorize",
      clientId: "client",
      redirectUri: "http://127.0.0.1/callback",
      codeChallenge: "challenge",
      state: "state",
    }));

    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe("state");
  });
});
