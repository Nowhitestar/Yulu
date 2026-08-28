import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../../src/hostStore.js";
import { SharingConfiguration, type SharingConnectorAdapter } from "../../src/sharingConfiguration.js";
import { sharingRouter } from "../../src/routers/sharing.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

describe("sharingRouter", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-sharing-router-"));
    host = new HostStore(join(root, "host.sqlite"));
    host.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    const adapter: SharingConnectorAdapter = {
      discover: vi.fn(async () => ({
        options: [{ label: "Product Notes", value: "Product Notes" }],
        detail: "Found Product Notes",
      })),
      probe: vi.fn(async () => ({ detail: "Notion read access verified" })),
      testShare: vi.fn(async () => ({
        destination: "Product Notes",
        receiptId: "page-123",
        receiptUrl: "https://notion.so/page-123",
      })),
      share: vi.fn(),
      verifyReceipt: vi.fn(async () => ({
        destination: "Product Notes",
        receiptId: "page-123",
        receiptUrl: "https://notion.so/page-123",
      })),
    };
    const providerSelections = {
      summary: { provider: "xai", model: "grok-4.6" },
      conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" },
    };
    const ctx = {
      uiMutationAuthorized: true,
      host,
      sharing: new SharingConfiguration({ host, adapter }),
      config: { read: () => ({ intelligence: providerSelections }) },
    } as unknown as AppContext;
    return { adapter, caller: createCaller(sharingRouter, ctx), providerSelections };
  }

  it("runs the complete explicit Sharing configuration journey without changing providers", async () => {
    const { adapter, caller, providerSelections } = setup();
    const before = JSON.stringify(providerSelections);

    await caller.select({ connectionId: "codex", connector: "notion" });
    await caller.discover();
    await caller.probe();
    await caller.saveDestination({ destination: "Product Notes" });
    const input = {
      confirmed: true,
      actionId: "00000000-0000-4000-8000-000000000001",
      duplicateConfirmed: false,
    } as const;
    const result = await caller.testShare(input);
    await caller.testShare(input);

    expect(result).toMatchObject({
      connectorDiscovery: { status: "ready" },
      connectorReadiness: { status: "ready" },
      destination: { configured: true, value: "Product Notes" },
      sharingReadiness: { status: "ready" },
    });
    expect(adapter.testShare).toHaveBeenCalledTimes(1);
    expect(adapter.verifyReceipt).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(providerSelections)).toBe(before);
  });

  it("rejects a Test Share without a fresh explicit confirmation", async () => {
    const { adapter, caller } = setup();
    await caller.select({ connectionId: "codex", connector: "notion" });
    await caller.probe();
    await caller.saveDestination({ destination: "Product Notes" });

    await expect(caller.testShare({
      confirmed: false,
      actionId: "00000000-0000-4000-8000-000000000001",
      duplicateConfirmed: false,
    })).rejects.toThrow();
    expect(adapter.testShare).not.toHaveBeenCalled();
  });

  it("returns exact connector remediation on failure without changing providers", async () => {
    const { adapter, caller, providerSelections } = setup();
    const before = JSON.stringify(providerSelections);
    vi.mocked(adapter.probe).mockRejectedValueOnce(new Error("Notion OAuth expired"));

    await caller.select({ connectionId: "codex", connector: "notion" });
    const result = await caller.probe();

    expect(result.connectorReadiness).toMatchObject({
      status: "failed",
      detail: "Notion OAuth expired",
      remediation: "Open Codex's notion connector authorization and reauthorize its account, then return to Settings > Sharing and test connector access again.",
    });
    expect(JSON.stringify(providerSelections)).toBe(before);
  });
});
