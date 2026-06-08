// web/src/trpc.ts
import { createTRPCReact } from "@trpc/react-query";
import { httpLink } from "@trpc/client";
import type { AppRouter } from "../../src/routers/_app.js";

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
  return trpc.createClient({
    links: [httpLink({ url: `${baseUrl}/trpc` })],
  });
}
