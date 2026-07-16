import { describe, expect, it, vi } from "vitest";
import { createCaller } from "../../src/trpc.js";
import { localCaptionRouter } from "../../src/routers/localCaption.js";

describe("localCaption router", () => {
  it("exposes model state and delegates lifecycle actions", async () => {
    const state = { installed: true, ready: true, operation: "idle" };
    const localCaption = {
      status: vi.fn(() => state),
      install: vi.fn(async () => state),
      uninstall: vi.fn(async () => ({ ...state, installed: false, ready: false })),
      test: vi.fn(async () => ({ ok: true, provider: "sherpa", loadMs: 12 })),
    };
    const caller = createCaller(localCaptionRouter, { localCaption } as never);

    await expect(caller.status()).resolves.toEqual(state);
    await expect(caller.install()).resolves.toEqual(state);
    await expect(caller.test()).resolves.toMatchObject({ ok: true, provider: "sherpa" });
    await expect(caller.uninstall()).resolves.toMatchObject({ installed: false });
    expect(localCaption.install).toHaveBeenCalledOnce();
    expect(localCaption.uninstall).toHaveBeenCalledOnce();
  });
});
