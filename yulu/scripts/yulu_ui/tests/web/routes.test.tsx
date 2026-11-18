// tests/web/routes.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import { UndoToastProvider } from "../../web/src/components/UndoToast.js";

// Stub trpc so every router call returns an empty/safe payload — the goal is mount-without-crash
vi.mock("../../web/src/trpc.js", () => {
  const noop = () => ({ data: undefined, isPending: false });
  const okMutation = () => ({ mutate: () => {}, mutateAsync: () => Promise.resolve(undefined), isPending: false });
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

import { APP_ROUTES } from "../../web/src/App.js";

function mount(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(APP_ROUTES, { initialEntries: [path] });
  const view = render(
    <ThemeProvider>
      <LanguageProvider>
        <UndoToastProvider>
          <QueryClientProvider client={qc}>
            <RouterProvider router={router} />
          </QueryClientProvider>
        </UndoToastProvider>
      </LanguageProvider>
    </ThemeProvider>,
  );
  return { router, ...view };
}

describe("app routes", () => {
  it.each([
    "/inbox",
    "/inbox/Standup_20260102_090000",
    "/knowledge/prompts",
    "/knowledge/glossary",
    "/settings/general",
    "/settings/recording",
    "/settings/meetings",
    "/settings/voice",
    "/settings/connections",
    "/health",
    "/activate",
    "/onboarding",
  ])("%s mounts inside the two-pane shell", (path) => {
    const { container } = mount(path);
    expect(container.querySelector(".root-shell > .root-pane")).not.toBeNull();
    expect(container.querySelector(".root-shell > .root-main")).not.toBeNull();
  });

  it("opens on the recordings list", async () => {
    const { router } = mount("/");
    await waitFor(() => expect(router.state.location.pathname).toBe("/inbox"));
  });

  it.each([
    // The meeting assistant and its voice window are gone.
    ["/agent-console", "/inbox"],
    ["/voice-chat", "/inbox"],
    // Voice input moved into Settings.
    ["/voice-input", "/settings/voice"],
    ["/agent-connections", "/settings/connections"],
    ["/settings/llm", "/settings/connections"],
    ["/settings/sharing", "/settings/connections"],
    ["/settings/integrations", "/settings/meetings"],
    ["/inbox/meetings", "/inbox"],
    ["/inbox/voicemails/voicemail_20260102_090000", "/inbox/Memo_20260102_090000"],
    ["/health/logs", "/health"],
  ])("keeps the retired link %s working by sending it to %s", async (from, to) => {
    const { router } = mount(from);
    await waitFor(() => expect(router.state.location.pathname).toBe(to));
  });

  it("has no page or navigation entry for a meeting assistant", () => {
    mount("/settings/general");
    expect(screen.queryByRole("link", { name: /助手|Assistant/i })).toBeNull();
    expect(APP_ROUTES[0]!.children!.filter((route) => route.Component).map((route) => route.path ?? "(index)")).toEqual([
      "inbox", "inbox/:stem", "activate", "onboarding", "knowledge/prompts", "knowledge/glossary", "settings", "health", "agent-connections",
    ]);
  });
});
