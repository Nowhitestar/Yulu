import { createHash } from "node:crypto";
import {
  existsSync,
  fstatSync,
  fsyncSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";

type LegacyEntry = Record<string, unknown>;

export interface LegacyQueueMigrationItem {
  legacyId: string;
  action: "already_materialized" | "retired_pending" | "unresolvable" | "archived";
  audioPath?: string;
  outputPath?: string;
  reason?: string;
}

export interface LegacyQueueMigrationReport {
  version: 2;
  migratedAt: string;
  sourcePath: string;
  archivePath: string;
  auditPath: string;
  total: number;
  actionable: number;
  alreadyMaterialized: number;
  retiredPending: number;
  unresolvable: number;
  archived: number;
  items: LegacyQueueMigrationItem[];
}

function field(entry: LegacyEntry, ...names: string[]): string {
  for (const name of names) {
    const value = entry[name];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function legacyId(entry: LegacyEntry, index: number): string {
  const explicit = field(entry, "id");
  if (explicit) return explicit;
  return createHash("sha256")
    .update(`${index}\0${JSON.stringify(entry)}`)
    .digest("hex");
}

function isActionable(entry: LegacyEntry): boolean {
  if (field(entry, "type") !== "summary_request") return false;
  const status = field(entry, "status").toLowerCase() || "pending";
  return status === "pending" || status === "processing";
}

function isFile(path: string): boolean {
  if (!path || !existsSync(path)) return false;
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function requirePrivateOutputDescriptor(descriptor: number, name: string): void {
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new Error(`${name} descriptor is invalid`);
  }
  const metadata = fstatSync(descriptor);
  if (!metadata.isFile()
      || metadata.size !== 0
      || metadata.nlink !== 1
      || (metadata.mode & 0o777) !== 0o600
      || (process.geteuid !== undefined && metadata.uid !== process.geteuid())) {
    throw new Error(`${name} descriptor is unsafe`);
  }
}

function writeOutputDescriptor(descriptor: number, content: string): void {
  writeFileSync(descriptor, content, { encoding: "utf8" });
  fsyncSync(descriptor);
}

/**
 * One-way retirement bridge for the pre-Host JSON Agent queue.
 *
 * The original file is never deleted. Pending entries are archived, not
 * executed: silently replaying an old queue during upgrade can export many
 * historical recordings to the Agent's STT provider and block new work. Users
 * can explicitly reprocess any preserved recording from the current UI.
 */
export function migrateLegacyAgentQueue(input: {
  queueFD: number | null;
  archiveFD: number | null;
  auditFD: number | null;
  sourcePath: string;
  archiveName: string;
  auditName: string;
  now?: Date;
}): LegacyQueueMigrationReport | null {
  if (input.queueFD === null) return null;
  if (!Number.isSafeInteger(input.queueFD) || input.queueFD < 0) {
    throw new Error("legacy Agent queue descriptor is invalid");
  }
  const metadata = fstatSync(input.queueFD);
  if (!metadata.isFile()
      || metadata.size < 0
      || metadata.size > 16 * 1024 * 1024
      || (process.geteuid !== undefined && metadata.uid !== process.geteuid())) {
    throw new Error("legacy Agent queue descriptor is unsafe");
  }
  if (input.archiveFD === null || input.auditFD === null) {
    throw new Error("legacy Agent queue output descriptors are missing");
  }
  requirePrivateOutputDescriptor(input.archiveFD, "legacy Agent queue archive");
  requirePrivateOutputDescriptor(input.auditFD, "legacy Agent queue audit");

  const raw = readFileSync(input.queueFD, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("legacy Agent queue must contain a JSON array");
  const entries = parsed.filter((value): value is LegacyEntry => (
    typeof value === "object" && value !== null && !Array.isArray(value)
  ));

  const timestamp = input.now ?? new Date();
  const items: LegacyQueueMigrationItem[] = [];

  for (const [index, entry] of entries.entries()) {
    const id = legacyId(entry, index);
    if (!isActionable(entry)) {
      items.push({ legacyId: id, action: "archived" });
      continue;
    }

    const outputPath = field(entry, "summary_path", "summaryPath");
    if (isFile(outputPath)) {
      items.push({
        legacyId: id,
        action: "already_materialized",
        ...(outputPath ? { outputPath } : {}),
      });
      continue;
    }

    const audioPath = field(entry, "audio_path", "audioPath");
    if (!isFile(audioPath)) {
      items.push({
        legacyId: id,
        action: "unresolvable",
        ...(audioPath ? { audioPath } : {}),
        ...(outputPath ? { outputPath } : {}),
        reason: audioPath ? "recording audio is missing" : "legacy task has no recording audio path",
      });
      continue;
    }

    items.push({
      legacyId: id,
      action: "retired_pending",
      audioPath,
      ...(outputPath ? { outputPath } : {}),
      reason: "retired without execution; reprocess explicitly from the current Yulu UI if still needed",
    });
  }

  const count = (action: LegacyQueueMigrationItem["action"]) => (
    items.filter((item) => item.action === action).length
  );
  const report: LegacyQueueMigrationReport = {
    version: 2,
    migratedAt: timestamp.toISOString(),
    sourcePath: input.sourcePath,
    archivePath: input.archiveName,
    auditPath: input.auditName,
    total: entries.length,
    actionable: items.length - count("archived"),
    alreadyMaterialized: count("already_materialized"),
    retiredPending: count("retired_pending"),
    unresolvable: count("unresolvable"),
    archived: count("archived"),
    items,
  };

  writeOutputDescriptor(input.archiveFD, raw);
  writeOutputDescriptor(input.auditFD, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}
