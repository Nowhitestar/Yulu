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

const ws = vi.hoisted(() => ({
  coreActivation: undefined as ((event: { taskId: string; recordingStem: string }) => void) | undefined,
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
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

import { ActivationEntry } from "../../../web/src/routes/entry.js";

function renderEntry(initial = "/inbox") {
  const router = createMemoryRouter([
    { path: "/activate", element: <h1>Activation journey</h1> },
    {
      path: "*",
      element: (
        <ActivationEntry>
          <h1>Normal product</h1>
        </ActivationEntry>
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
  it("automatically enters the Activation Journey once when unresolved", async () => {
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Activation journey" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/activate");
    expect(activation.acknowledge).toHaveBeenCalledOnce();
  });

  it("opens the normal product when Core Activation Evidence exists", async () => {
    activation.data!.state = "activated";
    activation.data!.evidenceCreated = false;
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(activation.acknowledge).not.toHaveBeenCalled();
  });

  it("does not steal focus back to activation while a durable attempt processes", async () => {
    activation.data!.state = "processing";
    const router = renderEntry("/agent-console");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(activation.acknowledge).not.toHaveBeenCalled();
  });

  it("announces a background completion without changing the current route", async () => {
    activation.data!.journey.shouldAutoEnter = false;
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

  it("opens the normal product after entry was acknowledged or deferred", async () => {
    activation.data!.journey.shouldAutoEnter = false;
    activation.data!.journey.deferredAt = "2026-08-25T04:00:00.000Z";
    const router = renderEntry("/agent-console");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/agent-console");
    expect(activation.acknowledge).not.toHaveBeenCalled();
  });

  it("keeps the requested product route when status is unavailable", async () => {
    activation.data = undefined;
    activation.isError = true;
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(activation.acknowledge).not.toHaveBeenCalled();
    expect(activation.queryOptions).toMatchObject({ retry: false });
  });

  it("shows a bounded pending state without entering activation", () => {
    activation.data = undefined;
    activation.isPending = true;
    renderEntry("/inbox");

    expect(screen.getByRole("status")).toHaveTextContent("正在检查激活状态");
    expect(activation.acknowledge).not.toHaveBeenCalled();
    expect(activation.queryOptions).toMatchObject({ retry: false });
  });
});
