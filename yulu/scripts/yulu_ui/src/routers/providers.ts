import { z } from "zod";
import { XAI_TEXT_MODEL_DEFAULT } from "../config.js";
import {
  hasCurrentXaiSummaryDisclosure,
  XAI_SUMMARY_DISCLOSURE_VERSION,
} from "../summaryDataDisclosure.js";
import {
  hasCurrentXaiTranscriptionConsent,
  XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
} from "../transcriptionConsent.js";
import type { XaiCredentialSource } from "../xaiCredentials.js";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";

export type XaiCapability = "transcription" | "summary" | "conversation";
export type XaiReadinessStatus = "untested" | "testing" | "ready" | "failed";

export interface XaiReadinessResult {
  capability: XaiCapability;
  status: XaiReadinessStatus;
  model: string;
  testedAt: string | null;
  detail: string;
  credentialSource: XaiCredentialSource | null;
  reason?: "invalid_model" | "readiness_failed";
}

export type XaiProviderReadiness = Map<XaiCapability, XaiReadinessResult>;

export function createXaiProviderReadiness(): XaiProviderReadiness {
  return new Map();
}

function services(ctx: AppContext) {
  if (!ctx.xaiCredentials || !ctx.audioTranscription || !ctx.xaiText || !ctx.xaiReadiness) {
    throw new Error("xAI 提供商服务不可用");
  }
  return {
    credentials: ctx.xaiCredentials,
    audio: ctx.audioTranscription,
    text: ctx.xaiText,
    readiness: ctx.xaiReadiness,
  };
}

function configuredModel(ctx: AppContext, capability: XaiCapability): string {
  if (capability === "transcription") return "speech-to-text";
  const selection = ctx.config.read().intelligence[capability];
  return selection.provider === "xai" ? selection.model : XAI_TEXT_MODEL_DEFAULT;
}

function untested(capability: XaiCapability, model: string): XaiReadinessResult {
  return {
    capability,
    status: "untested",
    model,
    testedAt: null,
    detail: "尚未测试",
    credentialSource: null,
  };
}

function projection(
  ctx: AppContext,
  readiness: XaiProviderReadiness,
  source: XaiCredentialSource | null,
): Record<XaiCapability, XaiReadinessResult> {
  return Object.fromEntries((["transcription", "summary", "conversation"] as const).map((capability) => {
    const model = configuredModel(ctx, capability);
    const current = readiness.get(capability);
    const result = current?.model === model && current.credentialSource === source
      ? current
      : untested(capability, model);
    return [capability, result];
  })) as Record<XaiCapability, XaiReadinessResult>;
}

function clearReadiness(ctx: AppContext): void {
  ctx.xaiReadiness?.clear();
}

const ProbeInput = z.object({
  capability: z.enum(["transcription", "summary", "conversation"]),
}).strict();

const DataPathDisclosureInput = z.object({
  capability: z.enum(["transcription", "summary"]),
}).strict();

function dataPathDisclosures(ctx: AppContext) {
  const config = ctx.config.read();
  return {
    transcription: {
      required: config.transcription.engine === "xai"
        && !hasCurrentXaiTranscriptionConsent(ctx.host),
      disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
      data: "recording_audio" as const,
      destination: "xAI" as const,
    },
    summary: {
      required: config.intelligence.summary.provider === "xai"
        && !hasCurrentXaiSummaryDisclosure(ctx.host),
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      data: "transcript_text" as const,
      destination: "xAI" as const,
    },
  };
}

export const providersRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    if (ctx.agentConnections) return await ctx.agentConnections.xaiProjection();
    const { credentials, readiness } = services(ctx);
    const connection = await credentials.status();
    return {
      connection,
      readiness: projection(ctx, readiness, connection.source),
      disclosures: dataPathDisclosures(ctx),
    };
  }),

  acceptDataPathDisclosure: uiMutationProcedure
    .input(DataPathDisclosureInput)
    .mutation(({ ctx, input }) => {
      if (ctx.agentConnections) {
        return ctx.agentConnections.acceptDisclosure({ connectionId: "direct-xai", capability: input.capability });
      }
      if (input.capability === "transcription") {
        const receipt = ctx.host.recordCloudTranscriptionConsent(
          XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
        );
        return {
          capability: input.capability,
          accepted: true,
          disclosureVersion: receipt.disclosureVersion,
        };
      }
      const receipt = ctx.host.recordSummaryDataPathDisclosure(
        "xai",
        XAI_SUMMARY_DISCLOSURE_VERSION,
      );
      return {
        capability: input.capability,
        accepted: true,
        disclosureVersion: receipt.disclosureVersion,
      };
    }),

  authorize: uiMutationProcedure.mutation(async ({ ctx }) => {
    if (ctx.agentConnections) return await ctx.agentConnections.authorize();
    clearReadiness(ctx);
    return await services(ctx).credentials.authorize();
  }),

  cancelAuthorization: uiMutationProcedure.mutation(({ ctx }) =>
    ctx.agentConnections
      ? ctx.agentConnections.cancelAuthorization()
      : services(ctx).credentials.cancelAuthorization()),

  logoutOAuth: uiMutationProcedure.mutation(async ({ ctx }) => {
    if (ctx.agentConnections) return await ctx.agentConnections.logoutOAuth();
    const { credentials } = services(ctx);
    await credentials.logout();
    clearReadiness(ctx);
    return await credentials.status();
  }),

  setApiKey: uiMutationProcedure
    .input(z.object({ apiKey: z.string().trim().min(1).max(4_096) }).strict())
    .mutation(async ({ ctx, input }) => {
      if (ctx.agentConnections) return await ctx.agentConnections.setApiKey(input.apiKey);
      clearReadiness(ctx);
      return await services(ctx).credentials.setApiKey(input.apiKey);
    }),

  clearApiKey: uiMutationProcedure.mutation(async ({ ctx }) => {
    if (ctx.agentConnections) return await ctx.agentConnections.clearApiKey();
    clearReadiness(ctx);
    return await services(ctx).credentials.clearApiKey();
  }),

  probe: uiMutationProcedure.input(ProbeInput).mutation(async ({ ctx, input }) => {
    if (ctx.agentConnections) {
      return await ctx.agentConnections.probe({ connectionId: "direct-xai", capability: input.capability });
    }
    const { credentials, audio, text, readiness } = services(ctx);
    const capability = input.capability;
    const model = configuredModel(ctx, capability);
    const connection = await credentials.status();
    const started: XaiReadinessResult = {
      capability,
      status: "testing",
      model,
      testedAt: null,
      detail: "正在测试",
      credentialSource: connection.source,
    };
    readiness.set(capability, started);
    if (!connection.connected || !connection.source) {
      const failed: XaiReadinessResult = {
        ...started,
        status: "failed",
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} 测试失败，请先连接 xAI 后重试`,
      };
      readiness.set(capability, failed);
      return failed;
    }
    try {
      let credentialSource: XaiCredentialSource;
      if (capability === "transcription") {
        const result = await audio.testXai();
        credentialSource = result.credentialSource ?? connection.source;
      } else {
        const result = await text.request({
          capability,
          model,
          input: capability === "summary"
            ? [
                { role: "system", content: "Return one short acknowledgement." },
                { role: "user", content: "Yulu xAI summary capability probe." },
              ]
            : [
                { role: "system", content: "Return one short acknowledgement." },
                { role: "user", content: "Yulu xAI conversation capability probe." },
              ],
          maxOutputTokens: 32,
        });
        credentialSource = result.credentialSource;
      }
      const ready: XaiReadinessResult = {
        capability,
        status: "ready",
        model,
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} 已通过真实请求测试`,
        credentialSource,
      };
      readiness.set(capability, ready);
      return ready;
    } catch (error) {
      const reason = /\(HTTP 404\)/.test(error instanceof Error ? error.message : "")
        ? "invalid_model" as const
        : "readiness_failed" as const;
      const failed: XaiReadinessResult = {
        ...started,
        status: "failed",
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} 测试失败，请检查账号权限或模型设置后重试`,
        reason,
      };
      readiness.set(capability, failed);
      return failed;
    }
  }),
});
