import { describe, expect, it, vi } from "vitest";
import { agentCalendarConnectorRouter } from "../../src/routers/agentCalendarConnector.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

describe("agentCalendarConnector router", () => {
  it("exposes read state and requires explicit UI mutations for selection and probe", async () => {
    const view = vi.fn(() => ({
      connections: [{ id: "codex", adapter: "codex", label: "Codex" }],
      selection: null,
      readiness: { status: "untested", failure: null, detail: "Not tested", remediation: "", evidence: null },
    }));
    const select = vi.fn(() => ({ selection: { connectionId: "codex", connector: "google_calendar" } }));
    const probe = vi.fn(async () => ({ readiness: { status: "ready" } }));
    const ctx = {
      uiMutationAuthorized: true,
      agentCalendarConnector: { view, select, probe },
    } as unknown as AppContext;
    const caller = createCaller(agentCalendarConnectorRouter, ctx);

    await expect(caller.view()).resolves.toMatchObject({
      connections: [{ id: "codex" }],
      readiness: { status: "untested" },
    });
    await expect(caller.select({ connectionId: "codex", connector: "google_calendar" }))
      .resolves.toMatchObject({ selection: { connectionId: "codex", connector: "google_calendar" } });
    await expect(caller.probe()).resolves.toMatchObject({ readiness: { status: "ready" } });
    expect(select).toHaveBeenCalledWith({ connectionId: "codex", connector: "google_calendar" });
    expect(probe).toHaveBeenCalledWith();
  });

  it("rejects connector names that cannot identify one runtime-owned connector", async () => {
    const select = vi.fn();
    const ctx = {
      uiMutationAuthorized: true,
      agentCalendarConnector: { view: vi.fn(), select, probe: vi.fn() },
    } as unknown as AppContext;
    const caller = createCaller(agentCalendarConnectorRouter, ctx);

    await expect(caller.select({ connectionId: "codex", connector: "calendar; rm" })).rejects.toThrow();
    expect(select).not.toHaveBeenCalled();
  });
});
