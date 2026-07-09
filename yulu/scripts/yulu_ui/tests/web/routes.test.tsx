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
  const utils = new Proxy({}, {
    get() {
      return new Proxy({}, {
        get() {
          return { invalidate: () => Promise.resolve(), fetch: () => Promise.resolve(undefined) };
        },
      });
    },
  });
  return {
    trpc: new Proxy({}, {
      get(_target, prop) {
        if (prop === "useUtils") return () => utils;
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

import { RecordingsList } from "../../web/src/routes/inbox/recordings.js";
import { RecordingReader } from "../../web/src/routes/inbox/recordings.$stem.js";
import { Prompts }    from "../../web/src/routes/knowledge/prompts.js";
import { Glossary }   from "../../web/src/routes/knowledge/glossary.js";
import { SettingsLayout } from "../../web/src/routes/settings.js";
import { Health }    from "../../web/src/routes/health.js";
import { AgentConsole } from "../../web/src/routes/agent-console.js";
import { VoiceInput } from "../../web/src/routes/voice-input.js";

const ROUTES: { name: string; Component: React.ComponentType }[] = [
  { name: "agent-console",          Component: AgentConsole },
  { name: "inbox",                  Component: RecordingsList },
  { name: "inbox/:stem",            Component: RecordingReader },
  { name: "knowledge/prompts",      Component: Prompts },
  { name: "knowledge/glossary",     Component: Glossary },
  { name: "settings",               Component: SettingsLayout },
  { name: "health",                 Component: Health },
  { name: "voice-input",            Component: VoiceInput },
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

  it("has exactly 8 routes", () => {
    expect(ROUTES).toHaveLength(8);
  });
});
