import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTrpcClient } from "../../web/src/trpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("makeTrpcClient", () => {
  it("does not batch unrelated startup queries behind a slow capability probe", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      const data = url.includes("capabilities.host_capabilities")
        ? { schema_version: 1, capabilities: {} }
        : {};
      return new Response(JSON.stringify({ result: { data } }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const client = makeTrpcClient("http://127.0.0.1:7789");
    await Promise.allSettled([
      client.config.get.query(),
      client.capabilities.host_capabilities.query(),
    ]);

    expect(urls.length).toBeGreaterThanOrEqual(2);
    expect(urls.some((url) => url.includes("config.get,capabilities.host_capabilities"))).toBe(false);
  });

  it("fetches the process-local bearer before an activation mutation", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      requests.push({ url, authorization: headers.get("authorization") });
      if (url.endsWith("/api/ui-token")) {
        return new Response(JSON.stringify({ token: "process-local-ui-token" }), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ result: { data: { journey: { shouldAutoEnter: false } } } }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const client = makeTrpcClient("http://127.0.0.1:7789");
    await client.activation.defer.mutate();

    expect(requests).toEqual([
      { url: "http://127.0.0.1:7789/api/ui-token", authorization: null },
      expect.objectContaining({
        url: expect.stringContaining("/trpc/activation.defer"),
        authorization: "Bearer process-local-ui-token",
      }),
    ]);
  });

  it("refreshes the process-local bearer for a later mutation after a Host restart", async () => {
    let token = "before-restart";
    const authorizations: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/api/ui-token")) {
        return new Response(JSON.stringify({ token }), { headers: { "content-type": "application/json" } });
      }
      authorizations.push(new Headers(init?.headers).get("authorization"));
      return new Response(JSON.stringify({ result: { data: { journey: { shouldAutoEnter: false } } } }), {
        headers: { "content-type": "application/json" },
      });
    }));

    const client = makeTrpcClient("http://127.0.0.1:7789");
    await client.activation.defer.mutate();
    token = "after-restart";
    await client.activation.defer.mutate();

    expect(authorizations).toEqual(["Bearer before-restart", "Bearer after-restart"]);
  });

  it("aborts activation status after the finite transport deadline", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetch);

    const request = makeTrpcClient("http://127.0.0.1:7789").activation.status.query();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    deadline.abort(new DOMException("Activation status timed out", "TimeoutError"));

    await expect(request).rejects.toBeDefined();
    expect(timeout).toHaveBeenCalledWith(10_000);
  });
});
