import { describe, expect, it, vi } from "vitest";
import { XaiTextClient, XaiTextUnknownOutcomeError } from "../src/xaiText.js";

function response(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("XaiTextClient.request", () => {
  it("aborts superseded dictation requests at the transport boundary without retrying", async () => {
    const controller = new AbortController();
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
    }));
    const client = new XaiTextClient({ resolve: async () => ({ accessToken: "test", source: "oauth" }) } as never, fetchFn);
    const request = client.request({ capability: "dictation", model: "selected", signal: controller.signal,
      input: [{ role: "user", content: "An obsolete preview" }] });
    const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    expect(fetchFn.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("reports dictation timeouts distinctly while preserving Unknown Outcome for other capabilities", async () => {
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    try {
      const fetchFn = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason), { once: true });
      }));
      const client = new XaiTextClient({ resolve: async () => ({ accessToken: "test", source: "oauth" }) } as never, fetchFn);
      const request = client.request({ capability: "dictation", model: "selected",
        input: [{ role: "user", content: "Dictated text" }] });
      const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.waitFor(() => expect(fetchFn).toHaveBeenCalledOnce());
      controller.abort(new DOMException("Deadline", "TimeoutError"));
      await rejected;
    } finally { timeout.mockRestore(); }
  });
  const completed = (text: string, model = "grok-selected") => ({
    model, status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
  });

  it.each([
    ["dictation", "grok-4.6", true], ["dictation", "grok-4.5", true],
    ["dictation", "other-model", false], ["summary", "grok-4.6", false],
  ] as const)("uses low reasoning only for supported dictation models: %s %s", async (capability, model, low) => {
    const fetchFn = vi.fn<typeof fetch>(async () => response(completed("明天见", model)));
    const client = new XaiTextClient({ resolve: async () => ({ accessToken: "test", source: "oauth" }) } as never, fetchFn);
    await client.request({ capability, model, timeoutMs: 20_000, input: [{ role: "user", content: "嗯，明天见。" }] });
    const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body));
    expect(body.reasoning).toEqual(low ? { effort: "low" } : undefined);
    expect(body.store).toBe(false);
    expect(body.tools).toBeUndefined();
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
      const rejected = expect(request).rejects.toMatchObject({ name: "AbortError" });
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

  it("allows full recording summaries longer than the short dictation request window", async () => {
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
        capability: "dictation",
        model: "grok-4.6",
        input: [{ role: "user", content: "A short dictated phrase" }],
      }).catch(() => undefined);
      await expect(client.request({
        capability: "dictation",
        model: "grok-4.6",
        timeoutMs: 20_001,
        input: [{ role: "user", content: "A short dictated phrase" }],
      })).rejects.toThrow("xAI text timeout is invalid");
      await expect(client.request({
        capability: "summary",
        model: "grok-4.6",
        timeoutMs: 180_001,
        input: [{ role: "user", content: "A committed recording transcript" }],
      })).rejects.toThrow("xAI text timeout is invalid");

      expect(timeout).toHaveBeenCalledTimes(2);
      expect(timeout).toHaveBeenNthCalledWith(1, 180_000);
      expect(timeout).toHaveBeenNthCalledWith(2, 20_000);
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
      capability: "summary",
      model: "grok-4.6",
      credentialSource: "oauth",
      input: [{ role: "user", content: "probe" }],
    })).rejects.toThrow(/credential.*oauth.*api-key/i);
    expect(fetchFn).not.toHaveBeenCalled();

    credentialSource = "oauth";
    await expect(client.request({
      capability: "summary",
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
      capability: "summary",
      model: "grok-4.6",
      input: [{ role: "user", content: "Transcript: private meeting" }],
      maxOutputTokens: 64,
    });
    await expect(request).rejects.toThrow("xAI summary request failed (HTTP 403)");
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
