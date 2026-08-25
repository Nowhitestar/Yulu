// web/src/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import { httpLink } from "@trpc/client";
import type { AppRouter } from "../../src/routers/_app.js";

export const ACTIVATION_STATUS_TIMEOUT_MS = 10_000;

/**
 * Typed React hooks (`trpc.<router>.<procedure>.useQuery()` / `.useMutation()`).
 * Type imported directly from the server module — no codegen, no publish.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Build a tRPC client for a given base URL. Same-origin in prod (served by the
 * Node server), explicit URL in dev (Vite proxies to :7777).
 */
export function makeTrpcClient(baseUrl = "") {
  const mutationBearer = () => fetch(`${baseUrl}/api/ui-token`, {
    signal: AbortSignal.timeout(ACTIVATION_STATUS_TIMEOUT_MS),
  }).then(async (response) => {
    if (!response.ok) throw new Error("Yulu UI authorization is unavailable");
    const body = await response.json() as { token?: unknown };
    if (typeof body.token !== "string" || !body.token) {
      throw new Error("Yulu UI authorization is invalid");
    }
    return body.token;
  });
  return trpc.createClient({
    links: [httpLink({
      url: `${baseUrl}/trpc`,
      headers: async ({ op }) => op.type === "mutation"
        ? { Authorization: `Bearer ${await mutationBearer()}` }
        : {},
      fetch: (input, init) => {
        if (!String(input).includes("/trpc/activation.status")) return fetch(input, init);
        const deadline = AbortSignal.timeout(ACTIVATION_STATUS_TIMEOUT_MS);
        const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
        return fetch(input, { ...init, signal });
      },
    })],
  });
}
