import { publicProcedure, router } from "../trpc.js";

function manager(ctx: { localCaption?: import("../localCaptionManager.js").LocalCaptionManager }) {
  if (!ctx.localCaption) throw new Error("本地实时转录管理器不可用");
  return ctx.localCaption;
}

export const localCaptionRouter = router({
  status: publicProcedure.query(({ ctx }) => manager(ctx).status()),
  install: publicProcedure.mutation(async ({ ctx }) => await manager(ctx).install()),
  uninstall: publicProcedure.mutation(async ({ ctx }) => await manager(ctx).uninstall()),
  test: publicProcedure.mutation(async ({ ctx }) => await manager(ctx).test()),
});
