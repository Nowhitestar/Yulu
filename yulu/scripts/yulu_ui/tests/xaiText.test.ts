import { describe, expect, it, vi } from "vitest";
import { XaiTextClient } from "../src/xaiText.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("XaiTextClient.request", () => {
  it("allows full recording summaries longer than the short interactive request window", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout")
      .mockImplementation(() => new AbortController().signal);
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "oauth-secret", source: "oauth" as const })),
    };
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "grok-4.6",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Ready" }],
      }],
    }));
    const client = new XaiTextClient(credentials as never, fetchFn);

    try {
      await client.request({
        capability: "summary",
        model: "grok-4.6",
        input: [{ role: "user", content: "A committed recording transcript" }],
      });
      await client.request({
        capability: "conversation",
        model: "grok-4.6",
        input: [{ role: "user", content: "A short interactive prompt" }],
      });

      expect(timeout).toHaveBeenNthCalledWith(1, 180_000);
      expect(timeout).toHaveBeenNthCalledWith(2, 30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it("sends one exact stateless request to the fixed xAI Responses endpoint", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "oauth-secret", source: "oauth" as const })),
    };
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "grok-4.6",
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

  it("rejects credential or response model identity changes before accepting output", async () => {
    let credentialSource: "oauth" | "api-key" = "api-key";
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "credential-secret", source: credentialSource })),
    };
    const fetchFn = vi.fn<typeof fetch>(async () => response({
      model: "grok-other",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "Wrong model" }],
      }],
    }));
    const client = new XaiTextClient(credentials as never, fetchFn);

    await expect(client.request({
      capability: "conversation",
      model: "grok-4.6",
      credentialSource: "oauth",
      input: [{ role: "user", content: "probe" }],
    })).rejects.toThrow(/credential.*oauth.*api-key/i);
    expect(fetchFn).not.toHaveBeenCalled();

    credentialSource = "oauth";
    await expect(client.request({
      capability: "conversation",
      model: "grok-4.6",
      credentialSource: "oauth",
      input: [{ role: "user", content: "probe" }],
    })).rejects.toThrow(/model.*grok-4.6.*grok-other/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
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

  it("cancels a chunked response as soon as it exceeds the output byte limit", async () => {
    let cancelled = false;
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        emitted += 1;
        controller.enqueue(new Uint8Array(256_000));
        if (emitted === 8) controller.close();
      },
      cancel() { cancelled = true; },
    });
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "oauth-secret", source: "oauth" as const })),
    };
    const client = new XaiTextClient(credentials as never, vi.fn<typeof fetch>(async () =>
      new Response(body, { status: 200, headers: { "content-type": "application/json" } })));

    await expect(client.request({
      capability: "summary",
      model: "grok-4.6",
      input: [{ role: "user", content: "probe" }],
    })).rejects.toThrow("xAI text response exceeded the output limit");
    expect(cancelled).toBe(true);
    expect(emitted).toBeLessThan(8);
  });
});
