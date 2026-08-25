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
import { XAI_SUMMARY_DISCLOSURE_VERSION } from "../summaryDataDisclosure.js";
import {
  hasSupportedAgentSummaryIdentity,
  hasSupportedAgentSummaryReadinessProof,
} from "../summaryProviderReadiness.js";

const MICROPHONE_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const captureStatusSchema = z.object({
  micReady: z.boolean(),
  micError: z.string().optional(),
});

const audioDevicesSchema = z.object({
  input: z.array(z.object({ uid: z.string(), name: z.string() })),
  error: z.string().optional(),
});

const summaryDisclosureInput = z.object({
  provider: z.string().min(1).max(100),
  disclosureVersion: z.string().min(1).max(100),
  data: z.literal("transcript_text"),
  destination: z.string().min(1).max(200),
}).strict();

type SummaryBlockerReason =
  | "missing_credentials"
  | "invalid_model"
  | "provider_unavailable"
  | "disclosure_required"
  | "disclosure_declined"
  | "readiness_failed"
  | "readiness_required";

type SummaryBlockerCapability =
  | "summary_credentials"
  | "summary_model"
  | "summary_provider"
  | "summary_disclosure"
  | "summary_readiness";

const SUMMARY_SETTINGS = { href: "/settings/llm" } as const;

function summaryBlocker(
  capability: SummaryBlockerCapability,
  reason: SummaryBlockerReason,
  detail: string,
) {
  return { capability, reason, detail, remediation: SUMMARY_SETTINGS };
}

function summaryDisclosure(
  ctx: AppContext,
  provider: string,
  metadata: { disclosureVersion: string; data: "transcript_text"; destination: string },
) {
  const receipt = ctx.host.getSummaryDataPathDisclosure(provider);
  const current = receipt?.disclosureVersion === metadata.disclosureVersion;
  return {
    provider,
    ...metadata,
    acceptedDisclosureVersion: current && receipt.decision === "accepted" ? receipt.disclosureVersion : null,
    declined: current && receipt.decision === "declined",
    required: !current || receipt.decision !== "accepted",
  };
}

function validModel(model: string): boolean {
  return Boolean(model.trim()) && model.length <= 128;
}

function currentSummaryDisclosure(
  ctx: AppContext,
  input: z.infer<typeof summaryDisclosureInput>,
) {
  const summary = activationSummaryReadiness(ctx);
  const disclosure = summary.disclosure;
  if (
    !disclosure ||
    disclosure.provider !== input.provider ||
    disclosure.disclosureVersion !== input.disclosureVersion ||
    disclosure.data !== input.data ||
    disclosure.destination !== input.destination
  ) {
    throw new Error("The selected Summary Provider Data Path Disclosure changed; review it again");
  }
  return disclosure;
}

function activationSummaryReadiness(ctx: AppContext) {
  const selection = ctx.config.read().intelligence.summary;
  if (selection.provider === "xai") {
    const selected = { provider: "xai", model: selection.model };
    const disclosure = summaryDisclosure(ctx, "xai", {
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      data: "transcript_text",
      destination: "xAI",
    });
    const connection = ctx.xaiCredentials?.cachedStatus();
    const probe = ctx.xaiReadiness?.get("summary");
    const blocker = !validModel(selection.model)
      ? summaryBlocker("summary_model", "invalid_model", "The selected xAI summary model is invalid")
      : !ctx.xaiCredentials || !ctx.xaiReadiness
        ? summaryBlocker("summary_provider", "provider_unavailable", "The xAI summary provider is unavailable")
        : !connection?.connected || !connection.source
          ? summaryBlocker("summary_credentials", "missing_credentials", "xAI summary credentials are missing")
          : probe?.capability !== "summary" || probe.model !== selection.model || probe.credentialSource !== connection.source
            ? summaryBlocker("summary_readiness", "readiness_required", "The selected xAI summary capability has not passed its current probe")
            : probe.status === "failed"
              ? probe.reason === "invalid_model"
                ? summaryBlocker("summary_model", "invalid_model", probe.detail)
                : summaryBlocker("summary_readiness", "readiness_failed", probe.detail)
              : probe.status !== "ready"
                ? summaryBlocker("summary_readiness", "readiness_required", probe.detail)
                : disclosure.required
                  ? summaryBlocker(
                      "summary_disclosure",
                      disclosure.declined ? "disclosure_declined" : "disclosure_required",
                      "Transcript text disclosure is required before xAI summary processing",
                    )
                  : null;
    return {
      selected,
      state: blocker?.capability === "summary_disclosure" ? "disclosure_required" as const
        : blocker ? "blocked" as const : "ready" as const,
      detail: blocker?.detail ?? probe?.detail ?? null,
      credentialSource: connection?.source ?? null,
      testedAt: probe?.testedAt ?? null,
      disclosure,
      publicOnboardingSupported: true,
      remediation: blocker ? SUMMARY_SETTINGS : null,
      blocker,
    };
  }

  const adapter = ctx.supportedAgentSummaryAdapter;
  const result = adapter?.current();
  if (!result || !hasSupportedAgentSummaryIdentity(result)) {
    const blocker = summaryBlocker(
      "summary_provider",
      "provider_unavailable",
      "A Supported Agent summary adapter is not available in this release",
    );
    return {
      selected: { provider: "agent", model: selection.model },
      state: "blocked" as const,
      detail: blocker.detail,
      credentialSource: null,
      testedAt: null,
      disclosure: null,
      publicOnboardingSupported: false,
      remediation: SUMMARY_SETTINGS,
      blocker,
    };
  }

  const provider = result.provider.trim().toLowerCase();
  const disclosureMetadata = result.disclosure;
  const disclosure = disclosureMetadata?.kind === "external"
    ? summaryDisclosure(ctx, provider, disclosureMetadata)
    : null;
  const reason = result.reason ?? (result.status === "failed" ? "readiness_failed" : "readiness_required");
  const capability: SummaryBlockerCapability = reason === "missing_credentials"
    ? "summary_credentials"
    : reason === "invalid_model"
      ? "summary_model"
      : reason === "provider_unavailable"
        ? "summary_provider"
        : "summary_readiness";
  const blocker = result.status === "ready" && !hasSupportedAgentSummaryReadinessProof(result)
    ? summaryBlocker("summary_readiness", "readiness_failed", "The Supported Agent did not return current readiness proof")
    : result.status !== "ready"
    ? summaryBlocker(capability, reason, result.detail)
    : disclosure?.required
      ? summaryBlocker(
          "summary_disclosure",
          disclosure.declined ? "disclosure_declined" : "disclosure_required",
          "Transcript text disclosure is required before Agent summary processing",
        )
      : null;
  return {
    selected: { provider, model: result.model },
    state: blocker?.capability === "summary_disclosure" ? "disclosure_required" as const
      : blocker ? "blocked" as const : "ready" as const,
    detail: blocker?.detail ?? result.detail,
    credentialSource: result.credentialSource,
    testedAt: result.testedAt,
    disclosure,
    publicOnboardingSupported: true,
    remediation: blocker ? SUMMARY_SETTINGS : null,
    blocker,
  };
}

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
  const summary = activationSummaryReadiness(ctx);
  const nextStep = !microphoneReady
    ? "microphone_permission" as const
    : !audioInputReady
      ? "audio_input" as const
      : transcriptionState !== "ready"
        ? "transcription" as const
        : summary.state !== "ready"
          ? "summary_provider" as const
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
  } : transcriptionState === "disclosure_required" ? null : summary.blocker;

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
      summary: {
        selected: summary.selected,
        state: summary.state,
        detail: summary.detail,
        credentialSource: summary.credentialSource,
        testedAt: summary.testedAt,
        disclosure: summary.disclosure,
        publicOnboardingSupported: summary.publicOnboardingSupported,
        remediation: summary.remediation,
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
  acceptSummaryDataPathDisclosure: publicProcedure.input(summaryDisclosureInput).mutation(({ ctx, input }) => {
    const disclosure = currentSummaryDisclosure(ctx, input);
    return ctx.host.recordSummaryDataPathDisclosure(
      disclosure.provider,
      disclosure.disclosureVersion,
    );
  }),
  declineSummaryDataPathDisclosure: publicProcedure.input(summaryDisclosureInput).mutation(({ ctx, input }) => {
    const disclosure = currentSummaryDisclosure(ctx, input);
    return ctx.host.declineSummaryDataPathDisclosure(
      disclosure.provider,
      disclosure.disclosureVersion,
    );
  }),
  probeSummaryProvider: publicProcedure.mutation(async ({ ctx }) => {
    if (ctx.config.read().intelligence.summary.provider !== "agent") {
      throw new Error("The selected xAI Summary Provider uses the xAI capability probe");
    }
    if (!ctx.supportedAgentSummaryAdapter) throw new Error("A Supported Agent summary adapter is unavailable");
    return await ctx.supportedAgentSummaryAdapter.probe();
  }),
});
