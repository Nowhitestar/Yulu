import { describe, it, expect } from "vitest";
import { router, publicProcedure, createCaller, type AppContext } from "../src/trpc.js";

describe("tRPC scaffolding", () => {
  it("exports router + publicProcedure + createCaller", async () => {
    const r = router({
      ping: publicProcedure.query(() => "pong"),
    });
    const caller = createCaller(r, {} as AppContext);
    await expect(caller.ping()).resolves.toBe("pong");
  });
});
