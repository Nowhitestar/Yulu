import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../src/hostStore.js";
import {
  SharingConfiguration,
  SharingConnectorUnknownOutcomeError,
  YULU_TEST_SHARE_CONTENT,
  type SharingConnectorAdapter,
} from "../src/sharingConfiguration.js";

describe("SharingConfiguration", () => {
  let root = "";
  let host: HostStore | undefined;
  let actionNumber = 0;

  afterEach(() => {
    host?.close();
    host = undefined;
    actionNumber = 0;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-sharing-"));
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
      discover: vi.fn(),
      probe: vi.fn(),
      testShare: vi.fn(),
      verifyReceipt: vi.fn(),
    };
    return { host, adapter, sharing: new SharingConfiguration({ host, adapter }) };
  }

  function testAction(duplicateConfirmed: boolean) {
    actionNumber += 1;
    return {
      actionId: `00000000-0000-4000-8000-${String(actionNumber).padStart(12, "0")}`,
      duplicateConfirmed,
    };
  }

  it("selects one Supported Agent Connection for Sharing without implying connector or destination readiness", () => {
    const { sharing } = setup();

    expect(sharing.view()).toMatchObject({
      selection: null,
      connectorDiscovery: { status: "untested" },
      connectorReadiness: { status: "untested" },
      destination: { configured: false, value: "" },
      sharingReadiness: { status: "untested" },
    });

    expect(sharing.select({ connectionId: "codex", connector: "notion" }))
      .toMatchObject({
        selection: { connectionId: "codex", connector: "notion" },
        connectorDiscovery: { status: "untested" },
        connectorReadiness: { status: "untested" },
        destination: { configured: false, value: "" },
        sharingReadiness: { status: "untested" },
      });
  });

  it("does not offer or select Agents without a Sharing pre-tool boundary", () => {
    const { host: currentHost, sharing } = setup();
    currentHost.upsertAgentConnectionRecord({
      id: "openclaw",
      kind: "supported-agent",
      adapter: "openclaw",
      label: "OpenClaw",
      lifecycle: "available",
      settings: { executablePath: "/fake/openclaw" },
    });
    currentHost.upsertAgentConnectionRecord({
      id: "hermes",
      kind: "supported-agent",
      adapter: "hermes",
      label: "Hermes",
      lifecycle: "available",
      settings: { executablePath: "/fake/hermes" },
    });

    expect(sharing.view().connections.map((connection) => connection.id)).toEqual(["codex"]);
    expect(() => sharing.select({ connectionId: "openclaw", connector: "notion" }))
      .toThrow(/Conversation-only/);
    expect(() => sharing.select({ connectionId: "hermes", connector: "notion" }))
      .toThrow(/Conversation-only/);
  });

  it("keeps destination discovery distinct from a bounded Connector Readiness probe", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.discover).mockResolvedValue({
      options: [{ label: "Product Notes", value: "Product Notes" }],
      detail: "Found 1 Notion destination",
    });
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    sharing.select({ connectionId: "codex", connector: "notion" });

    expect(await sharing.discover()).toMatchObject({
      connectorDiscovery: {
        status: "ready",
        options: [{ label: "Product Notes", value: "Product Notes" }],
      },
      connectorReadiness: { status: "untested" },
      destination: { configured: false, value: "" },
    });

    expect(await sharing.probe()).toMatchObject({
      connectorDiscovery: { status: "ready" },
      connectorReadiness: { status: "ready", detail: "Notion read access verified" },
      destination: { configured: false, value: "" },
    });
  });

  it("gives exact remediation when the selected Agent cannot prove its pre-tool guard", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockRejectedValue(
      new Error("Sharing guard did not execute; connector operation was not authorized"),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });

    await expect(sharing.probe()).resolves.toMatchObject({
      connectorReadiness: {
        status: "failed",
        remediation: 'Run "/fake/codex features list" and update Codex until it reports "hooks stable true", then return to Settings > Sharing and test connector access again.',
      },
    });
  });

  it("keeps a proven pre-write Test Share rejection retryable with exact hook remediation", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockRejectedValue(
      new Error('Codex hooks are unavailable; update Codex until "codex features list" reports "hooks stable true"'),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: JSON.stringify({ page_id: "parent-123" }) });

    await expect(sharing.testShare(testAction(false))).resolves.toMatchObject({
      sharingReadiness: {
        status: "failed",
        remediation: 'Run "/fake/codex features list" and update Codex until it reports "hooks stable true", then return to Settings > Sharing and start a new Test Share.',
      },
    });
    await sharing.testShare(testAction(false));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);
  });

  it("never reports a suggested target as configured until it is explicitly saved and read back", async () => {
    const { adapter, host: currentHost, sharing } = setup();
    vi.mocked(adapter.discover).mockResolvedValue({
      options: [{ label: "Product Notes", value: "Product Notes" }],
      detail: "Found Product Notes",
    });
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    sharing.select({ connectionId: "codex", connector: "notion" });

    const discovered = await sharing.discover();
    expect(discovered.connectorDiscovery.options[0]).toMatchObject({ value: "Product Notes" });
    expect(discovered.destination).toEqual({ configured: false, value: "", savedAt: null });
    expect(() => sharing.saveDestination({ destination: "Product Notes" }))
      .toThrow(/Test connector access/);

    await sharing.probe();
    expect(sharing.saveDestination({ destination: "Product Notes" })).toMatchObject({
      destination: {
        configured: true,
        value: "Product Notes",
        savedAt: expect.any(String),
      },
      sharingReadiness: { status: "untested" },
    });
    expect(currentHost.getSharingConfiguration()?.destination).toBe("Product Notes");
  });

  it("establishes Sharing Readiness only from a verified meeting-free Test Share receipt", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    expect(sharing.view().sharingReadiness.status).toBe("untested");
    expect(await sharing.testShare(testAction(false))).toMatchObject({
      sharingReadiness: {
        status: "ready",
        receipt: {
          id: "page-123",
          url: "https://notion.so/page-123",
          verifiedAt: expect.any(String),
        },
      },
    });
    expect(adapter.testShare).toHaveBeenCalledWith(expect.objectContaining({
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
    }));
    expect(adapter.verifyReceipt).toHaveBeenCalledWith(expect.objectContaining({
      connector: "notion",
      destination: "Product Notes",
      content: YULU_TEST_SHARE_CONTENT,
      receipt: expect.objectContaining({ receiptId: "page-123" }),
    }));
    expect(YULU_TEST_SHARE_CONTENT).toBe(
      "Yulu Test Share — connection verification only. This message contains no meeting content.",
    );
  });

  it("fences an unverifiable receipt as Unknown Outcome until the user abandons it", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-unknown",
      receiptUrl: "https://notion.so/page-unknown",
    });
    vi.mocked(adapter.verifyReceipt).mockRejectedValue(
      new SharingConnectorUnknownOutcomeError("receipt read-back timed out"),
    );
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    const unknown = await sharing.testShare(testAction(false));
    expect(unknown).toMatchObject({
      sharingReadiness: {
        status: "unknown",
        receipt: null,
        actionId: expect.any(String),
        remediation: expect.stringMatching(/Do not retry.*reconcile or abandon/i),
      },
    });
    await expect(sharing.testShare(testAction(true))).rejects.toThrow(/Unknown Outcome/);
    expect(adapter.testShare).toHaveBeenCalledTimes(1);

    sharing.abandonUnknown({ actionId: unknown.sharingReadiness.actionId! });
    expect(sharing.view().sharingReadiness.status).toBe("untested");
    await sharing.testShare(testAction(false));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);
  });

  it("requires duplicate confirmation after a verified Test Share and can reconcile an Unknown Outcome", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });

    await sharing.testShare(testAction(false));
    await expect(sharing.testShare(testAction(false))).rejects.toThrow(/duplicate/i);
    expect(adapter.testShare).toHaveBeenCalledTimes(1);
    await sharing.testShare(testAction(true));
    expect(adapter.testShare).toHaveBeenCalledTimes(2);

    vi.mocked(adapter.verifyReceipt).mockRejectedValueOnce(
      new SharingConnectorUnknownOutcomeError("read-back interrupted"),
    );
    const unknown = await sharing.testShare(testAction(true));
    vi.mocked(adapter.verifyReceipt).mockResolvedValueOnce({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    await expect(sharing.reconcileUnknown({
      actionId: unknown.sharingReadiness.actionId!,
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    })).resolves.toMatchObject({ sharingReadiness: { status: "ready" } });
  });

  it("requires a current Connector Readiness proof after a process restart", async () => {
    const { adapter, host: currentHost, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    await sharing.testShare(testAction(false));

    const restarted = new SharingConfiguration({ host: currentHost, adapter });
    expect(restarted.view()).toMatchObject({
      connectorReadiness: { status: "untested" },
      sharingReadiness: { status: "untested", duplicateWarningRequired: true },
    });
    expect(await restarted.probe()).toMatchObject({
      connectorReadiness: { status: "ready" },
      sharingReadiness: { status: "ready" },
    });
    vi.mocked(adapter.probe).mockRejectedValueOnce(new Error("Notion OAuth expired"));
    expect(await restarted.probe()).toMatchObject({
      connectorReadiness: { status: "failed" },
      sharingReadiness: { status: "failed", receipt: null },
    });
  });

  it("replays one client action id without creating another external write", async () => {
    const { adapter, sharing } = setup();
    vi.mocked(adapter.probe).mockResolvedValue({ detail: "Notion read access verified" });
    vi.mocked(adapter.testShare).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    vi.mocked(adapter.verifyReceipt).mockResolvedValue({
      destination: "Product Notes",
      receiptId: "page-123",
      receiptUrl: "https://notion.so/page-123",
    });
    sharing.select({ connectionId: "codex", connector: "notion" });
    await sharing.probe();
    sharing.saveDestination({ destination: "Product Notes" });
    const input = {
      actionId: "00000000-0000-4000-8000-000000000001",
      duplicateConfirmed: true,
    };

    await sharing.testShare(input);
    await sharing.testShare(input);

    expect(adapter.testShare).toHaveBeenCalledTimes(1);
    expect(adapter.verifyReceipt).toHaveBeenCalledTimes(1);
  });
});
