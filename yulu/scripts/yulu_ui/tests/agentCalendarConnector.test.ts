import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../src/hostStore.js";
import {
  AgentCalendarConnector,
  AgentCalendarConnectorProbeError,
  type AgentCalendarConnectorAdapter,
} from "../src/agentCalendarConnector.js";

describe("AgentCalendarConnector", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-agent-calendar-connector-"));
    host = new HostStore(join(root, "host.sqlite"));
    host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    const adapter: AgentCalendarConnectorAdapter = {
      probe: vi.fn(),
    };
    return { adapter, connector: new AgentCalendarConnector({ host, adapter }) };
  }

  it("proves readiness only after a bounded read through the explicitly selected Agent Connection", async () => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({
      detail: "Calendar list access verified",
      operation: "list_calendars",
      testedAt: "2026-08-29T04:00:00.000Z",
    });

    expect(connector.view()).toMatchObject({
      selection: null,
      readiness: { status: "untested", failure: null },
    });
    expect(connector.select({ connectionId: "codex", connector: "google_calendar" }))
      .toMatchObject({
        selection: { connectionId: "codex", connector: "google_calendar" },
        readiness: { status: "untested", failure: null },
      });

    await expect(connector.probe()).resolves.toMatchObject({
      selection: { connectionId: "codex", connector: "google_calendar" },
      readiness: {
        status: "ready",
        failure: null,
        detail: "Calendar list access verified",
        evidence: {
          capability: "agent-calendar-connector",
          connectionId: "codex",
          adapter: "codex",
          connector: "google_calendar",
          operation: "list_calendars",
          testedAt: "2026-08-29T04:00:00.000Z",
        },
      },
    });
    expect(adapter.probe).toHaveBeenCalledWith(expect.objectContaining({
      connector: "google_calendar",
      connection: expect.objectContaining({ id: "codex", adapter: "codex" }),
    }));
  });

  it("persists only the non-secret connector selection and requires a fresh probe after Host restart", async () => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({
      detail: "Calendar list access verified",
      operation: "list_calendars",
      testedAt: "2026-08-29T04:00:00.000Z",
    });
    connector.select({ connectionId: "codex", connector: "google_calendar" });
    await connector.probe();

    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    const restarted = new AgentCalendarConnector({ host, adapter });

    expect(restarted.view()).toMatchObject({
      selection: { connectionId: "codex", connector: "google_calendar" },
      readiness: { status: "untested", evidence: null },
    });
    expect(JSON.stringify(restarted.view())).not.toMatch(/oauth|access_token|refresh_token/i);
  });

  it.each([
    ["runtime", "Agent runtime exited before the probe", /repair or update Codex.*\/fake\/codex/i],
    ["connector", "Calendar connector is not configured", /Codex.*configure "google_calendar"/i],
    ["authorization", "Calendar connector authorization was denied", /reauthorize "google_calendar".*native flow/i],
    ["external_service", "Calendar service returned 503", /restore access to the external calendar service/i],
  ] as const)("reports an exact %s failure with actionable guidance", async (failure, detail, remediation) => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockRejectedValue(new AgentCalendarConnectorProbeError(failure, detail));
    connector.select({ connectionId: "codex", connector: "google_calendar" });

    await expect(connector.probe()).resolves.toMatchObject({
      readiness: {
        status: "failed",
        failure,
        detail,
        remediation: expect.stringMatching(remediation),
        evidence: null,
      },
    });
  });

  it("guides native Agent reauthentication separately from connector reauthorization", async () => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockRejectedValue(new AgentCalendarConnectorProbeError(
      "authorization",
      "Agent runtime OAuth unauthorized",
      "agent_runtime",
    ));
    connector.select({ connectionId: "codex", connector: "google_calendar" });

    await expect(connector.probe()).resolves.toMatchObject({
      readiness: {
        status: "failed",
        failure: "authorization",
        remediation: expect.stringMatching(/reauthenticate Codex through its native flow/i),
      },
    });
  });

  it("returns exact current proof for versioned Onboarding adoption and no proof after restart", async () => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({
      detail: "Calendar list access verified",
      operation: "list_calendars",
      testedAt: "2026-08-29T04:00:00.000Z",
    });
    connector.select({ connectionId: "codex", connector: "google_calendar" });
    await connector.probe();

    expect(connector.adoptionEvidence()).toMatchObject({
      kind: "agent-calendar-connector-probe",
      reference: expect.stringMatching(/^agent-calendar-connector:[a-f0-9]{64}:2026-08-29T04:00:00.000Z$/),
      snapshot: {
        capability: "agent-calendar-connector",
        connectionId: "codex",
        adapter: "codex",
        connector: "google_calendar",
        connectionRevision: expect.stringMatching(/^[a-f0-9]{64}$/),
        operation: "list_calendars",
        testedAt: "2026-08-29T04:00:00.000Z",
      },
    });

    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    const restarted = new AgentCalendarConnector({ host, adapter });
    expect(() => restarted.adoptionEvidence()).toThrow(/current.*Connector Readiness/i);
  });

  it("persists only complete exact Agent Calendar Connector adoption evidence", async () => {
    const { adapter, connector } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({
      detail: "Calendar list access verified",
      operation: "list_calendars",
      testedAt: "2026-08-29T04:00:00.000Z",
    });
    connector.select({ connectionId: "codex", connector: "google_calendar" });
    await connector.probe();
    const evidence = connector.adoptionEvidence();

    const adopted = host!.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "agent-calendar-connector",
      contractVersion: "agent-calendar-connector-v1",
      outcome: "adopted",
      evidence,
    });
    expect(adopted).toMatchObject({
      capability: "agent-calendar-connector",
      outcome: "adopted",
      evidence,
    });

    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    expect(host.listOptionalCapabilityOutcomes()).toContainEqual(adopted);
    expect(JSON.stringify(adopted)).not.toMatch(/oauth.*token|access_token|refresh_token/i);
  });

  it("fails closed instead of invoking a corrupted persisted connector identity", () => {
    const { adapter, connector } = setup();
    connector.select({ connectionId: "codex", connector: "google_calendar" });
    host!.db.prepare(`
      UPDATE agent_calendar_connector_selection
      SET connector = 'calendar; write'
      WHERE id = 1
    `).run();

    expect(connector.view()).toMatchObject({ selection: null, readiness: { status: "untested" } });
    expect(() => connector.adoptionEvidence()).toThrow(/current.*Connector Readiness/i);
    expect(adapter.probe).not.toHaveBeenCalled();
  });
});
