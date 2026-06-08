import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTrpcClient } from "../../web/src/trpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
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
});
