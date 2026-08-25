import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ipcSendMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/ipc.js", () => ({ ipcSend: ipcSendMock }));

import { ArtifactStore } from "../../src/artifactStore.js";
import { HostStore } from "../../src/hostStore.js";
import { XAI_TRANSCRIPTION_DISCLOSURE_VERSION } from "../../src/transcriptionConsent.js";
import { activationRouter } from "../../src/routers/activation.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function wavWithAudio(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(37, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(1, 40);
  return Buffer.concat([header, Buffer.from([1])]);
}

describe("activation router", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
    ipcSendMock.mockReset();
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-activation-"));
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    host = new HostStore(join(root, "host.sqlite"));
    const artifacts = new ArtifactStore(moviesDir, join(root, "tasks"));
    const configValue = {
      audio: { mic_device: "BuiltInMic" },
      transcription: { engine: "local" as "local" | "xai" },
    };
    const localStatus = {
      installed: true,
      ready: true,
      provider: "sherpa-onnx-paraformer-int8",
      error: null as string | null,
    };
    ipcSendMock.mockImplementation(async (_path: string, payload: { action: string }) => {
      if (payload.action === "status") return { micReady: true, micError: "" };
      if (payload.action === "audio_devices") {
        return { input: [{ uid: "BuiltInMic", name: "MacBook Pro Microphone" }], output: [] };
      }
      throw new Error(`unexpected action: ${payload.action}`);
    });
    const ctx = {
      host,
      artifacts,
      paths: { moviesDir, audioDaemonSock: join(root, "audio.sock") },
      config: {
        read: () => configValue,
        update: (_key: string, value: "local" | "xai") => {
          configValue.transcription.engine = value;
          return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
        },
      },
      localCaption: {
        status: () => localStatus,
        syncSelection: async () => {},
      },
      xaiCredentials: {
        cachedStatus: () => ({ connected: true, source: "oauth", detail: "connected" }),
      },
      xaiReadiness: new Map(),
    } as unknown as AppContext;
    return { moviesDir, artifacts, caller: createCaller(activationRouter, ctx), configValue, localStatus, ctx };
  }

  it("reports microphone, selected audio input, and local probe readiness separately", async () => {
    const { caller, localStatus } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      state: "unresolved",
      nextStep: null,
      blocker: null,
      readiness: {
        microphonePermission: { state: "ready" },
        audioInput: { state: "ready", selectedDeviceUid: "BuiltInMic" },
        transcription: {
          selected: "local",
          state: "ready",
          local: { available: true, ready: true },
        },
      },
    });

    localStatus.ready = false;
    localStatus.error = "local model probe failed";
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "transcription",
      blocker: {
        capability: "local_transcription",
        remediation: { href: "/settings/transcription" },
      },
      readiness: {
        transcription: {
          selected: "local",
          state: "blocked",
          local: { available: true, ready: false, detail: "local model probe failed" },
        },
      },
    });
  });

  it("treats the legacy CoreAudio index as the current default input", async () => {
    const { caller, configValue } = setup();
    configValue.audio.mic_device = ":0";

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      readiness: {
        audioInput: { state: "ready", selectedDeviceUid: null },
      },
    });
  });

  it("requires the current xAI audio disclosure independently of authorization", async () => {
    const { caller, configValue, ctx } = setup();
    configValue.transcription.engine = "xai";
    ctx.xaiReadiness!.set("transcription", {
      capability: "transcription",
      status: "ready",
      model: "speech-to-text",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "ready",
      credentialSource: "oauth",
    });
    host!.recordCloudTranscriptionConsent("xai-audio-v0");

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "transcription",
      readiness: {
        transcription: {
          selected: "xai",
          state: "disclosure_required",
          xai: {
            ready: true,
            disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
            acceptedDisclosureVersion: "xai-audio-v0",
            disclosureRequired: true,
          },
        },
      },
    });

    await expect(caller.acceptXaiTranscriptionDisclosure()).resolves.toMatchObject({
      disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
      acceptedAt: expect.any(String),
    });
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      readiness: {
        transcription: {
          selected: "xai",
          state: "ready",
          xai: { disclosureRequired: false },
        },
      },
    });
  });

  it("names microphone and missing selected-input blockers with exact remediation", async () => {
    const { caller } = setup();
    ipcSendMock.mockImplementation(async (_path: string, payload: { action: string }) => {
      if (payload.action === "status") return { micReady: false, micError: "TCC denied" };
      return { input: [{ uid: "OtherMic", name: "Other microphone" }], output: [] };
    });

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "microphone_permission",
      blocker: {
        capability: "microphone_permission",
        remediation: {
          href: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        },
      },
      readiness: {
        microphonePermission: { state: "blocked", detail: "TCC denied" },
        audioInput: {
          state: "blocked",
          selectedDeviceUid: "BuiltInMic",
          remediation: { href: "/settings/general" },
        },
      },
    });
  });

  function completeRecording(
    moviesDir: string,
    artifacts: ArtifactStore,
    stem: string,
    completedAt: string,
  ) {
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const queued = host!.enqueueRecording({
      idempotencyKey: `recording:${stem}`,
      recordingStem: stem,
      title: stem,
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    }).task;
    const claimed = host!.claim(queued.id)!;
    const transcript = artifacts.commitTranscript(claimed, "verified transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(claimed.id, claimed.leaseToken!, transcript);
    host!.recordProgress(
      claimed.id,
      claimed.leaseToken!,
      "summarizing",
      "Transcription provider: local",
    );
    artifacts.writeStagedSummary(claimed.id, "# Verified summary");
    const records = artifacts.commitFromWorkspace(host!.getTask(claimed.id)!, {
      agentProvider: "hermes",
      committedBy: "yulu-host",
    });
    host!.recordArtifacts(claimed.id, claimed.leaseToken!, records);
    host!.complete(claimed.id, claimed.leaseToken!, { transcriptionProvider: "local" });
    host!.db.prepare("UPDATE agent_tasks SET updated_at = ? WHERE id = ?").run(completedAt, claimed.id);
    return host!.getTask(claimed.id)!;
  }

  it("bootstraps the most recent fully verified historical recording", async () => {
    const { moviesDir, artifacts, caller } = setup();
    completeRecording(moviesDir, artifacts, "Older_20260710_100000", "2026-07-10T10:05:00.000Z");
    const recent = completeRecording(moviesDir, artifacts, "Recent_20260711_120000", "2026-07-11T12:05:00.000Z");

    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: {
        recordingStem: recent.recordingStem,
        taskId: recent.id,
        transcriptionProvider: "local",
        summaryProvider: "hermes",
        summaryModel: "runtime-managed",
      },
      sourceArtifactAvailable: true,
      completedNoteAvailable: true,
    });
    expect(host!.getCoreActivationEvidence()?.taskId).toBe(recent.id);

    rmSync(recent.audioPath);
    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: { taskId: recent.id },
      sourceArtifactAvailable: false,
      completedNoteAvailable: true,
      completedNote: "# Verified summary",
    });
  });

  it("bootstraps verified artifacts even when optional delivery was unverified", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Delivered_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    host!.db.prepare(`
      UPDATE agent_tasks
      SET state = 'delivery_unverified', audit_json = NULL
      WHERE id = ?
    `).run(task.id);

    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: {
        taskId: task.id,
        transcriptionProvider: "local",
      },
    });
  });

  it("keeps unverifiable historical recordings unresolved", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Stale_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    writeFileSync(join(moviesDir, `${task.recordingStem}.summary.stale`), "stale\n");

    await expect(caller.status()).resolves.toMatchObject({ state: "unresolved", evidence: null });
    expect(host!.getCoreActivationEvidence()).toBeNull();
  });

  it("acknowledges automatic entry once across Host restarts", async () => {
    const { caller, ctx } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: true,
        automaticEntryAcknowledgedAt: null,
        deferredAt: null,
      },
    });
    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: true,
      journey: { shouldAutoEnter: false },
    });
    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: false,
      journey: { shouldAutoEnter: false },
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: expect.any(String),
        deferredAt: null,
      },
    });
  });

  it("does not acknowledge automatic entry after Core Activation is proven", async () => {
    const { moviesDir, artifacts, caller } = setup();
    completeRecording(
      moviesDir,
      artifacts,
      "Activated_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    await expect(caller.status()).resolves.toMatchObject({ state: "activated" });

    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: false,
      journey: { automaticEntryAcknowledgedAt: null },
    });
  });

  it("persists Activation Deferral without claiming Core Activation", async () => {
    const { caller, ctx } = setup();

    const firstDeferral = await caller.defer();
    expect(firstDeferral).toMatchObject({
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: expect.any(String),
      },
    });
    await expect(caller.defer()).resolves.toMatchObject({
      journey: { deferredAt: firstDeferral.journey.deferredAt },
    });
    await expect(caller.status()).resolves.toMatchObject({ state: "unresolved", evidence: null });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      evidence: null,
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: expect.any(String),
      },
    });
  });

  it("reports durable entry and deferral write failures without changing the decision", async () => {
    const { caller, ctx } = setup();
    host!.close();
    host = undefined;

    await expect(caller.acknowledgeAutomaticEntry()).rejects.toThrow();
    await expect(caller.defer()).rejects.toThrow();

    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: true,
        automaticEntryAcknowledgedAt: null,
        deferredAt: null,
      },
    });
  });
});
