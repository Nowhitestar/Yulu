import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifactStore.js";
import { HostStore } from "../../src/hostStore.js";
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
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-activation-"));
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    host = new HostStore(join(root, "host.sqlite"));
    const artifacts = new ArtifactStore(moviesDir, join(root, "tasks"));
    const ctx = {
      host,
      artifacts,
      paths: { moviesDir },
    } as unknown as AppContext;
    return { moviesDir, artifacts, caller: createCaller(activationRouter, ctx) };
  }

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

    await expect(caller.status()).resolves.toEqual({ state: "unresolved", evidence: null });
    expect(host!.getCoreActivationEvidence()).toBeNull();
  });
});
