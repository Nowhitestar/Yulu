import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
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

function migrateQueue(input: {
  queuePath: string;
  archiveDir: string;
  now?: Date;
}) {
  mkdirSync(input.archiveDir, { recursive: true, mode: 0o700 });
  const raw = readFileSync(input.queuePath, "utf8");
  const stamp = createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const archivePath = join(input.archiveDir, `agent-queue.legacy.${stamp}.json`);
  const auditPath = join(input.archiveDir, `agent-queue.migration.${stamp}.json`);
  const queueFD = openSync(input.queuePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const archiveFD = openSync(archivePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  const auditFD = openSync(auditPath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    return migrateLegacyAgentQueue({
      queueFD,
      archiveFD,
      auditFD,
      sourcePath: input.queuePath,
      archiveName: archivePath.split("/").at(-1)!,
      auditName: auditPath.split("/").at(-1)!,
      ...(input.now ? { now: input.now } : {}),
    });
  } finally {
    closeSync(auditFD);
    closeSync(archiveFD);
    closeSync(queueFD);
  }
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("migrateLegacyAgentQueue", () => {
  it("writes only inherited output descriptors when the archive pathname is a symlink", () => {
    const dir = root();
    const outside = join(dir, "outside");
    const archiveAlias = join(dir, "archive-alias");
    const queuePath = join(dir, "agent-queue.json");
    const archiveOutput = join(dir, "archive-output.tmp");
    const auditOutput = join(dir, "audit-output.tmp");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, archiveAlias, "dir");
    writeFileSync(queuePath, "[]\n", { mode: 0o600 });
    const queueFD = openSync(queuePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const archiveFD = openSync(archiveOutput, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    const auditFD = openSync(auditOutput, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const report = migrateLegacyAgentQueue({
        queueFD,
        archiveFD,
        auditFD,
        sourcePath: queuePath,
        archiveName: "agent-queue.legacy.expected.json",
        auditName: "agent-queue.migration.expected.json",
      });
      expect(report?.total).toBe(0);
      expect(readFileSync(archiveOutput, "utf8")).toBe("[]\n");
      expect(JSON.parse(readFileSync(auditOutput, "utf8"))).toMatchObject({ version: 2, total: 0 });
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      closeSync(auditFD);
      closeSync(archiveFD);
      closeSync(queueFD);
    }
  });

  it("does nothing when the legacy queue is absent", () => {
    const dir = root();
    expect(migrateLegacyAgentQueue({
      queueFD: null,
      archiveFD: null,
      auditFD: null,
      sourcePath: join(dir, "missing.json"),
      archiveName: "unused-archive.json",
      auditName: "unused-audit.json",
    })).toBeNull();
  });

  it("rejects a descriptor that is not an exact regular queue file", () => {
    const dir = root();
    const queueFD = openSync(dir, constants.O_RDONLY);
    try {
      expect(() => migrateLegacyAgentQueue({
        queueFD,
        archiveFD: null,
        auditFD: null,
        sourcePath: join(dir, "agent-queue.json"),
        archiveName: "unused-archive.json",
        auditName: "unused-audit.json",
      })).toThrow("descriptor is unsafe");
    } finally {
      closeSync(queueFD);
    }
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
    const report = migrateQueue({
      queuePath,
      archiveDir: join(dir, "standard", "legacy-agent-queue"),
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
    expect(existsSync(queuePath)).toBe(true);
    expect(readFileSync(queuePath, "utf8")).toBe(JSON.stringify([
      { id: "materialized", type: "summary_request", summary_path: summaryPath },
      { id: "missing", type: "summary_request", status: "processing", audio_path: join(dir, "gone.wav") },
      { id: "historical", type: "summary_request", status: "done" },
      { id: "event", type: "transcript" },
    ]));
    expect(existsSync(join(dir, "standard", "legacy-agent-queue", report!.archivePath))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "standard", "legacy-agent-queue", report!.archivePath), "utf8"))).toHaveLength(4);
    expect(JSON.parse(readFileSync(join(dir, "standard", "legacy-agent-queue", report!.auditPath), "utf8"))).toMatchObject({ version: 2, total: 4 });
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
    const report = migrateQueue({
      queuePath,
      archiveDir: join(dir, "standard", "legacy-agent-queue"),
    });

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
    expect(() => migrateQueue({
      queuePath,
      archiveDir: join(dir, "standard", "legacy-agent-queue"),
    })).toThrow();
    expect(readFileSync(queuePath, "utf8")).toBe("{not-json");
  });
});
