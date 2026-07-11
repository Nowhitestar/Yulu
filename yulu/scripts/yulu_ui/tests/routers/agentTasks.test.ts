import { describe, expect, it, vi } from "vitest";
import { agentTasksRouter } from "../../src/routers/agentTasks.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

describe("agentTasksRouter", () => {
  it("returns durable task details and delegates retry to the pipeline", async () => {
    const task = { id: "019f0000-0000-7000-8000-000000000001", state: "failed", leaseToken: "secret-lease" };
    const retry = vi.fn(() => ({ ...task, state: "queued" }));
    const ctx = {
      recordingPipeline: {
        list: () => [task],
        get: () => task,
        retry,
        transcriptionHealth: () => ({ available: true, provider: "hermes", reason: null }),
      },
      host: {
        listArtifacts: () => [{ kind: "summary" }],
        getNotionDelivery: () => null,
        listEvents: () => [{ type: "task.failed" }],
      },
    } as unknown as AppContext;
    const caller = createCaller(agentTasksRouter, ctx);
    expect(await caller.transcriptionHealth()).toEqual({ available: true, provider: "hermes", reason: null });
    const listed = await caller.list({ limit: 5 });
    expect(listed).toEqual([{ id: task.id, state: "failed" }]);
    expect(listed[0]).not.toHaveProperty("leaseToken");
    const detail = await caller.get({ id: task.id });
    expect(detail).toMatchObject({
      id: task.id,
      artifacts: [{ kind: "summary" }],
      events: [{ type: "task.failed" }],
    });
    expect(detail).not.toHaveProperty("leaseToken");
    expect(await caller.retry({ id: task.id })).toMatchObject({ state: "queued" });
    expect(retry).toHaveBeenCalledWith(task.id);
  });

  it("rejects retry when the durable state machine does not allow it", async () => {
    const id = "019f0000-0000-7000-8000-000000000002";
    const ctx = {
      recordingPipeline: {
        retry: () => { throw new Error(`task ${id} cannot retry from delivery_unverified`); },
      },
    } as unknown as AppContext;
    const caller = createCaller(agentTasksRouter, ctx);

    await expect(caller.retry({ id })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message: `task ${id} cannot retry from delivery_unverified`,
    });
  });

  it("exposes explicit confirm and abandon actions for uncertain Notion delivery", async () => {
    const id = "019f0000-0000-7000-8000-000000000003";
    const confirmNotionDelivery = vi.fn(() => ({ id, state: "completed", leaseToken: null }));
    const abandonNotionDelivery = vi.fn(() => ({ id, state: "cancelled", leaseToken: null }));
    const ctx = {
      recordingPipeline: { confirmNotionDelivery, abandonNotionDelivery },
    } as unknown as AppContext;
    const caller = createCaller(agentTasksRouter, ctx);

    await expect(caller.confirmNotionDelivery({
      id,
      url: "https://app.notion.com/p/0123456789abcdef0123456789abcdef",
    })).resolves.toMatchObject({ state: "completed" });
    await expect(caller.abandonNotionDelivery({ id })).resolves.toMatchObject({ state: "cancelled" });
    expect(confirmNotionDelivery).toHaveBeenCalledWith(id, expect.objectContaining({
      url: "https://app.notion.com/p/0123456789abcdef0123456789abcdef",
    }));
    expect(abandonNotionDelivery).toHaveBeenCalledWith(id, undefined);
  });
});
