import { createHash } from "node:crypto";
import { createReadStream, closeSync, existsSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type { ArtifactStore } from "./artifactStore.js";
import type {
  CoreActivationCandidate,
  CoreActivationEvidence,
} from "./hostStore.js";

export function hasAudioFrames(content: Buffer): boolean {
  if (
    content.length < 44 ||
    content.subarray(0, 4).toString("ascii") !== "RIFF" ||
    content.subarray(8, 12).toString("ascii") !== "WAVE"
  ) return false;
  let offset = 12;
  while (offset + 8 <= content.length) {
    const chunkSize = content.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    if (content.subarray(offset, offset + 4).toString("ascii") === "data") {
      return chunkSize > 0 && dataStart + chunkSize <= content.length;
    }
    offset = dataStart + chunkSize + (chunkSize % 2);
  }
  return false;
}

export function hasAudioFramesAtPath(path: string): boolean {
  let fd: number | null = null;
  try {
    const size = statSync(path).size;
    if (size < 44) return false;
    fd = openSync(path, "r");
    const header = Buffer.alloc(12);
    if (readSync(fd, header, 0, header.length, 0) < header.length) return false;
    if (
      header.subarray(0, 4).toString("ascii") !== "RIFF" ||
      header.subarray(8, 12).toString("ascii") !== "WAVE"
    ) return false;
    let offset = 12;
    const chunkHeader = Buffer.alloc(8);
    while (offset + chunkHeader.length <= size) {
      if (readSync(fd, chunkHeader, 0, chunkHeader.length, offset) < chunkHeader.length) return false;
      const chunkSize = chunkHeader.readUInt32LE(4);
      const dataStart = offset + chunkHeader.length;
      if (chunkHeader.subarray(0, 4).toString("ascii") === "data") {
        return chunkSize > 0 && dataStart + chunkSize <= size;
      }
      offset = dataStart + chunkSize + (chunkSize % 2);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function hasProviderProvenance(candidate: CoreActivationCandidate): boolean {
  const { task, artifacts, transcriptionProvider } = candidate;
  const summary = artifacts.find((artifact) => artifact.kind === "summary");
  if (!summary || !transcriptionProvider?.trim() || !task.summaryProvider.trim() || !task.summaryModel.trim()) {
    return false;
  }
  const summaryIdentityMatches = summary.provenance.summaryProvider === task.summaryProvider &&
    summary.provenance.summaryModel === task.summaryModel;
  if (task.summaryProvider === "xai") return summaryIdentityMatches;
  if (summary.provenance.agentProvider !== task.summaryProvider) return false;
  if (summaryIdentityMatches) return true;
  return task.summaryProvider === "hermes" &&
    summary.provenance.summaryProvider === undefined && summary.provenance.summaryModel === undefined;
}

function isSameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

async function audioFingerprint(path: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { sha256: hash.digest("hex"), bytes };
}

export async function verifiedCoreActivationEvidence(
  candidate: CoreActivationCandidate,
  artifactStore: ArtifactStore,
  moviesDir: string,
): Promise<CoreActivationEvidence | null> {
  const { task, artifacts, transcriptionProvider } = candidate;
  const transcript = artifacts.find((artifact) => artifact.kind === "transcript");
  const summary = artifacts.find((artifact) => artifact.kind === "summary");
  const audioPath = join(moviesDir, `${task.recordingStem}.wav`);
  if (
    !transcript || !summary || !hasProviderProvenance(candidate) ||
    basename(task.recordingStem) !== task.recordingStem ||
    !existsSync(audioPath) || !isSameFile(task.audioPath, audioPath) ||
    existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))
  ) return null;
  try {
    artifactStore.readCommittedTranscript(task, transcript);
    artifactStore.readCommittedSummary(task, summary);
    if (!hasAudioFramesAtPath(audioPath)) return null;
    const audio = await audioFingerprint(audioPath);
    return {
      recordingStem: task.recordingStem,
      taskId: task.id,
      transcriptionProvider: transcriptionProvider!.trim(),
      summaryProvider: task.summaryProvider,
      summaryModel: task.summaryModel,
      artifacts: {
        audio,
        transcript: { sha256: transcript.sha256, bytes: transcript.bytes },
        summary: { sha256: summary.sha256, bytes: summary.bytes },
      },
      completedAt: task.updatedAt,
    };
  } catch {
    return null;
  }
}
