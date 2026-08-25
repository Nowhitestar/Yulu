import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { verifiedCoreActivationEvidence } from "../coreActivation.js";
import { ipcSend } from "../ipc.js";
import {
  hasCurrentXaiTranscriptionConsent,
  XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
} from "../transcriptionConsent.js";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router } from "../trpc.js";

const MICROPHONE_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const captureStatusSchema = z.object({
  micReady: z.boolean(),
  micError: z.string().optional(),
});

const audioDevicesSchema = z.object({
  input: z.array(z.object({ uid: z.string(), name: z.string() })),
  error: z.string().optional(),
});

async function activationReadiness(ctx: AppContext) {
  const [captureResult, devicesResult] = await Promise.allSettled([
    ipcSend(ctx.paths.audioDaemonSock, { action: "status" }),
    ipcSend(ctx.paths.audioDaemonSock, { action: "audio_devices" }),
  ]);
  const capture = captureResult.status === "fulfilled"
    ? captureStatusSchema.safeParse(captureResult.value)
    : null;
  const devices = devicesResult.status === "fulfilled"
    ? audioDevicesSchema.safeParse(devicesResult.value)
    : null;
  const microphoneReady = capture?.success === true && capture.data.micReady;
  const microphoneDetail = capture?.success
    ? capture.data.micError || null
    : captureResult.status === "rejected"
      ? String(captureResult.reason)
      : "Audio daemon returned an invalid microphone status";

  const configuredInputValue = ctx.config.read().audio.mic_device?.trim() || null;
  const configuredInput = configuredInputValue?.startsWith(":") ? null : configuredInputValue;
  const availableInputs = devices?.success ? devices.data.input : [];
  const audioInputReady = configuredInput
    ? availableInputs.some((device) => device.uid === configuredInput)
    : availableInputs.length > 0;
  const audioInputDetail = audioInputReady
    ? null
    : devices?.success
      ? configuredInput
        ? `Selected audio input is unavailable: ${configuredInput}`
        : devices.data.error || "No audio input is available"
      : devicesResult.status === "rejected"
        ? String(devicesResult.reason)
        : "Audio daemon returned an invalid device list";

  const selected = ctx.config.read().transcription.engine;
  const localStatus = ctx.localCaption?.status();
  const local = {
    available: localStatus?.installed === true,
    ready: localStatus?.ready === true,
    provider: localStatus?.provider ?? "local",
    detail: localStatus?.ready ? null : localStatus?.error || "Local transcription is not ready",
  };
  const xaiConnection = ctx.xaiCredentials?.cachedStatus();
  const xaiProbe = ctx.xaiReadiness?.get("transcription");
  const xaiReady = xaiConnection?.connected === true && xaiConnection.source !== null &&
    xaiProbe?.status === "ready" && xaiProbe.model === "speech-to-text" &&
    xaiProbe.credentialSource === xaiConnection.source;
  const receipt = ctx.host.getCloudTranscriptionConsent();
  const disclosureRequired = !hasCurrentXaiTranscriptionConsent(ctx.host);
  const xai = {
    ready: xaiReady,
    detail: xaiReady ? null : xaiProbe?.detail || xaiConnection?.detail || "xAI transcription is not ready",
    disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
    acceptedDisclosureVersion: receipt?.disclosureVersion ?? null,
    disclosureRequired,
  };
  const transcriptionState = selected === "local"
    ? local.ready ? "ready" as const : "blocked" as const
    : disclosureRequired ? "disclosure_required" as const : xai.ready ? "ready" as const : "blocked" as const;
  const nextStep = !microphoneReady
    ? "microphone_permission" as const
    : !audioInputReady
      ? "audio_input" as const
      : transcriptionState !== "ready"
        ? "transcription" as const
        : null;
  const blocker = !microphoneReady ? {
    capability: "microphone_permission" as const,
    detail: microphoneDetail,
    remediation: { href: MICROPHONE_SETTINGS },
  } : !audioInputReady ? {
    capability: "audio_input" as const,
    detail: audioInputDetail,
    remediation: { href: "/settings/general" },
  } : transcriptionState === "blocked" ? {
    capability: selected === "local" ? "local_transcription" as const : "xai_transcription" as const,
    detail: selected === "local" ? local.detail : xai.detail,
    remediation: { href: "/settings/transcription" },
  } : null;

  return {
    nextStep,
    blocker,
    readiness: {
      microphonePermission: {
        state: microphoneReady ? "ready" as const : "blocked" as const,
        detail: microphoneDetail,
        remediation: microphoneReady ? null : { href: MICROPHONE_SETTINGS },
      },
      audioInput: {
        state: audioInputReady ? "ready" as const : "blocked" as const,
        selectedDeviceUid: configuredInput,
        detail: audioInputDetail,
        remediation: audioInputReady ? null : { href: "/settings/general" },
      },
      transcription: {
        selected,
        state: transcriptionState,
        local,
        xai,
        remediation: transcriptionState === "blocked" ? { href: "/settings/transcription" } : null,
      },
    },
  };
}

function journeyState(ctx: { host: {
  getActivationJourneyState: () => {
    automaticEntryAcknowledgedAt: string | null;
    deferredAt: string | null;
  };
} }) {
  const state = ctx.host.getActivationJourneyState();
  return {
    ...state,
    shouldAutoEnter: state.automaticEntryAcknowledgedAt === null && state.deferredAt === null,
  };
}

export const activationRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    let evidence = ctx.host.getCoreActivationEvidence();
    if (!evidence) {
      for (const candidate of ctx.host.listCoreActivationCandidates()) {
        const verified = verifiedCoreActivationEvidence(candidate, ctx.artifacts, ctx.paths.moviesDir);
        if (verified) {
          evidence = ctx.host.recordCoreActivationEvidence(verified);
          break;
        }
      }
    }
    if (!evidence) return {
      state: "unresolved" as const,
      evidence: null,
      journey: journeyState(ctx),
      ...await activationReadiness(ctx),
    };
    const safeStem = basename(evidence.recordingStem) === evidence.recordingStem;
    const sourceArtifactAvailable = safeStem && existsSync(join(ctx.paths.moviesDir, `${evidence.recordingStem}.wav`));
    let completedNote: string | null = null;
    if (safeStem) {
      const summaryPath = join(ctx.paths.moviesDir, `${evidence.recordingStem}.summary.md`);
      if (existsSync(summaryPath)) {
        try {
          completedNote = readFileSync(summaryPath, "utf8").trim() || null;
        } catch { /* a missing or unreadable note is not an available action */ }
      }
    }
    return {
      state: "activated" as const,
      evidence,
      sourceArtifactAvailable,
      completedNoteAvailable: completedNote !== null,
      completedNote,
    };
  }),
  acknowledgeAutomaticEntry: publicProcedure.mutation(({ ctx }) => {
    const result = ctx.host.acknowledgeAutomaticActivationEntry();
    return {
      acknowledged: result.acknowledged,
      journey: {
        ...result.state,
        shouldAutoEnter: false,
      },
    };
  }),
  defer: publicProcedure.mutation(({ ctx }) => {
    const state = ctx.host.deferActivationJourney();
    return {
      journey: {
        ...state,
        shouldAutoEnter: false,
      },
    };
  }),
  acceptXaiTranscriptionDisclosure: publicProcedure.mutation(({ ctx }) =>
    ctx.host.recordCloudTranscriptionConsent(XAI_TRANSCRIPTION_DISCLOSURE_VERSION)),
});
