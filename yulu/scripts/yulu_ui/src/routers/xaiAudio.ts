import { z } from "zod";
import { publicProcedure, router } from "../trpc.js";

const SourceSchema = z.enum(["hermes", "openclaw"]);

function credentials(ctx: { xaiCredentials?: import("../xaiCredentials.js").XaiCredentialManager }) {
  if (!ctx.xaiCredentials) throw new Error("xAI OAuth 管理器不可用");
  return ctx.xaiCredentials;
}

function audio(ctx: { audioTranscription?: import("../audioTranscription.js").AudioTranscriptionService }) {
  if (!ctx.audioTranscription) throw new Error("Yulu 音频转写服务不可用");
  return ctx.audioTranscription;
}

export const xaiAudioRouter = router({
  status: publicProcedure.query(async ({ ctx }) => await credentials(ctx).status()),
  authorize: publicProcedure
    .input(z.object({ source: SourceSchema }))
    .mutation(({ ctx, input }) => credentials(ctx).startAuthorization(input.source)),
  test: publicProcedure
    .input(z.object({ source: z.enum(["auto", "hermes", "openclaw"]) }))
    .mutation(async ({ ctx, input }) => await audio(ctx).testXai(input.source)),
});
