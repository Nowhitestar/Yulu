import { describe, expect, it, vi } from "vitest";
import {
  CalendarSourceManager,
  type CalendarSourceAdapter,
  type CalendarSourceConfigStore,
} from "../src/calendarSources.js";

function configStore(initial: Record<string, unknown> = { calendars: [] }) {
  let state = structuredClone(initial);
  const store: CalendarSourceConfigStore = {
    read: () => state as ReturnType<CalendarSourceConfigStore["read"]>,
    update: vi.fn((key: string, value: unknown) => {
      if (key !== "calendars") throw new Error(`unexpected key ${key}`);
      state = { ...state, calendars: structuredClone(value) };
      return { daemonsNeedingRestart: ["calendar", "scheduler"], daemonsNeedingSighup: [] };
    }),
  };
  return { store, read: () => state };
}

function adapters(overrides: Partial<Record<"macos" | "gog", CalendarSourceAdapter>> = {}) {
  return {
    macos: overrides.macos ?? {
      probe: vi.fn(async ({ start, end }) => ({
        ok: true as const,
        adapter: "eventkit" as const,
        start,
        end,
        eventCount: 0,
      })),
    },
    gog: overrides.gog ?? {
      probe: vi.fn(async ({ start, end }) => ({
        ok: true as const,
        adapter: "gog-cli" as const,
        start,
        end,
        eventCount: 0,
      })),
    },
  };
}

const runningServices = async () => ({ ok: true as const });

describe("CalendarSourceManager", () => {
  it("presents macOS as the recommended primary source without selecting discovered sources", () => {
    const config = configStore();
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: adapters(),
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });

    expect(manager.view()).toMatchObject({
      selectedSource: null,
      readiness: { status: "untested", source: null },
      sources: [
        expect.objectContaining({ id: "macos", recommended: true, advanced: false, externalRuntime: false }),
        expect.objectContaining({ id: "gog", recommended: false, advanced: true, externalRuntime: true }),
      ],
    });
    expect(config.store.update).not.toHaveBeenCalled();
  });

  it("requires an explicit source selection and treats successful empty EventKit enumeration as ready", async () => {
    const config = configStore();
    const sourceAdapters = adapters();
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: sourceAdapters,
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });

    manager.select({ source: "macos" });
    expect(config.read()).toMatchObject({
      calendars: [{ type: "macos", enabled: true, watch_calendars: [] }],
    });

    await expect(manager.probe()).resolves.toMatchObject({
      status: "ready",
      source: "macos",
      reason: null,
      evidence: {
        capability: "calendar-source",
        source: "macos",
        adapter: "eventkit",
        enumerationSucceeded: true,
        eventCount: 0,
        testedAt: "2026-08-29T02:00:00.000Z",
      },
    });
    expect(sourceAdapters.macos.probe).toHaveBeenCalledWith({
      start: "2026-08-29T02:00:00.000Z",
      end: "2026-08-30T02:00:00.000Z",
      account: null,
    });
    await expect(manager.adoptionEvidence()).resolves.toMatchObject({
      kind: "calendar-source-probe",
      snapshot: { source: "macos", eventCount: 0 },
    });
  });

  it.each([
    ["runtime_missing", "Install gog"],
    ["authorization_denied", "gog auth"],
    ["authorization_restricted", "System Settings"],
    ["authorization_not_determined", "Allow Calendar access"],
    ["enumeration_failed", "Try again"],
  ] as const)("keeps %s as a stable repair reason", async (reason, remediation) => {
    const config = configStore();
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: adapters({
        gog: {
          probe: vi.fn(async () => ({
            ok: false as const,
            reason,
            detail: `stable ${reason}`,
            remediation,
          })),
        },
      }),
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    manager.select({ source: "gog", account: "me@example.com" });

    await expect(manager.probe()).resolves.toMatchObject({
      status: "failed",
      source: "gog",
      reason,
      detail: `stable ${reason}`,
      remediation,
      evidence: null,
    });
    await expect(manager.adoptionEvidence()).rejects.toThrow(/ready probe/i);
  });

  it("invalidates current readiness when the explicit source changes", async () => {
    const config = configStore();
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: adapters(),
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    manager.select({ source: "macos" });
    await manager.probe();

    manager.select({ source: "gog", account: "other@example.com" });

    expect(manager.view()).toMatchObject({
      selectedSource: { source: "gog", account: "other@example.com" },
      readiness: { status: "untested", source: "gog", evidence: null },
    });
    await expect(manager.adoptionEvidence()).rejects.toThrow(/ready probe/i);
  });

  it("invalidates failed readiness when the selected gog account changes outside the manager", async () => {
    const config = configStore();
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: adapters({
        gog: {
          probe: vi.fn(async () => ({
            ok: false as const,
            reason: "authorization_denied" as const,
            detail: "gog authorization failed",
            remediation: "Run gog auth",
          })),
        },
      }),
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    manager.select({ source: "gog", account: "first@example.com" });
    await manager.probe();

    config.store.update("calendars", [{
      type: "google",
      enabled: true,
      gog_account: "second@example.com",
      watch_calendars: ["primary"],
    }]);

    expect(manager.view()).toMatchObject({
      selectedSource: { source: "gog", account: "second@example.com" },
      readiness: { status: "untested", source: "gog", evidence: null },
    });
  });

  it("revalidates production service activation after manager reconstruction and before adoption", async () => {
    const config = configStore();
    const sourceAdapters = adapters();
    const firstManager = new CalendarSourceManager({
      config: config.store,
      adapters: sourceAdapters,
      verifyServices: runningServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    firstManager.select({ source: "macos" });
    firstManager.markServiceActivationFailed(["com.yulu.calendar: service not found"]);

    const verifyServices = vi.fn(async () => ({
      ok: false as const,
      errors: ["com.yulu.calendar: not running"],
    }));
    const reconstructedManager = new CalendarSourceManager({
      config: config.store,
      adapters: sourceAdapters,
      verifyServices,
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });

    await expect(reconstructedManager.probe()).resolves.toMatchObject({
      status: "failed",
      source: "macos",
      reason: "service_activation_failed",
      evidence: null,
    });
    expect(verifyServices).toHaveBeenCalledTimes(1);
    expect(sourceAdapters.macos.probe).not.toHaveBeenCalled();
    await expect(reconstructedManager.adoptionEvidence()).rejects.toThrow(/service activation/i);
    expect(verifyServices).toHaveBeenCalledTimes(2);
  });

  it("fails closed when production services stop after a successful probe", async () => {
    const config = configStore();
    const serviceState = { running: true };
    const manager = new CalendarSourceManager({
      config: config.store,
      adapters: adapters(),
      verifyServices: vi.fn(async () => serviceState.running
        ? { ok: true as const }
        : { ok: false as const, errors: ["com.yulu.scheduler: not running"] }),
      now: () => new Date("2026-08-29T02:00:00.000Z"),
    });
    manager.select({ source: "macos" });
    await expect(manager.probe()).resolves.toMatchObject({ status: "ready" });

    serviceState.running = false;

    await expect(manager.adoptionEvidence()).rejects.toThrow(/service activation/i);
    expect(manager.view().readiness).toMatchObject({
      status: "failed",
      reason: "service_activation_failed",
      evidence: null,
    });
  });
});
