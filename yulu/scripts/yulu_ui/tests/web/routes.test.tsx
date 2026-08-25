// tests/web/routes.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { WsProvider } from "../../web/src/ws.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

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
import { Activate } from "../../web/src/routes/activate.js";

const ROUTES: { name: string; Component: React.ComponentType }[] = [
  { name: "agent-console",          Component: AgentConsole },
  { name: "inbox",                  Component: RecordingsList },
  { name: "inbox/:stem",            Component: RecordingReader },
  { name: "knowledge/prompts",      Component: Prompts },
  { name: "knowledge/glossary",     Component: Glossary },
  { name: "settings",               Component: SettingsLayout },
  { name: "health",                 Component: Health },
  { name: "voice-input",            Component: VoiceInput },
  { name: "activate",               Component: Activate },
];

describe("placeholder routes smoke", () => {
  it.each(ROUTES)("$name mounts without throwing", ({ Component }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/", element: <Component /> }], { initialEntries: ["/"] });
    expect(() =>
      render(
        <ThemeProvider>
          <LanguageProvider>
            <QueryClientProvider client={qc}>
              <WsProvider>
                <RouterProvider router={router} />
              </WsProvider>
            </QueryClientProvider>
          </LanguageProvider>
        </ThemeProvider>,
      ),
    ).not.toThrow();
  });

  it("has exactly 9 routes", () => {
    expect(ROUTES).toHaveLength(9);
  });

  it("keeps the three voice-input reference cards and removes redundant action controls", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/", element: <VoiceInput /> }], { initialEntries: ["/"] });
    const { container } = render(
      <ThemeProvider>
        <QueryClientProvider client={qc}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    expect(container.querySelectorAll(".voice-action")).toHaveLength(3);
    expect(container.querySelector(".voice-action-button")).toBeNull();
    expect(container.querySelector(".voice-input-links")).toBeNull();
    expect(container.querySelector(".voice-history")).toBeInTheDocument();
  });
});
