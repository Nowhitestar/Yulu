import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const configRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.config.read()),

  update: publicProcedure
    .input(z.object({
      key: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/i),
      value: z.unknown(),
    }))
    .mutation(({ ctx, input }) => ctx.config.update(input.key, input.value)),
});
