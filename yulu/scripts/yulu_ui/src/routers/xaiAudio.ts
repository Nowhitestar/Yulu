import { publicProcedure, router } from "../trpc.js";

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
    .mutation(async ({ ctx }) => await credentials(ctx).authorize()),
  cancelAuthorization: publicProcedure
    .mutation(({ ctx }) => credentials(ctx).cancelAuthorization()),
  logout: publicProcedure
    .mutation(async ({ ctx }) => await credentials(ctx).logout()),
  test: publicProcedure
    .mutation(async ({ ctx }) => await audio(ctx).testXai()),
});
