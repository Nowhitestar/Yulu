import { describe, expect, it, vi } from "vitest";
import { XaiTextClient } from "../src/xaiText.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("XaiTextClient.request", () => {
  it("sends one exact stateless request to the fixed xAI Responses endpoint", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "oauth-secret", source: "oauth" as const })),
    };
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Probe ready" }],
      }],
    }));
    const client = new XaiTextClient(credentials as never, fetchFn);
    const input = [
      { role: "system" as const, content: "Summarize only the supplied transcript." },
      { role: "user" as const, content: "Transcript: probe" },
    ];

    await expect(client.request({
      capability: "summary",
      model: "grok-4.6",
      input,
      maxOutputTokens: 64,
    })).resolves.toEqual({
      text: "Probe ready",
      model: "grok-4.6",
      credentialSource: "oauth",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.x.ai/v1/responses");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: "Bearer oauth-secret",
        "Content-Type": "application/json",
      },
    });
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model: "grok-4.6",
      input,
      max_output_tokens: 64,
      store: false,
    });
    for (const forbidden of [
      "tools", "previous_response_id", "files", "collections", "search", "connectors",
    ]) {
      expect(body).not.toHaveProperty(forbidden);
    }
  });

  it("bounds input and output and never includes provider bodies or secrets in errors", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "never-expose-token", source: "api-key" as const })),
    };
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      error: "never-expose-token Transcript: private meeting",
    }, 403));
    const client = new XaiTextClient(credentials as never, fetchFn);

    const request = client.request({
      capability: "conversation",
      model: "grok-4.6",
      input: [{ role: "user", content: "Transcript: private meeting" }],
      maxOutputTokens: 64,
    });
    await expect(request).rejects.toThrow("xAI conversation request failed (HTTP 403)");
    await expect(request).rejects.not.toThrow(/never-expose-token|private meeting/);

    await expect(client.request({
      capability: "summary",
      model: "grok-4.6",
      input: [{ role: "user", content: "x".repeat(1_000_001) }],
    })).rejects.toThrow("xAI text input exceeds");
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
