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

  it("adopts a committed transcript without rewriting its bytes during summary commit", () => {
    const { store, task } = setup();
    const transcriptPath = join(root, "Movies", "Yulu", `${task.recordingStem}.transcript.txt`);
    const original = "committed transcript\n\n";
    writeFileSync(transcriptPath, original);

    const transcript = store.adoptCommittedTranscript(task, { source: "manual-regeneration" });
    expect(readFileSync(transcriptPath, "utf8")).toBe(original);
    expect(store.readCommittedTranscript(task, transcript)).toBe("committed transcript");

    store.writeStagedSummary(task.id, "# Replacement summary");
    store.commitFromWorkspace(task, {});
    expect(readFileSync(transcriptPath, "utf8")).toBe(original);
  });

  it("keeps stale committed artifacts until a validated staged summary replaces them", () => {
    const { store, task } = setup();
    const transcriptPath = join(root, "Movies", "Yulu", `${task.recordingStem}.transcript.txt`);
    const summaryPath = join(root, "Movies", "Yulu", `${task.recordingStem}.summary.md`);
    const stalePath = join(root, "Movies", "Yulu", `${task.recordingStem}.summary.stale`);
    writeFileSync(transcriptPath, "old transcript\n");
    writeFileSync(summaryPath, "# Old summary\n");
    writeFileSync(stalePath, "stale\n");
    store.writeStagedTranscript(task.id, "old transcript");
    writeFileSync(store.workspace(task.id).summaryPath, "   \n");

    expect(() => store.commitFromWorkspace(task, {})).toThrow(/summary staging artifact contains no text/);
    expect(readFileSync(transcriptPath, "utf8")).toBe("old transcript\n");
    expect(readFileSync(summaryPath, "utf8")).toBe("# Old summary\n");
    expect(existsSync(stalePath)).toBe(true);

    store.writeStagedSummary(task.id, "# New summary");
    store.commitFromWorkspace(task, {});
    expect(readFileSync(transcriptPath, "utf8")).toBe("old transcript\n");
    expect(readFileSync(summaryPath, "utf8")).toBe("# New summary\n");
    expect(existsSync(stalePath)).toBe(false);
  });

  it("does not replace the public summary until prepared records are durably accounted for", () => {
    const { store, task } = setup();
    const transcriptPath = join(root, "Movies", "Yulu", `${task.recordingStem}.transcript.txt`);
    const summaryPath = join(root, "Movies", "Yulu", `${task.recordingStem}.summary.md`);
    writeFileSync(transcriptPath, "committed transcript\n");
    writeFileSync(summaryPath, "# Previously verified summary\n");
    store.writeStagedTranscript(task.id, "committed transcript");
    store.writeStagedSummary(task.id, "# Newly verified summary");

    const records = store.prepareFromWorkspace(task, { summaryProvider: "xai" });

    expect(readFileSync(summaryPath, "utf8")).toBe("# Previously verified summary\n");
    store.publishPreparedArtifacts(task, records);
    expect(readFileSync(summaryPath, "utf8")).toBe("# Newly verified summary\n");
    expect(store.readCommittedSummary(task, records.find((record) => record.kind === "summary")!))
      .toBe("# Newly verified summary");
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
