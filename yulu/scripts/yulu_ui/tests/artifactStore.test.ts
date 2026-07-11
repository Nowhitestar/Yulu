import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifactStore.js";
import type { AgentTask } from "../src/hostStore.js";

describe("ArtifactStore", () => {
  let root = "";
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-artifacts-"));
    const moviesDir = join(root, "Movies", "Yulu");
    const store = new ArtifactStore(moviesDir, join(root, "tasks"));
    const audioPath = join(moviesDir, "Demo_20260711_120000.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const task = {
      id: "019f0000-0000-7000-8000-000000000001",
      recordingStem: "Demo_20260711_120000",
      audioPath,
    } as AgentTask;
    return { store, task };
  }

  it("commits only fixed task-scoped transcript and summary paths", () => {
    const { store, task } = setup();
    const workspace = store.workspace(task.id);
    writeFileSync(workspace.transcriptPath, "hello transcript");
    writeFileSync(workspace.summaryPath, "# Summary\n\nhello");
    const records = store.commitFromWorkspace(task, { agent: "hermes", provider: "xai" });
    expect(records.map((record) => record.kind)).toEqual(["transcript", "summary"]);
    expect(readFileSync(records[0]!.path, "utf8")).toBe("hello transcript\n");
    expect(readFileSync(records[1]!.path, "utf8")).toContain("# Summary");
    expect(records[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    store.cleanupWorkspace(task.id);
    expect(existsSync(workspace.dir)).toBe(false);
  });

  it("stages through task-scoped methods and verifies committed summary bytes and hash", () => {
    const { store, task } = setup();
    store.writeStagedTranscript(task.id, "private transcript");
    store.writeStagedSummary(task.id, "# Safe summary");
    expect(store.readStagedTranscript(task.id)).toBe("private transcript");
    const summary = store.commitFromWorkspace(task, {}).find((record) => record.kind === "summary")!;
    expect(store.readCommittedSummary(task, summary)).toBe("# Safe summary");

    writeFileSync(summary.path, "# tampered\n");
    expect(() => store.readCommittedSummary(task, summary)).toThrow(/no longer matches/);
  });

  it("rejects a task whose stem does not match its audio path", () => {
    const { store, task } = setup();
    const workspace = store.workspace(task.id);
    writeFileSync(workspace.transcriptPath, "hello");
    writeFileSync(workspace.summaryPath, "summary");
    task.recordingStem = "Other_20260711_120000";
    expect(() => store.commitFromWorkspace(task, {})).toThrow(/stem does not match/);
  });

  it("cleans only inactive UUID task workspaces", () => {
    const { store } = setup();
    const active = "11111111-1111-4111-8111-111111111111";
    const inactive = "22222222-2222-4222-8222-222222222222";
    store.workspace(active);
    store.workspace(inactive);
    mkdirSync(join(root, "tasks", "manual-backup"));

    expect(store.cleanupInactiveWorkspaces([active])).toEqual([inactive]);
    expect(existsSync(join(root, "tasks", active))).toBe(true);
    expect(existsSync(join(root, "tasks", inactive))).toBe(false);
    expect(existsSync(join(root, "tasks", "manual-backup"))).toBe(true);
  });
});
