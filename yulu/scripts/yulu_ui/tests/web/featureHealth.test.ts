import { describe, expect, it } from "vitest";
import { buildFeatureHealth, type FeatureInputs } from "../../web/src/components/health/featureHealth.js";
import { taskActivity } from "../../web/src/components/health/taskStatus.js";

const now = Date.parse("2026-09-18T04:00:00Z");
function healthy(): FeatureInputs {
  return {
    now,
    permissions: { input: "ready" },
    config: { transcription: { engine: "local" }, agent_pipeline: { enabled: true, auto_process_recordings: true }, status_agent: { enabled: true }, calendars: [{ enabled: true }] },
    capture: { reachable: true, recording: false, micReady: true, sysReady: true },
    recording: { state: "idle" },
    audio: { available: true, provider: "local" },
    connections: { selections: { summary: { connectionId: "codex", model: "selected" }, transcription: { connectionId: null, model: "local" } }, connections: [{ id: "codex", authorization: { connected: true }, capabilities: [{ capability: "summary", declared: true, currentReadiness: { status: "ready", model: "selected", testedAt: "2026-09-18T03:59:00Z" }, disclosure: { required: false } }] }] },
    calendar: { selectedSource: { source: "macos" }, readiness: { status: "ready" } },
    schedule: { updatedAt: "2026-09-18T03:59:00Z", exists: true, schedulerStatus: { pid: 1 }, calendarStatus: { pid: 2 }, events: [] },
  };
}
const feature = (input: FeatureInputs, id: string) => buildFeatureHealth(input).find((row) => row.id === id)!;

describe("feature readiness", () => {
  it("never claims voice input is ready without current input permission", () => {
    const input = healthy();
    input.permissions = { input: "needs_attention" };
    expect(feature(input, "voice")).toMatchObject({ state: "attention", detail: "inputPermission" });
    input.permissions = undefined;
    expect(feature(input, "voice")).toMatchObject({ state: "unchecked", detail: "inputPermissionUnknown" });
    input.permissions = { input: "unknown" };
    expect(feature(input, "voice").state).toBe("unchecked");
    input.permissions = { input: "check_failed" };
    expect(feature(input, "voice")).toMatchObject({ state: "unchecked", detail: "inputPermissionUnknown" });
  });
  it("does not claim availability before any observation", () => {
    expect(buildFeatureHealth({}).every((row) => row.state === "unchecked")).toBe(true);
  });
  it("requires microphone, system audio and recording controls", () => {
    const input = healthy();
    expect(feature(input, "recording").state).toBe("ready");
    input.capture!.sysReady = false;
    expect(feature(input, "recording")).toMatchObject({ state: "attention", detail: "systemAudio" });
    expect(feature(input, "voice").state).toBe("ready");
    input.capture = undefined;
    expect(feature(input, "recording").state).toBe("unchecked");
  });
  it("does not confuse stale successful data with a fresh observation", () => {
    const input = healthy();
    input.connections = undefined;
    input.recording = undefined;
    expect(feature(input, "summary").state).toBe("unchecked");
    expect(feature(input, "recording").state).toBe("unchecked");
    expect(feature(input, "voice").state).toBe("unchecked");
  });
  it("does not flag deliberately disabled automation or voice as failures", () => {
    const input = healthy();
    input.config!.agent_pipeline.auto_process_recordings = false;
    input.config!.status_agent.enabled = false;
    input.config!.calendars = [{ enabled: false }];
    input.connections = undefined;
    input.recording = undefined;
    expect(feature(input, "summary").state).toBe("off");
    expect(feature(input, "voice").state).toBe("off");
    expect(feature(input, "reminders").state).toBe("off");
  });
  it("requires current model proof, account authorization and data consent", () => {
    const input = healthy();
    const capability = input.connections!.connections[0]!.capabilities[0]!;
    capability.currentReadiness.model = "old-model";
    expect(feature(input, "summary").state).toBe("unchecked");
    capability.currentReadiness.model = "selected";
    capability.disclosure.required = true;
    expect(feature(input, "summary")).toMatchObject({ state: "attention", detail: "reviewData" });
    capability.disclosure.required = false;
    input.connections!.connections[0]!.authorization.connected = false;
    expect(feature(input, "summary")).toMatchObject({ state: "attention", detail: "signIn" });
  });
  it("keeps cloud transcription unverified when only credentials are present", () => {
    const input = healthy();
    input.config!.transcription.engine = "xai";
    input.audio = { available: true, provider: "xai-oauth:yulu" };
    input.connections!.selections.transcription = { connectionId: "codex", model: "speech-to-text" };
    input.connections!.connections[0]!.capabilities = [{ capability: "transcription", declared: true, disclosure: { required: false }, currentReadiness: { status: "untested", model: "speech-to-text" } }];
    expect(feature(input, "transcription").state).toBe("unchecked");
    expect(feature(input, "voice").state).toBe("unchecked");
  });
  it("detects stopped reminders and stale schedules even with prior calendar proof", () => {
    const input = healthy();
    input.schedule!.schedulerStatus = null;
    expect(feature(input, "reminders")).toMatchObject({ state: "attention", detail: "reminderStopped" });
    input.schedule!.schedulerStatus = { pid: 1 };
    input.schedule!.updatedAt = "2026-09-18T01:00:00Z";
    expect(feature(input, "reminders")).toMatchObject({ state: "attention", detail: "calendarStale" });
  });
  it("shows unchecked calendar access separately from a current empty schedule", () => {
    const input = healthy();
    input.calendar!.readiness.status = "untested";
    expect(feature(input, "reminders").state).toBe("unchecked");
    input.calendar!.readiness.status = "ready";
    expect(feature(input, "reminders")).toMatchObject({ state: "ready", detail: "calendarUpdated" });
    input.schedule!.events = [{ kind: "remind", at: "2026-09-18T05:00:00Z" }];
    expect(feature(input, "reminders")).toMatchObject({ detail: "nextReminder", time: "2026-09-18T05:00:00Z" });
  });
});

it("counts current work without hiding unresolved outcomes or resurfacing superseded failures", () => {
  expect(taskActivity([
    { id: "old", recordingStem: "one", state: "failed", updatedAt: "2026-09-17" },
    { id: "done", recordingStem: "one", state: "completed", updatedAt: "2026-09-18" },
    { id: "unknown", recordingStem: "two", state: "execution_unverified", updatedAt: "2026-09-17" },
    { id: "active", recordingStem: "two", state: "running", updatedAt: "2026-09-18" },
    { id: "off", recordingStem: "three", state: "awaiting_policy", trigger: "automatic", updatedAt: "2026-09-18" },
  ])).toEqual({ active: 1, attention: 1 });
});
