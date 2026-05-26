import { describe, it, expect } from "vitest";
import { systemRouter } from "../../src/routers/system.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

describe("systemRouter", () => {
  it("version() returns the yulu_ui package version", async () => {
    const caller = createCaller(systemRouter, {} as AppContext);
    const v = await caller.version();
    expect(v.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(v.name).toBe("yulu-ui");
  });
});
