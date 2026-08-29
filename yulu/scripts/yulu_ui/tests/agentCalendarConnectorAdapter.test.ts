import { describe, expect, it, vi } from "vitest";
import type { PersistedAgentConnection } from "../src/hostStore.js";
import {
  AgentCalendarConnectorProbeError,
  AgentCalendarConnectorRuntimeAdapter,
} from "../src/agentCalendarConnector.js";

const connection: PersistedAgentConnection = {
  id: "codex",
  kind: "supported-agent",
  adapter: "codex",
  label: "Codex",
  lifecycle: "available",
  settings: { executablePath: "/opt/bin/codex" },
  createdAt: "2026-08-29T03:00:00.000Z",
  updatedAt: "2026-08-29T03:00:00.000Z",
};

function toolEvidence(input: {
  name: string;
  result: unknown;
  status?: "completed" | "failed";
  error?: unknown;
}) {
  return JSON.stringify({
    type: "item.completed",
    item: {
      type: "mcp_tool_call",
      server: "google_calendar",
      tool: input.name,
      arguments: { max_results: 1 },
      result: input.result,
      status: input.status ?? "completed",
      error: input.error ?? null,
    },
  });
}

describe("AgentCalendarConnectorRuntimeAdapter", () => {
  it("uses one bounded read-only calendar operation and permits no mutation tools", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        status: "ready",
        connector: "google_calendar",
        operation: "list_calendars",
        detail: "Calendar list access verified",
      }),
      stderr: "",
      rawStdout: toolEvidence({ name: "list_calendars", result: { calendars: [] } }),
    });
    const adapter = new AgentCalendarConnectorRuntimeAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
      now: () => "2026-08-29T04:00:00.000Z",
    });

    await expect(adapter.probe({ connection, connector: "google_calendar" })).resolves.toEqual({
      detail: "Calendar list access verified",
      operation: "list_calendars",
      testedAt: "2026-08-29T04:00:00.000Z",
    });
    const invocation = run.mock.calls[0]![0];
    expect(invocation.timeoutMs).toBeLessThanOrEqual(30_000);
    expect(invocation.prompt).toMatch(/one bounded, read-only/i);
    expect(invocation.prompt).toMatch(/at most one calendar or one event/i);
    expect(invocation.prompt).toMatch(/result limit 1.*24-hour/i);
    expect(invocation.prompt).toMatch(/do not create, update, delete, send, or write/i);
    expect(invocation.connectorToolPolicy).toEqual({
      connector: "google_calendar",
      allowedTools: [
        "list_calendars",
        "get_calendars",
        "list_events",
        "get_events",
        "search_events",
        "calendar_list",
        "events_list",
      ],
      readGuard: {
        maxResults: 1,
        maxWindowHours: 24,
        timeWindowTools: ["list_events", "get_events", "search_events", "events_list"],
      },
    });
    expect(invocation.connectorToolPolicy.allowedTools.join(" ")).not.toMatch(
      /create|update|delete|send|write|insert|remove/i,
    );
    expect(invocation.runtime.command).toEqual([
      "/opt/bin/codex",
      "exec",
      "--sandbox",
      "read-only",
      "--skip-git-repo-check",
    ]);
  });

  it("fails closed when the Agent attempts a calendar mutation during adoption", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        status: "ready",
        connector: "google_calendar",
        operation: "create_event",
        detail: "created a test event",
      }),
      stderr: "",
      rawStdout: toolEvidence({ name: "create_event", result: { id: "event-1" } }),
    });
    const adapter = new AgentCalendarConnectorRuntimeAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.probe({ connection, connector: "google_calendar" })).rejects.toMatchObject({
      name: "AgentCalendarConnectorProbeError",
      failure: "runtime",
      message: expect.stringMatching(/guard rejected.*create_event/i),
    });
    expect(run.mock.calls[0]![0].connectorToolPolicy.allowedTools).not.toContain("create_event");
  });

  it("treats calendar domain status and error-like event text as successful payload data", async () => {
    const run = vi.fn().mockResolvedValue({
      code: 0,
      stdout: JSON.stringify({
        status: "ready",
        connector: "google_calendar",
        operation: "list_events",
        detail: "One event read without mutation",
      }),
      stderr: "",
      rawStdout: toolEvidence({
        name: "list_events",
        result: { events: [{ status: "confirmed", summary: "Timeout and error handling review" }] },
      }),
    });
    const adapter = new AgentCalendarConnectorRuntimeAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run,
    });

    await expect(adapter.probe({ connection, connector: "google_calendar" })).resolves.toMatchObject({
      operation: "list_events",
      detail: "One event read without mutation",
    });
  });

  it.each([
    ["runtime", { code: 1, stdout: "", stderr: "Codex hooks are unavailable", rawStdout: "" }],
    ["runtime", { code: 1, stdout: "", stderr: "Agent runtime network timeout", rawStdout: "" }],
    ["authorization", { code: 1, stdout: "", stderr: "OAuth unauthorized", rawStdout: "" }],
    ["runtime", {
      code: 0,
      stdout: '{"status":"ready","connector":"google_calendar","operation":"list_events"}',
      stderr: "",
      rawStdout: "",
    }],
    ["connector", {
      code: 1,
      stdout: "",
      stderr: "MCP server google_calendar is not configured",
      rawStdout: "",
    }],
    ["authorization", {
      code: 1,
      stdout: '{"status":"ready","connector":"google_calendar","operation":"list_events"}',
      stderr: "Agent CLI exited 1",
      rawStdout: toolEvidence({ name: "list_events", result: null, error: "OAuth unauthorized", status: "failed" }),
    }],
    ["external_service", {
      code: 1,
      stdout: '{"status":"ready","connector":"google_calendar","operation":"list_events"}',
      stderr: "Agent CLI exited 1",
      rawStdout: toolEvidence({ name: "list_events", result: null, error: "service returned 503", status: "failed" }),
    }],
  ] as const)("classifies an actual %s probe failure at its source", async (failure, result) => {
    const adapter = new AgentCalendarConnectorRuntimeAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run: vi.fn().mockResolvedValue(result),
    });

    try {
      await adapter.probe({ connection, connector: "google_calendar" });
      expect.fail("probe should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(AgentCalendarConnectorProbeError);
      expect((error as AgentCalendarConnectorProbeError).failure).toBe(failure);
    }
  });

  it.each([
    ["connector", "connector_configuration", "Claude Code connector configuration is unavailable"],
    ["runtime", "agent_runtime", "Agent process spawn failed"],
  ] as const)("normalizes a rejected runner as %s provenance", async (failure, origin, detail) => {
    const adapter = new AgentCalendarConnectorRuntimeAdapter({
      scriptDir: "/app/scripts",
      configDir: "/config",
      run: vi.fn().mockRejectedValue(new Error(detail)),
    });

    await expect(adapter.probe({ connection, connector: "google_calendar" })).rejects.toMatchObject({
      name: "AgentCalendarConnectorProbeError",
      failure,
      origin,
      message: detail,
    });
  });
});
