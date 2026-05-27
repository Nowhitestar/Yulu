// tests/web/routes.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { WsProvider } from "../../web/src/ws.js";

// Stub trpc so every router call returns an empty/safe payload — the goal is mount-without-crash
vi.mock("../../web/src/trpc.js", () => {
  const noop = () => ({ data: undefined, isPending: false });
  const okMutation = () => ({ mutate: () => {}, isPending: false });
  return {
    trpc: new Proxy({}, {
      get() {
        return new Proxy({}, {
          get() {
            return { useQuery: noop, useMutation: okMutation };
          },
        });
      },
    }),
    makeTrpcClient: () => ({}),
  };
});

// Stub ws so no real WebSocket opens during tests
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";
import { Meetings }   from "../../web/src/routes/inbox/meetings.js";
import { Prompts }    from "../../web/src/routes/knowledge/prompts.js";
import { Glossary }   from "../../web/src/routes/knowledge/glossary.js";
import { Settings }  from "../../web/src/routes/settings.js";
import { HealthDaemons } from "../../web/src/routes/health/daemons.js";
import { HealthLogs }    from "../../web/src/routes/health/logs.js";

const ROUTES: { name: string; Component: React.ComponentType }[] = [
  { name: "inbox/voicemails",       Component: Voicemails },
  { name: "inbox/meetings",         Component: Meetings },
  { name: "knowledge/prompts",      Component: Prompts },
  { name: "knowledge/glossary",     Component: Glossary },
  { name: "settings",               Component: Settings },
  { name: "health/daemons",         Component: HealthDaemons },
  { name: "health/logs",            Component: HealthLogs },
];

describe("placeholder routes smoke", () => {
  it.each(ROUTES)("$name mounts without throwing", ({ Component }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/", element: <Component /> }], { initialEntries: ["/"] });
    expect(() =>
      render(
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <WsProvider>
              <RouterProvider router={router} />
            </WsProvider>
          </QueryClientProvider>
        </ThemeProvider>,
      ),
    ).not.toThrow();
  });

  it("has exactly 7 routes", () => {
    expect(ROUTES).toHaveLength(7);
  });
});
