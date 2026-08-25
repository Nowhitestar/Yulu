import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const activation = vi.hoisted(() => ({
  data: {
    state: "unresolved" as "unresolved" | "activated",
    journey: {
      shouldAutoEnter: true,
      automaticEntryAcknowledgedAt: null as string | null,
      deferredAt: null as string | null,
    },
  } as {
    state: "unresolved" | "activated";
    journey: {
      shouldAutoEnter: boolean;
      automaticEntryAcknowledgedAt: string | null;
      deferredAt: string | null;
    };
  } | undefined,
  acknowledge: vi.fn(async () => ({ acknowledged: true })),
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    activation: {
      status: { useQuery: () => ({ data: activation.data, isPending: false }) },
      acknowledgeAutomaticEntry: {
        useMutation: () => ({ mutateAsync: activation.acknowledge }),
      },
    },
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
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(activation.acknowledge).not.toHaveBeenCalled();
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
    const router = renderEntry("/inbox");

    expect(await screen.findByRole("heading", { name: "Normal product" })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/inbox");
    expect(activation.acknowledge).not.toHaveBeenCalled();
  });
});
