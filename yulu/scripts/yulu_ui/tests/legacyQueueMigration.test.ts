import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { migrateLegacyAgentQueue } from "../src/legacyQueueMigration.js";

const roots: string[] = [];

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "yulu-legacy-queue-"));
  roots.push(path);
  return path;
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("migrateLegacyAgentQueue", () => {
  it("does nothing when the legacy queue is absent", () => {
    expect(migrateLegacyAgentQueue({ queuePath: join(root(), "missing.json") })).toBeNull();
  });

  it("archives completed output and records missing input without losing the source queue", () => {
    const dir = root();
    const queuePath = join(dir, "agent-queue.json");
    const summaryPath = join(dir, "meeting.summary.md");
    writeFileSync(summaryPath, "# done\n");
    writeFileSync(queuePath, JSON.stringify([
      { id: "materialized", type: "summary_request", summary_path: summaryPath },
      { id: "missing", type: "summary_request", status: "processing", audio_path: join(dir, "gone.wav") },
      { id: "historical", type: "summary_request", status: "done" },
      { id: "event", type: "transcript" },
    ]));
    const report = migrateLegacyAgentQueue({
      queuePath,
      now: new Date("2026-07-11T01:02:03.004Z"),
    });

    expect(report).toMatchObject({
      total: 4,
      actionable: 2,
      alreadyMaterialized: 1,
      retiredPending: 0,
      unresolvable: 1,
      archived: 2,
    });
    expect(existsSync(queuePath)).toBe(false);
    expect(existsSync(report!.archivePath)).toBe(true);
    expect(JSON.parse(readFileSync(report!.archivePath, "utf8"))).toHaveLength(4);
    expect(JSON.parse(readFileSync(report!.auditPath, "utf8"))).toMatchObject({ version: 2, total: 4 });
  });

  it("archives pending work without automatically executing historical audio", () => {
    const dir = root();
    const queuePath = join(dir, "agent-queue.json");
    const audioPath = join(dir, "Meeting_20260711_010203.wav");
    writeFileSync(audioPath, Buffer.alloc(64));
    writeFileSync(queuePath, JSON.stringify([{
      id: "legacy-task",
      type: "summary_request",
      title: "Meeting",
      audio_path: audioPath,
      summary_path: join(dir, "missing.summary.md"),
      prompt_content_snapshot: "Use this format",
    }]));
    const report = migrateLegacyAgentQueue({ queuePath });

    expect(report?.retiredPending).toBe(1);
    expect(report?.items[0]).toMatchObject({
      legacyId: "legacy-task",
      action: "retired_pending",
      audioPath,
      reason: expect.stringContaining("explicitly"),
    });
  });

  it("leaves malformed queue data untouched", () => {
    const dir = root();
    const queuePath = join(dir, "agent-queue.json");
    writeFileSync(queuePath, "{not-json");
    expect(() => migrateLegacyAgentQueue({ queuePath })).toThrow();
    expect(readFileSync(queuePath, "utf8")).toBe("{not-json");
  });
});
