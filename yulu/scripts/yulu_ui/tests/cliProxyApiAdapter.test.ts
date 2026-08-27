import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CliProxyApiAdapter,
  CLIPROXYAPI_CONTRACT_VERSION,
  GatewayNetworkPolicyError,
  GatewayRequestUnknownOutcomeError,
  SecureGatewayTransport,
  isExactGatewayRuntimeEvidence,
  validateGatewayEndpoint,
  type GatewaySecretStore,
  type GatewayTransport,
} from "../src/cliProxyApiAdapter.js";

const INFERENCE_KEY = "gateway-inference-key-never-project";

function secretStore(value = INFERENCE_KEY): GatewaySecretStore {
  return {
    read: vi.fn(async () => value),
    write: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
  };
}

function responsePayload(model = "exact-model", id = "resp_gateway_1") {
  return {
    id,
    model,
    status: "completed",
    output: [{
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "Gateway answer" }],
    }],
  };
}

describe("CLIProxyAPI v0.23.0-rc.1 adapter conformance", () => {
  it("validates every exact Gateway Runtime Evidence field and rejects non-HTTP endpoints", () => {
    const evidence = {
      adapter: "cliproxyapi",
      transport: "openai-responses-loopback-http",
      runtimeVersion: CLIPROXYAPI_CONTRACT_VERSION,
      endpoint: "http://127.0.0.1:8317/v1",
      requestedProvider: null,
      requestedModel: "exact-model",
      actualProvider: null,
      actualModel: "exact-model",
      requestId: "gateway-request-137",
      sessionId: null,
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
      toolsEnabled: false as const,
    };
    const expected = { endpoint: evidence.endpoint, model: "exact-model", terminalStatus: "ready" as const };
    expect(isExactGatewayRuntimeEvidence(evidence, expected)).toBe(true);
    for (const mismatch of [
      { transport: "openai-responses-approved-https" },
      { runtimeVersion: "cliproxyapi-wrong-contract" },
      { endpoint: "http://127.0.0.1:9417/v1" },
      { requestedProvider: "openai" },
      { requestedModel: "other-model" },
      { actualProvider: "openai" },
      { actualModel: "other-model" },
      { requestId: null },
      { requestId: "x".repeat(201) },
      { sessionId: "upstream-session" },
      { terminalStatus: "unknown" },
      { fallbackOccurred: true },
      { toolsEnabled: true },
    ]) {
      expect(isExactGatewayRuntimeEvidence({ ...evidence, ...mismatch } as never, expected)).toBe(false);
    }
    expect(isExactGatewayRuntimeEvidence({
      ...evidence,
      endpoint: "ftp://gateway.example/v1",
    }, {
      endpoint: "ftp://gateway.example/v1",
      model: "exact-model",
      terminalStatus: "ready",
    })).toBe(false);
  });

  it("uses the same exact-model tool-free Responses request for probes and production", async () => {
    const requests: Array<{ body: Record<string, unknown>; key: string }> = [];
    const transport: GatewayTransport = {
      validate: vi.fn(async () => ({
        endpoint: "http://127.0.0.1:8317/v1",
        transport: "loopback-http" as const,
      })),
      responses: vi.fn(async (request) => {
        requests.push({ body: request.body, key: request.key });
        return responsePayload();
      }),
    };
    const adapter = new CliProxyApiAdapter({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport,
    });

    const probe = await adapter.probe({ capability: "summary", model: "exact-model" });
    const summary = await adapter.summarize({
      model: "exact-model",
      instructions: "Selected instructions only",
      transcript: "Host-read committed transcript only",
    });
    const conversation = await adapter.converse({
      model: "exact-model",
      input: [{ role: "user", content: "Pinned conversation question" }],
    });

    expect(probe.status).toBe("ready");
    expect(summary.summary).toBe("Gateway answer");
    expect(conversation.answer).toBe("Gateway answer");
    expect(requests).toHaveLength(3);
    for (const request of requests) {
      expect(request.key === INFERENCE_KEY).toBe(true);
      expect(request.body).toMatchObject({
        model: "exact-model",
        tools: [],
        tool_choice: "none",
        store: false,
      });
      expect(request.body).not.toHaveProperty("fallback");
      expect(request.body).not.toHaveProperty("provider");
    }
    expect(requests[1]!.body.input).toEqual([
      { role: "system", content: "Selected instructions only" },
      { role: "user", content: "Host-read committed transcript only" },
    ]);
    expect(summary.evidence).toEqual(expect.objectContaining({
      adapter: "cliproxyapi",
      transport: "openai-responses-loopback-http",
      endpoint: "http://127.0.0.1:8317/v1",
      requestedProvider: null,
      actualProvider: null,
      requestedModel: "exact-model",
      actualModel: "exact-model",
      requestId: "resp_gateway_1",
      terminalStatus: "ready",
      fallbackOccurred: false,
      toolsEnabled: false,
    }));
    expect(JSON.stringify(summary).includes(INFERENCE_KEY)).toBe(false);
  });

  it("rejects unbounded or non-opaque upstream request ids before Runtime Evidence persistence", async () => {
    const transport: GatewayTransport = {
      validate: vi.fn(async () => ({
        endpoint: "http://127.0.0.1:8317/v1",
        transport: "loopback-http" as const,
      })),
      responses: vi.fn(async () => responsePayload("exact-model", `${INFERENCE_KEY} reflected text`)),
    };
    const adapter = new CliProxyApiAdapter({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport,
    });

    const probe = await adapter.probe({ capability: "summary", model: "exact-model" });
    expect(probe.status).toBe("failed");
    expect(JSON.stringify(probe).includes(INFERENCE_KEY)).toBe(false);
    await expect(adapter.summarize({ model: "exact-model", instructions: "i", transcript: "t" }))
      .rejects.toThrow(/Runtime Evidence/i);
  });

  it("accepts a known reasoning output item while keeping runtime tools disabled", async () => {
    const transport: GatewayTransport = {
      validate: vi.fn(async () => ({
        endpoint: "http://127.0.0.1:8317/v1",
        transport: "loopback-http" as const,
      })),
      responses: vi.fn(async () => ({
        ...responsePayload(),
        output: [
          { type: "reasoning", id: "rs_137", summary: [] },
          ...responsePayload().output,
        ],
      })),
    };
    const adapter = new CliProxyApiAdapter({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport,
    });

    await expect(adapter.summarize({ model: "exact-model", instructions: "i", transcript: "t" }))
      .resolves.toMatchObject({
        summary: "Gateway answer",
        evidence: { toolsEnabled: false, fallbackOccurred: false },
      });
  });

  it("fails closed on model substitution, tool output, and secret-bearing transport errors", async () => {
    const payloads = [
      responsePayload("fallback-model"),
      {
        ...responsePayload(),
        output: [{ type: "function_call", name: "dangerous_tool", arguments: "{}" }],
      },
    ];
    const transport: GatewayTransport = {
      validate: vi.fn(async () => ({ endpoint: "http://127.0.0.1:8317/v1", transport: "loopback-http" as const })),
      responses: vi.fn(async () => payloads.shift()!),
    };
    const adapter = new CliProxyApiAdapter({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport,
    });

    await expect(adapter.probe({ capability: "summary", model: "exact-model" }))
      .resolves.toMatchObject({ status: "failed", reason: "invalid_model" });
    await expect(adapter.summarize({ model: "exact-model", instructions: "i", transcript: "t" }))
      .rejects.toThrow(/tool-free/i);

    const unsafeTransport: GatewayTransport = {
      validate: transport.validate,
      responses: vi.fn(async () => { throw new Error(`failed ${INFERENCE_KEY}`); }),
    };
    const unsafe = new CliProxyApiAdapter({
      endpoint: "http://127.0.0.1:8317/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport: unsafeTransport,
    });
    await expect(unsafe.probe({ capability: "conversation", model: "exact-model" }))
      .resolves.toMatchObject({ status: "failed" });
    expect(JSON.stringify(await unsafe.probe({ capability: "conversation", model: "exact-model" }))
      .includes(INFERENCE_KEY)).toBe(false);
  });
});

describe("Gateway endpoint and network policy", () => {
  it.each([
    "ftp://example.com/v1",
    "https://user:pass@example.com/v1",
    "https://example.com/v1?target=internal",
    "https://example.com/v1#fragment",
  ])("rejects an unsafe endpoint shape: %s", async (endpoint) => {
    await expect(validateGatewayEndpoint(endpoint, true, async () => [{ address: "93.184.216.34", family: 4 }]))
      .rejects.toBeInstanceOf(GatewayNetworkPolicyError);
  });

  it("allows HTTP only when every resolved address is loopback", async () => {
    await expect(validateGatewayEndpoint(
      "http://localhost:8317/v1/",
      false,
      async () => [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ],
    )).resolves.toEqual({ endpoint: "http://localhost:8317/v1", transport: "loopback-http" });

    await expect(validateGatewayEndpoint(
      "http://gateway.example/v1",
      false,
      async () => [{ address: "93.184.216.34", family: 4 }],
    )).rejects.toThrow(/loopback/i);
  });

  it.each([
    "10.0.0.1",
    "100.64.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "192.168.1.1",
    "224.0.0.1",
    "::",
    "::ffff:7f00:1",
    "64:ff9b::a9fe:a9fe",
    "100::1",
    "2001::1",
    "2001:db8::1",
    "2002:7f00:1::",
    "3fff::1",
    "fc00::1",
    "fe80::1",
  ])("rejects unsafe HTTPS destinations after DNS resolution: %s", async (address) => {
    await expect(validateGatewayEndpoint(
      "https://gateway.example/v1",
      true,
      async () => [{ address, family: address.includes(":") ? 6 : 4 }],
    )).rejects.toThrow(/unsafe/i);
  });

  it("canonicalizes bracketed IPv6 literals before the fixed DNS lookup", async () => {
    const lookup = vi.fn(async (hostname: string) => {
      expect(hostname).toBe("::1");
      return [{ address: "::1", family: 6 }];
    });
    await expect(validateGatewayEndpoint("http://[::1]:8317/v1/", false, lookup))
      .resolves.toEqual({ endpoint: "http://[::1]:8317/v1", transport: "loopback-http" });
    expect(lookup).toHaveBeenCalledWith("::1");
  });

  it("requires explicit HTTPS approval and accepts only public resolutions", async () => {
    const resolve = async () => [{ address: "93.184.216.34", family: 4 as const }];
    await expect(validateGatewayEndpoint("https://gateway.example/v1", false, resolve))
      .rejects.toThrow(/approved/i);
    await expect(validateGatewayEndpoint("https://gateway.example/v1/", true, resolve))
      .resolves.toEqual({ endpoint: "https://gateway.example/v1", transport: "approved-https" });
  });
});

describe("secure Gateway HTTP transport", () => {
  let server: Server | null = null;

  afterEach(async () => {
    if (!server) return;
    server.close();
    await once(server, "close");
    server = null;
  });

  it("revalidates DNS for the request and each same-origin redirect without leaking the key", async () => {
    const seen: Array<{ url: string; authorized: boolean }> = [];
    server = createServer((request, response) => {
      seen.push({
        url: request.url ?? "",
        authorized: request.headers.authorization === `Bearer ${INFERENCE_KEY}`,
      });
      if (request.url === "/v1/responses") {
        response.statusCode = 307;
        response.setHeader("location", "/v1/responses-final");
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(responsePayload()));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake Gateway did not listen");
    const lookup = vi.fn(async () => [{ address: "127.0.0.1", family: 4 as const }]);
    const transport = new SecureGatewayTransport({ lookup });

    const payload = await transport.responses({
      endpoint: `http://localhost:${address.port}/v1`,
      httpsApproved: false,
      key: INFERENCE_KEY,
      body: { model: "exact-model", input: [], tools: [], tool_choice: "none", store: false },
      timeoutMs: 2_000,
    });

    expect(payload).toMatchObject({ id: "resp_gateway_1" });
    expect(lookup.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(seen).toEqual([
      { url: "/v1/responses", authorized: true },
      { url: "/v1/responses-final", authorized: true },
    ]);
  });

  it("rejects DNS rebinding between policy validation and the pinned socket lookup", async () => {
    const lookup = vi.fn()
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "93.184.216.34", family: 4 }])
      .mockResolvedValueOnce([{ address: "169.254.169.254", family: 4 }]);
    const transport = new SecureGatewayTransport({ lookup });

    await expect(transport.responses({
      endpoint: "https://gateway.example:9/v1",
      httpsApproved: true,
      key: INFERENCE_KEY,
      body: { model: "exact-model", input: [], tools: [], tool_choice: "none", store: false },
      timeoutMs: 50,
    })).rejects.toBeInstanceOf(GatewayNetworkPolicyError);
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("reports an evidence-safe Unknown Outcome when the Gateway may continue after timeout", async () => {
    server = createServer((_request, _response) => {
      // Intentionally leave the response open so the client cannot prove a terminal outcome.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake Gateway did not listen");
    const adapter = new CliProxyApiAdapter({
      endpoint: `http://localhost:${address.port}/v1`,
      httpsApproved: false,
      secrets: secretStore(),
      transport: new SecureGatewayTransport({
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
      timeoutMs: 25,
    });

    let thrown: unknown;
    try {
      await adapter.summarize({
        model: "exact-model",
        instructions: "Use only committed input.",
        transcript: "Committed transcript.",
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(GatewayRequestUnknownOutcomeError);
    expect((thrown as GatewayRequestUnknownOutcomeError).evidence).toMatchObject({
      adapter: "cliproxyapi",
      endpoint: `http://localhost:${address.port}/v1`,
      requestedProvider: null,
      requestedModel: "exact-model",
      actualProvider: null,
      actualModel: null,
      requestId: null,
      sessionId: null,
      terminalStatus: "unknown",
      fallbackOccurred: false,
      toolsEnabled: false,
    });
    expect((thrown as Error).message.includes(INFERENCE_KEY)).toBe(false);
  });

  it("treats connection refusal and TLS handshake rejection as proven pre-dispatch failures", async () => {
    server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const closedAddress = server.address();
    if (!closedAddress || typeof closedAddress === "string") throw new Error("fake Gateway did not listen");
    server.close();
    await once(server, "close");
    server = null;
    const transport = new SecureGatewayTransport({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }],
    });

    const refused = transport.responses({
      endpoint: `http://localhost:${closedAddress.port}/v1`,
      httpsApproved: false,
      key: INFERENCE_KEY,
      body: { model: "exact-model" },
      timeoutMs: 500,
    });
    await expect(refused).rejects.toBeInstanceOf(GatewayNetworkPolicyError);
    await expect(refused).rejects.not.toBeInstanceOf(GatewayRequestUnknownOutcomeError);

    server = createServer();
    server.on("clientError", (_error, socket) => socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const plainHttpAddress = server.address();
    if (!plainHttpAddress || typeof plainHttpAddress === "string") throw new Error("fake Gateway did not listen");
    const tlsRejected = transport.responses({
      endpoint: `https://gateway.example:${plainHttpAddress.port}/v1`,
      httpsApproved: true,
      key: INFERENCE_KEY,
      body: { model: "exact-model" },
      timeoutMs: 500,
    });
    await expect(tlsRejected).rejects.toBeInstanceOf(GatewayNetworkPolicyError);
    await expect(tlsRejected).rejects.not.toBeInstanceOf(GatewayRequestUnknownOutcomeError);
  });

  it("keeps a post-dispatch connection reset in Unknown Outcome", async () => {
    server = createServer((request) => request.socket.destroy());
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake Gateway did not listen");
    const adapter = new CliProxyApiAdapter({
      endpoint: `http://localhost:${address.port}/v1`,
      httpsApproved: false,
      secrets: secretStore(),
      transport: new SecureGatewayTransport({
        lookup: async () => [{ address: "127.0.0.1", family: 4 }],
      }),
      timeoutMs: 500,
    });

    await expect(adapter.summarize({
      model: "exact-model",
      instructions: "Use only committed input.",
      transcript: "Committed transcript.",
    })).rejects.toBeInstanceOf(GatewayRequestUnknownOutcomeError);
  });

  it("applies one total timeout to DNS, redirects, connect, and response", async () => {
    const lookup = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return [{ address: "127.0.0.1", family: 4 as const }];
    });
    const adapter = new CliProxyApiAdapter({
      endpoint: "http://localhost:9/v1",
      httpsApproved: false,
      secrets: secretStore(),
      transport: new SecureGatewayTransport({ lookup }),
      timeoutMs: 25,
    });
    const startedAt = Date.now();

    const failure = adapter.summarize({
      model: "exact-model",
      instructions: "Use only committed input.",
      transcript: "Committed transcript.",
    });
    await expect(failure).rejects.toBeInstanceOf(GatewayNetworkPolicyError);
    await expect(failure).rejects.not.toBeInstanceOf(GatewayRequestUnknownOutcomeError);
    expect(Date.now() - startedAt).toBeLessThan(90);
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("rejects cross-origin and unsafe redirect targets before forwarding the bearer", async () => {
    server = createServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", "http://169.254.169.254/latest/meta-data");
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fake Gateway did not listen");
    const transport = new SecureGatewayTransport({
      lookup: async (hostname) => hostname === "localhost"
        ? [{ address: "127.0.0.1", family: 4 }]
        : [{ address: "169.254.169.254", family: 4 }],
    });

    await expect(transport.responses({
      endpoint: `http://localhost:${address.port}/v1`,
      httpsApproved: false,
      key: INFERENCE_KEY,
      body: { model: "exact-model" },
      timeoutMs: 2_000,
    })).rejects.toThrow(/redirect/i);
  });
});
