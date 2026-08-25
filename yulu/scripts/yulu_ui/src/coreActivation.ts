import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import type { ArtifactStore } from "./artifactStore.js";
import type {
  CoreActivationCandidate,
  CoreActivationEvidence,
} from "./hostStore.js";

function hasAudioFrames(content: Buffer): boolean {
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

function hasProviderProvenance(candidate: CoreActivationCandidate): boolean {
  const { task, artifacts, transcriptionProvider } = candidate;
  const summary = artifacts.find((artifact) => artifact.kind === "summary");
  if (!summary || !transcriptionProvider?.trim() || !task.summaryProvider.trim() || !task.summaryModel.trim()) {
    return false;
  }
  return task.summaryProvider === "xai"
    ? summary.provenance.summaryProvider === task.summaryProvider &&
        summary.provenance.summaryModel === task.summaryModel
    : summary.provenance.agentProvider === task.summaryProvider;
}

function isSameFile(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

export function verifiedCoreActivationEvidence(
  candidate: CoreActivationCandidate,
  artifactStore: ArtifactStore,
  moviesDir: string,
): CoreActivationEvidence | null {
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
    const audio = readFileSync(audioPath);
    if (!hasAudioFrames(audio)) return null;
    return {
      recordingStem: task.recordingStem,
      taskId: task.id,
      transcriptionProvider: transcriptionProvider!.trim(),
      summaryProvider: task.summaryProvider,
      summaryModel: task.summaryModel,
      artifacts: {
        audio: { sha256: createHash("sha256").update(audio).digest("hex"), bytes: audio.length },
        transcript: { sha256: transcript.sha256, bytes: transcript.bytes },
        summary: { sha256: summary.sha256, bytes: summary.bytes },
      },
      completedAt: task.updatedAt,
    };
  } catch {
    return null;
  }
}
