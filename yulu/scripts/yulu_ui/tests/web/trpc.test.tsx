// tests/web/trpc.test.tsx
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "../../web/src/trpc.js";
import type { ReactNode } from "react";

describe("trpc client", () => {
  it("exports a typed trpc react proxy + makeTrpcClient factory", () => {
    // @trpc/react-query v11 returns a callable Proxy at every namespace level,
    // so typeof trpc.system is "function" (not "object" as in v10). Either way,
    // the assertion proves the typed proxy namespace exists.
    expect(trpc.system).toBeDefined();
    expect(typeof trpc.system.version.useQuery).toBe("function");
    const client = makeTrpcClient("http://127.0.0.1:7777");
    expect(client).toBeDefined();
  });

  it("Provider mounts with TanStack Query without throwing", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => "ok", { wrapper });
    expect(result.current).toBe("ok");
  });
});
