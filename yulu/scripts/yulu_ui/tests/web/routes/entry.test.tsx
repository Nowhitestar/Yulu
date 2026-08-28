import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const activation = vi.hoisted(() => ({
  data: {
    state: "unresolved" as "unresolved" | "activated" | "recording" | "processing",
    journey: {
      shouldAutoEnter: true,
      automaticEntryAcknowledgedAt: null as string | null,
      deferredAt: null as string | null,
    },
  } as {
    state: "unresolved" | "activated" | "recording" | "processing";
    evidence?: { taskId: string; recordingStem: string } | null;
    evidenceCreated?: boolean;
    journey: {
      shouldAutoEnter: boolean;
      automaticEntryAcknowledgedAt: string | null;
      deferredAt: string | null;
    };
  } | undefined,
  acknowledge: vi.fn(async () => ({ acknowledged: true })),
  refetch: vi.fn(async () => undefined),
  isPending: false,
  isError: false,
  queryOptions: undefined as { retry?: boolean } | undefined,
}));

const onboarding = vi.hoisted(() => ({
  data: {
    entry: {
      installationKind: "fresh" as "fresh" | "returning",
      automaticEntryAcknowledgedAt: null as string | null,
      shouldAutoEnter: true,
    },
  } as {
    entry: {
      installationKind: "fresh" | "returning";
      automaticEntryAcknowledgedAt: string | null;
      shouldAutoEnter: boolean;
    };
  } | undefined,
  acknowledge: vi.fn(async () => ({ acknowledged: true })),
  isPending: false,
  isError: false,
  queryOptions: undefined as { retry?: boolean } | undefined,
}));

const ws = vi.hoisted(() => ({
  coreActivation: undefined as ((event: { taskId: string; recordingStem: string }) => void) | undefined,
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    onboarding: {
      status: { useQuery: (_input: undefined, options?: { retry?: boolean }) => {
        onboarding.queryOptions = options;
        return {
          data: onboarding.data,
          isPending: onboarding.isPending,
          isError: onboarding.isError,
        };
      } },
      acknowledgeAutomaticEntry: {
        useMutation: () => ({ mutateAsync: onboarding.acknowledge }),
      },
    },
    activation: {
      status: { useQuery: (_input: undefined, options?: { retry?: boolean }) => {
        activation.queryOptions = options;
        return {
          data: activation.data,
          isPending: activation.isPending,
          isError: activation.isError,
          refetch: activation.refetch,
        };
      } },
      acknowledgeAutomaticEntry: {
        useMutation: () => ({ mutateAsync: activation.acknowledge }),
      },
    },
  },
}));

vi.mock("../../../web/src/ws.js", () => ({
  useWsChannel: (channel: string, handler: (event: { taskId: string; recordingStem: string }) => void) => {
    if (channel === "core-activation") ws.coreActivation = handler;
  },
}));

import { OnboardingEntry } from "../../../web/src/routes/entry.js";

function renderEntry(initial = "/inbox") {
  const router = createMemoryRouter([
    { path: "/onboarding", element: <h1>Onboarding home</h1> },
    { path: "/activate", element: <h1>Activation journey</h1> },
    {
      path: "*",
      element: (
        <OnboardingEntry>
          <h1>Normal product</h1>
        </OnboardingEntry>
      ),
    },
  ], { initialEntries: [initial] });
  render(
    <LanguageProvider>
      <RouterProvider router={router} />
    </LanguageProvider>,
  );
  return router;
}

afterEach(() => {
  onboarding.data = {
    entry: {
      installationKind: "fresh",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: true,
    },
  };
  onboarding.acknowledge.mockClear();
  onboarding.isPending = false;
  onboarding.isError = false;
  onboarding.queryOptions = undefined;
  activation.data = {
    state: "unresolved",
    journey: {
      shouldAutoEnter: true,
      automaticEntryAcknowledgedAt: null,
      deferredAt: null,
    },
  };
  activation.acknowledge.mockClear();
  activation.refetch.mockClear();
  activation.isPending = false;
  activation.isError = false;
  activation.queryOptions = undefined;
  ws.coreActivation = undefined;
});

describe("/ entry", () => {
  it("automatically enters Onboarding Home once for a fresh install", async () => {
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Onboarding home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(onboarding.acknowledge).toHaveBeenCalledOnce();
    expect(activation.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps returning users in the requested product route", async () => {
    onboarding.data!.entry = {
      installationKind: "returning",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: false,
    };
    activation.data!.state = "activated";
    activation.data!.evidenceCreated = false;
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(onboarding.acknowledge).not.toHaveBeenCalled();
  });

  it("still enters Onboarding Home for a fresh install whose Core Activation is complete", async () => {
    activation.data!.state = "activated";
    activation.data!.evidenceCreated = false;
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Onboarding home" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/onboarding");
    expect(onboarding.acknowledge).toHaveBeenCalledOnce();
  });

  it("does not steal focus back to activation while a durable attempt processes", async () => {
    activation.data!.state = "processing";
    const router = renderEntry("/agent-console");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(onboarding.acknowledge).not.toHaveBeenCalled();
  });

  it("announces a background completion without changing the current route", async () => {
    onboarding.data!.entry.shouldAutoEnter = false;
    const router = renderEntry("/agent-console");
    await screen.findByRole("heading", { name: "Normal product" });

    act(() => ws.coreActivation?.({
      taskId: "task-background",
      recordingStem: "Background_20260825_142000",
    }));

    expect(screen.getByRole("status")).toHaveTextContent("核心激活已完成");
    expect(screen.getByRole("link", { name: "打开已保存笔记" })).toHaveAttribute(
      "href",
      "/inbox/Background_20260825_142000",
    );
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(activation.refetch).toHaveBeenCalledOnce();
  });

  it("announces historical evidence discovered by the Host without redirecting", async () => {
    onboarding.data!.entry = {
      installationKind: "returning",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: false,
    };
    activation.data = {
      state: "activated",
      evidenceCreated: true,
      evidence: { taskId: "task-history", recordingStem: "Historical_20260824_090000" },
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: "2026-08-25T04:00:00.000Z",
      },
    };
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("status")).toHaveTextContent("核心激活已完成");
    expect(router.state.location.pathname).toBe("/inbox");
  });

  it("opens the normal product after automatic Onboarding entry was acknowledged", async () => {
    onboarding.data!.entry.shouldAutoEnter = false;
    onboarding.data!.entry.automaticEntryAcknowledgedAt = "2026-08-25T04:00:00.000Z";
    const router = renderEntry("/agent-console");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(onboarding.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps the requested product route when status is unavailable", async () => {
    onboarding.data = undefined;
    onboarding.isError = true;
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(onboarding.acknowledge).not.toHaveBeenCalled();
    expect(onboarding.queryOptions).toMatchObject({ retry: false });
  });

  it("shows a bounded pending state without entering onboarding", () => {
    onboarding.data = undefined;
    onboarding.isPending = true;
    renderEntry("/inbox");

    expect(screen.getByRole("status")).toHaveTextContent("正在检查激活状态");
    expect(onboarding.acknowledge).not.toHaveBeenCalled();
    expect(onboarding.queryOptions).toMatchObject({ retry: false });
  });
});
