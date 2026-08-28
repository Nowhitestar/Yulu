import { execFile } from "node:child_process";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import { RecordingPipelinePolicyDisabledError } from "./recordingPipeline.js";
import type { ActivationSummarySnapshot } from "./hostStore.js";
import type { AppContext } from "./trpc.js";

const exec = promisify(execFile) as (
  cmd: string,
  args: string[],
  opts?: object,
) => Promise<{ stdout: string; stderr: string }>;

export async function runRecordAudio(
  ctx: AppContext,
  args: string[],
  options: { timeoutMs?: number } = {},
) {
  const { stdout, stderr } = await exec("python3", [join(ctx.paths.scriptDir, "record_audio.py"), ...args], {
    env: {
      ...process.env,
      PYTHONPATH: ctx.paths.scriptDir,
      YULU_CONFIG_DIR: ctx.paths.configDir,
    },
    cwd: process.env.HOME,
    ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
  });
  return { ok: true as const, stdout, stderr };
}

export type RecordingStopResult = { ok: true; stdout: string; stderr: string };
export interface StoppedRecordingIdentity { audioPath: string; recordingStem: string }
export interface RecordingEnqueueOptions {
  activationAttemptId?: string;
  summarySnapshot?: ActivationSummarySnapshot;
}

function finalRecordingPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("FINAL_RECORDING_PATH=")) continue;
    const path = line.slice("FINAL_RECORDING_PATH=".length).trim();
    if (path) return path;
  }
  return undefined;
}

export async function stopRecordingAndEnqueue(
  ctx: AppContext,
  stopRecording: () => Promise<RecordingStopResult> = () => runRecordAudio(ctx, ["stop"]),
  onRecordingStopped?: (identity: StoppedRecordingIdentity) => void,
  options: RecordingEnqueueOptions = {},
) {
  const result = await stopRecording();
  const audioPath = finalRecordingPath(result.stdout);
  if (!audioPath) throw new Error("recording stopped but FINAL_RECORDING_PATH was missing");
  const recordingStem = basename(audioPath, extname(audioPath));
  onRecordingStopped?.({ audioPath, recordingStem });
  const sendToNotion = false;
  let enqueued;
  try {
    enqueued = ctx.recordingPipeline.enqueueCompletion({
      audioPath,
      ...(options.activationAttemptId ? { activationAttemptId: options.activationAttemptId } : {}),
      ...(options.summarySnapshot ? { summarySnapshot: options.summarySnapshot } : {}),
    });
  } catch (error) {
    if (error instanceof RecordingPipelinePolicyDisabledError) {
      return {
        ...result,
        pipeline: {
          accepted: false as const,
          permanent: true as const,
          reason: error.message,
          sendToNotion,
        },
      };
    }
    throw error;
  }
  return {
    ...result,
    pipeline: {
      accepted: true as const,
      taskId: enqueued.task.id,
      recordingStem: enqueued.task.recordingStem,
      state: enqueued.task.state,
      created: enqueued.created,
      sendToNotion,
    },
  };
}
