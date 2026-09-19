import { describe, expect, it, vi } from "vitest";
import { XaiTextClient, XaiTextUnknownOutcomeError } from "../src/xaiText.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("XaiTextClient.request", () => {
  const completed = (text: string, model = "grok-selected") => ({
    model, status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });
  const frame = (item: unknown) => `data: ${JSON.stringify(item)}\r\n\r\n`;
  const streamClient = (body: ReadableStream<Uint8Array>) => {
    const credentials = { resolve: vi.fn(async () => ({ accessToken: "test-token", source: "oauth" as const })) };
    const fetchFn = vi.fn<typeof fetch>(async () => new Response(body, {
      headers: { "content-type": "text/event-stream" },
    }));
    return { client: new XaiTextClient(credentials as never, fetchFn), fetchFn };
  };
  const streamingRequest = (onText: (text: string) => void) => ({
    capability: "conversation" as const, model: "grok-selected", credentialSource: "oauth" as const,
    input: [{ role: "user" as const, content: "Explain this" }], onText,
  });

  it("shows partial text before completion and keeps the request stateless", async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
    const { client, fetchFn } = streamClient(body);
    const onText = vi.fn();
    const pending = client.request(streamingRequest(onText));
    controller.enqueue(new TextEncoder().encode(
      frame({ type: "response.created", response: { model: "grok-selected" } }) +
      frame({ type: "response.output_text.delta", delta: "第一段" }),
    ));
    await vi.waitFor(() => expect(onText).toHaveBeenCalledWith("第一段"));
    controller.enqueue(new TextEncoder().encode(frame({
      type: "response.completed", response: completed("第一段，完整回答"),
    })));
    await expect(pending).resolves.toMatchObject({ text: "第一段，完整回答", model: "grok-selected" });
    expect(fetchFn).toHaveBeenCalledOnce();
    const init = fetchFn.mock.calls[0]![1]!;
    expect(init.headers).toMatchObject({ Accept: "text/event-stream" });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "grok-selected", input: [{ role: "user", content: "Explain this" }],
      max_output_tokens: 4096, store: false, stream: true,
    });
  });

  it("reassembles UTF-8 and CRLF SSE frames split at every byte", async () => {
    const raw = new TextEncoder().encode(
      ": keepalive\r\n\r\n" +
      frame({ type: "response.created", response: { model: "grok-selected" } }) +
      frame({ type: "response.output_text.delta", delta: "你好" }) +
      frame({ type: "response.output_text.delta", delta: " 🌏" }) +
      frame({ type: "response.completed", response: completed("你好 🌏") }),
    );
    let offset = 0;
    const { client } = streamClient(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset < raw.length) controller.enqueue(raw.slice(offset, ++offset));
        else controller.close();
      },
    }));
    const onText = vi.fn();
    await expect(client.request(streamingRequest(onText))).resolves.toMatchObject({ text: "你好 🌏" });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(["你好", "你好 🌏"]);
  });

  it("rejects a different model before exposing provisional text", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          frame({ type: "response.output_text.delta", delta: "unverified text" }) +
          frame({ type: "response.completed", response: completed("unverified text", "different-model") }),
        ));
        controller.close();
      },
    });
    const { client } = streamClient(body);
    const onText = vi.fn();
    await expect(client.request(streamingRequest(onText))).rejects.toThrow("does not match");
    expect(onText).not.toHaveBeenCalled();
  });

  it("treats a truncated stream as unknown without retrying or accepting partial text", async () => {
    const { client, fetchFn } = streamClient(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(
          frame({ type: "response.created", response: { model: "grok-selected" } }) +
          frame({ type: "response.output_text.delta", delta: "partial" }) + "data: [DONE]\n\n",
        ));
        controller.close();
      },
    }));
    const onText = vi.fn();
    await expect(client.request(streamingRequest(onText))).rejects.toBeInstanceOf(XaiTextUnknownOutcomeError);
    expect(onText).toHaveBeenCalledWith("partial");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("bounds streaming output and hides provider error bodies", async () => {
    for (const event of [
      { type: "response.output_text.delta", delta: "x".repeat(131_073) },
      { type: "error", message: "secret-token private transcript" },
    ]) {
      const { client } = streamClient(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(frame(event)));
          controller.close();
        },
      }));
      const onText = vi.fn();
      const result = client.request(streamingRequest(onText));
      await expect(result).rejects.toThrow(/output limit|incomplete/);
      await expect(result).rejects.not.toThrow(/secret-token|private transcript/);
      expect(onText).not.toHaveBeenCalled();
    }
  });

  it("does not send a late dictation request when credential resolution outlives the deadline", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    let release!: (value: { accessToken: string; source: "oauth" }) => void;
    const credentials = { resolve: vi.fn(() => new Promise<{ accessToken: string; source: "oauth" }>((resolve) => { release = resolve; })) };
    const fetchFn = vi.fn<typeof fetch>();
    try {
      const client = new XaiTextClient(credentials as never, fetchFn);
      const request = client.request({ capability: "dictation", model: "selected-model", timeoutMs: 500,
        input: [{ role: "user", content: "Current dictated text" }] });
      const rejected = expect(request).rejects.toThrow("deadline exceeded before request");
      controller.abort();
      await rejected;
      release({ accessToken: "test-token", source: "oauth" });
      await Promise.resolve();
      expect(fetchFn).not.toHaveBeenCalled();
      expect(timeout).toHaveBeenCalledWith(500);
    } finally { timeout.mockRestore(); }
  });

  it.each(["incomplete", "completed"])("accepts only completed dictation cleanup: %s", async (status) => {
    const credentials = { resolve: vi.fn(async () => ({ accessToken: "test-token", source: "oauth" as const })) };
    const fetchFn = vi.fn<typeof fetch>(async () => response({ status, model: "selected-model",
      output: [{ type: "message", content: [{ type: "output_text", text: "Cleaned text" }] }],
    }));
    const client = new XaiTextClient(credentials as never, fetchFn);
    const request = client.request({ capability: "dictation", model: "selected-model", timeoutMs: 500,
      input: [{ role: "user", content: "Current dictated text" }] });
    if (status === "completed") await expect(request).resolves.toMatchObject({ text: "Cleaned text" });
    else await expect(request).rejects.toThrow("cleanup was incomplete");
    expect(fetchFn).toHaveBeenCalledOnce();
  });

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

  it("classifies timeout or transport loss after request creation as Unknown Outcome", async () => {
    const credentials = {
      resolve: vi.fn(async () => ({ accessToken: "never-expose-token", source: "oauth" as const })),
    };
    const client = new XaiTextClient(credentials as never, vi.fn<typeof fetch>(async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }));

    const request = client.request({
      capability: "summary",
      model: "grok-4.6",
      credentialSource: "oauth",
      input: [{ role: "user", content: "private committed transcript" }],
    });
    await expect(request).rejects.toBeInstanceOf(XaiTextUnknownOutcomeError);
    await expect(request).rejects.toMatchObject({
      capability: "summary",
      model: "grok-4.6",
      credentialSource: "oauth",
    });
    await expect(request).rejects.not.toThrow(/never-expose-token|private committed transcript/);
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
